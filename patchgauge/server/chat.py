"""对话式入口（个人实用化 B 计划第一期）：聊天编排层，覆盖在 ReviewManager 之上。

定位与红线：
- 对话层只做**编排与解释**：意图路由、计划确认卡、进度、结果卡与补测指令；
- 一切承重/无据/游离结论只从审查回执（review_bundle.json）渲染，模型不参与签发；
- 确认永远显式（计划卡按钮），不因在对话里就省略；
- 不引入 WebSocket / 数据库：会话是逐条追加的 JSONL 文件账本，
  位于 `<reviews_root>/_chat/<conversation_id>.jsonl`，与 _leases/_tasks 同一纪律。
"""
from __future__ import annotations

import json
import re
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

from fastapi import Request

from patchgauge.agent.review import TERMINAL
from patchgauge.check import (EXIT_MEANINGS, bundle_lines, collect_changes,
                         collect_trend, exit_code_from, find_valid_authorization,
                         group_ranges, history_root, retest_instructions_md,
                         slug_for)
from patchgauge.safe_git import run_git
from patchgauge.server.control import IntakeError, _repo_snapshot

SCHEMA_VERSION = "patchgauge-chat-v1"
TERMINAL_VALUES = {s.value for s in TERMINAL}
DEFAULT_BUDGET = 300
POLL_INTERVAL = 1.0
WATCH_INTERVAL = 5.0

HELP_TEXT = (
    "我是PatchGauge的对话入口，帮你用一句话完成测试证据检查。可以对我说：\n"
    "- **检查**（或「检查 retry_demo」）：对仓库当前改动发起审查，我会先给计划卡，你确认后实验开始\n"
    "- **补测指令**：把上次结果的「给 AI 的补测指令」再发一遍，直接贴给你的编程智能体\n"
    "- **历史**：看这个会话里做过的检查\n"
    "- **盯着 retry_demo**：仓库一有新改动我就提醒你，可一键检查\n"
    "- **登记仓库 /path/to/repo**：把一个本地 Git 仓库加入白名单\n"
    "结论只来自反事实实验回执：承重=移除后有具名测试失败；无据=没有；我不会凭聊天判断代码。\n"
    "已配置模型服务时，也可以直接用自然语言对我说话（口语即可，我会识别意图）。"
)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


CHAT_SYSTEM_PROMPT = (
    "你是PatchGauge的对话助手，帮用户完成测试证据检查。铁律：\n"
    "1. 只基于输入事实回答；绝不承诺代码正确、安全或可合并。\n"
    "2. 承重/无据/游离结论只能来自输入里的 last_result（实验回执），不得自行推断或改写。\n"
    "3. 用户想做动作时输出意图，不编造结果。\n"
    "严格返回一个 JSON 对象：{\"intent\": \"check|retest|history|watch_on|watch_off|register|help|chat\", "
    "\"repo_hint\": \"登记仓库名或技术名子串，可空\", \"path\": \"register 意图时的仓库绝对路径，可空\", "
    "\"reply\": \"intent=chat 时给用户的中文回复，其余可空\"}\n"
    "reply 要求：中文、不超过 120 字、口语自然；可以解释 last_result 的数字并建议下一步；"
    "没有事实支撑的问题如实说不知道，并建议跑一次检查。"
)

MODEL_INTENTS = frozenset({"check", "retest", "history", "watch_on", "watch_off",
                           "register", "help", "chat"})


def _default_provider_factory():
    """从启动器选中的模型服务懒装配对话 provider；取不到就退确定性路由。"""
    try:
        from patchgauge.agent.provider import OpenAICompatibleProvider
        from patchgauge.mcp.credentials import selected_provider
        info = selected_provider()
        if not info:
            return None
        return OpenAICompatibleProvider(
            base_url=info["base_url"], api_key=info["api_key"],
            model_id=info["model_id"], max_tokens=900,
            max_total_tokens=60000, max_requests=300)
    except Exception:                        # noqa: BLE001 — 模型缺席不是错误
        return None


class ChatError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code, self.message = code, message


class ChatService:
    """会话账本 + 确定性意图路由 + 审查编排。线程安全：每会话一把锁。"""

    def __init__(self, manager, *, watch_interval: float = WATCH_INTERVAL,
                 provider_factory=None):
        self.manager = manager
        self._provider_factory = provider_factory
        self._provider = None
        self.root = manager.root / "_chat"
        self.root.mkdir(parents=True, exist_ok=True)
        self._locks: dict[str, threading.Lock] = {}
        self._guard = threading.Lock()
        self._pending: dict[str, dict] = {}          # conv_id -> {action_id: action}
        self._watch: dict[str, dict] = {}            # repo_id -> state
        self._watch_interval = watch_interval
        self._watch_thread: threading.Thread | None = None

    # ------------------------------------------------------------ 账本基础

    def _lock(self, conv_id: str) -> threading.Lock:
        with self._guard:
            if conv_id not in self._locks:
                self._locks[conv_id] = threading.Lock()
            return self._locks[conv_id]

    def _path(self, conv_id: str) -> Path:
        if not re.fullmatch(r"chat-[a-f0-9]{24}", conv_id):
            raise ChatError("CONVERSATION_INVALID", "会话 id 不合法")
        return self.root / f"{conv_id}.jsonl"

    def _read_all(self, conv_id: str) -> list[dict]:
        path = self._path(conv_id)
        if not path.exists():
            raise ChatError("CONVERSATION_NOT_FOUND", "会话不存在")
        rows = []
        for line in path.read_text(encoding="utf-8").splitlines():
            if line.strip():
                rows.append(json.loads(line))
        return rows

    def _append(self, conv_id: str, *rows: dict, user_facing: bool = True) -> list[dict]:
        with self._lock(conv_id):
            path = self._path(conv_id)
            existing = 0
            if path.exists():
                existing = sum(1 for line in path.read_text(encoding="utf-8").splitlines()
                               if line.strip())
            out = []
            with path.open("a", encoding="utf-8") as handle:
                for payload in rows:
                    event = {"seq": existing + len(out) + 1, "at": _now(),
                             "schema_version": SCHEMA_VERSION, **payload}
                    handle.write(json.dumps(event, ensure_ascii=False) + "\n")
                    out.append(event)
            return out

    # ------------------------------------------------------------ 公共 API

    def new_conversation(self) -> dict:
        conv_id = f"chat-{uuid.uuid4().hex[:24]}"
        self._append(conv_id, {
            "kind": "assistant.text",
            "text": "你好，这里是PatchGauge对话入口。" + HELP_TEXT})
        return {"conversation_id": conv_id, "schema_version": SCHEMA_VERSION}

    def list_conversations(self) -> dict:
        out = []
        for path in sorted(self.root.glob("chat-*.jsonl")):
            conv_id = path.stem
            first_user, count, updated = "", 0, ""
            for line in path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                row = json.loads(line)
                count += 1
                updated = row.get("at") or updated
                if not first_user and row.get("kind") == "user.text":
                    first_user = str(row.get("text") or "")[:40]
            out.append({"conversation_id": conv_id, "title": first_user or "新会话",
                        "events": count, "updated_at": updated})
        out.sort(key=lambda item: item["updated_at"], reverse=True)
        return {"conversations": out, "schema_version": SCHEMA_VERSION}

    def events(self, conv_id: str, after: int = 0) -> dict:
        rows = [row for row in self._read_all(conv_id) if int(row.get("seq") or 0) > after]
        return {"events": rows, "schema_version": SCHEMA_VERSION}

    def send(self, conv_id: str, text: str) -> dict:
        if not isinstance(text, str) or not text.strip():
            raise ChatError("MESSAGE_INVALID", "消息不能为空")
        user_rows = self._append(conv_id, {"kind": "user.text", "text": text.strip()})
        reply = self._route(conv_id, text.strip())
        rows = self._append(conv_id, *reply) if reply else []
        return {"events": user_rows + rows, "schema_version": SCHEMA_VERSION}

    def act(self, conv_id: str, action_id: str, decision: str) -> dict:
        if decision not in {"approve", "decline"}:
            raise ChatError("ACTION_INVALID", "decision 只接受 approve/decline")
        with self._lock(conv_id):
            action = self._pending.get(conv_id, {}).pop(action_id, None)
        if action is None:
            raise ChatError("ACTION_NOT_FOUND",
                            "确认已失效（服务重启或已处理），请重新发起检查")
        if decision == "decline":
            rows = self._append(conv_id, {
                "kind": "card.notice", "level": "info",
                "text": f"已取消检查 {action['review_id']}，审查停留在待批准，未执行任何实验。"})
            return {"events": rows, "schema_version": SCHEMA_VERSION}
        try:
            self.manager.approve(action["review_id"], action["plan_sha256"])
        except IntakeError as exc:
            hint = ("仓库在计划起草后发生了变化（快照漂移），请重新发起检查"
                    if exc.code in {"STALE_APPROVAL", "STALE_PLAN"}
                    else f"审查当前状态不允许批准（{exc.code}）")
            rows = self._append(conv_id, {
                "kind": "card.notice", "level": "warn", "text": hint})
            return {"events": rows, "schema_version": SCHEMA_VERSION}
        rows = self._append(conv_id, {
            "kind": "assistant.text",
            "text": f"已确认计划，实验开始（预算 {action['budget']} 秒）。我会逐步汇报进度，完成后给出三态结论。"})
        self._spawn_progress(conv_id, action["review_id"], action["repo_path"],
                             action["tests"])
        return {"events": rows, "schema_version": SCHEMA_VERSION}

    # ------------------------------------------------------------ 意图路由

    def _route(self, conv_id: str, text: str) -> list[dict]:
        t = text.lower()
        if any(key in t for key in ("帮助", "help", "你能做什么", "？", "?")) and "检查" not in t:
            return [{"kind": "assistant.text", "text": HELP_TEXT}]

        register = re.search(r"(?:登记仓库|添加仓库|注册仓库)\s*(\S+)", text)
        if register:
            return self._register_repo(conv_id, register.group(1))

        if any(key in t for key in ("停止盯", "别盯", "取消盯", "watch off", "stop watch")):
            return self._watch_toggle(conv_id, "", enable=False)
        watch = re.search(r"(?:盯着|盯住|监视|watch)\s*(\S*)", text)
        if watch and not t.startswith("检查"):
            return self._watch_toggle(conv_id, watch.group(1), enable=True)

        if any(key in t for key in ("补测", "补测试", "补测指令")):
            return self._retest(conv_id)

        if any(key in t for key in ("历史", "上次", "最近", "上一个")) and "趋势" not in t:
            return self._history(conv_id)

        if "趋势" in t or "trend" in t:
            return self._trend(conv_id)

        if any(key in t for key in ("检查", "查一下", "查一下", "check", "审查")):
            return self._check(conv_id, text)

        model_rows = self._model_route(conv_id, text)
        if model_rows is not None:
            return model_rows
        return [{"kind": "assistant.text", "via": "deterministic",
                 "text": "这句我还没接上实验。目前我只会这些：" + HELP_TEXT}]

    # ------------------------------------------------------------ 模型路由

    def _get_provider(self):
        if self._provider is None:
            self._provider = self._provider_factory() if self._provider_factory \
                else _default_provider_factory()
        return self._provider

    def _last_result_summary(self, conv_id: str) -> dict:
        for row in reversed(self._read_all(conv_id)):
            if row.get("kind") == "card.result":
                return {"review_id": row.get("review_id"), "state": row.get("state"),
                        "exit_code": row.get("exit_code"),
                        "exit_meaning": row.get("exit_meaning"),
                        "by_label": row.get("by_label"),
                        "restore_state": row.get("restore_state"),
                        "items": (row.get("items") or [])[:8]}
        return {}

    def _model_route(self, conv_id: str, text: str):
        """确定性路由未命中时的模型兜底：分类到封闭意图集，或给出接地回复。

        模型只挑选意图与措辞；执行仍走确定性处理器，结论仍只来自回执。
        模型缺席/失败一律回退确定性文案，绝不静默编造。
        """
        provider = self._get_provider()
        if provider is None:
            return None
        prompt = {"text": text, "repos": self._repos_payload(),
                  "last_result": self._last_result_summary(conv_id)}
        try:
            raw = provider.chat_request(system=CHAT_SYSTEM_PROMPT, prompt=prompt)
        except Exception as exc:              # noqa: BLE001 — 失败回退，不中断对话
            return [{"kind": "assistant.text", "via": "deterministic",
                     "text": f"模型通道这次没接上（{type(exc).__name__}），先用确定性路由。"
                             "可以对我说：" + HELP_TEXT}]
        if not isinstance(raw, dict):
            return None
        intent = str(raw.get("intent") or "chat")
        if intent not in MODEL_INTENTS:
            return None
        repo_hint = str(raw.get("repo_hint") or "").strip()
        if intent == "check":
            return self._check(conv_id, f"检查 {repo_hint}".strip())
        if intent == "retest":
            return self._retest(conv_id)
        if intent == "history":
            return self._history(conv_id)
        if intent == "watch_on":
            return self._watch_toggle(conv_id, repo_hint, enable=True)
        if intent == "watch_off":
            return self._watch_toggle(conv_id, "", enable=False)
        if intent == "register":
            path = str(raw.get("path") or "").strip()
            if not path:
                return [{"kind": "assistant.text", "via": "model",
                         "text": "登记仓库需要本地 Git 仓库根目录的绝对路径，发我一下。"}]
            return self._register_repo(conv_id, path)
        if intent == "help":
            return [{"kind": "assistant.text", "via": "model", "text": HELP_TEXT}]
        reply = str(raw.get("reply") or "").strip()
        if not reply:
            return None
        return [{"kind": "assistant.text", "via": f"model:{provider.info.model_id}",
                 "text": reply}]

    def _resolve_repo(self, text: str):
        repos = list(self.manager.registry.registered())
        if not repos:
            return None, [{"kind": "assistant.text",
                           "text": "当前没有登记任何仓库。对我说\"登记仓库 /绝对路径\"（本地 Git 仓库根目录）,"
                                   " 或用启动器的 --allow-repo 登记后再来。"}]
        name_hint = ""
        for repo in repos:
            for token in (repo.technical_name or "", repo.display_name or ""):
                if token and token.lower() in text.lower():
                    name_hint = repo.repo_id
                    break
        if name_hint:
            return next(r for r in repos if r.repo_id == name_hint), None
        if len(repos) == 1:
            return repos[0], None
        return None, [{"kind": "card.repos", "repos": self._repos_payload(),
                       "text": "登记了多个仓库，请指明要检查哪一个（点下面或直接说\"检查 xxx\"）。"}]

    def _repos_payload(self) -> list[dict]:
        return [{"repo_id": r.repo_id, "display_name": r.display_name,
                 "technical_name": r.technical_name} for r in
                self.manager.registry.registered()]

    def _register_repo(self, conv_id: str, raw_path: str) -> list[dict]:
        try:
            repo = self.manager.registry.add(raw_path)
        except IntakeError as exc:
            return [{"kind": "card.notice", "level": "warn",
                     "text": f"登记失败（{exc.code}）：{exc}。需要本地 Git 仓库根目录的绝对路径。"}]
        return [
            {"kind": "assistant.text",
             "text": f"已登记仓库 {repo.display_name}（{repo.path}）。注意：登记表示你信任在该仓库运行测试。"},
            {"kind": "card.repos", "repos": self._repos_payload()},
        ]

    def _check(self, conv_id: str, text: str) -> list[dict]:
        repo, redirect = self._resolve_repo(text)
        if repo is None:
            return redirect
        snapshot = _repo_snapshot(repo.path)
        changes = collect_changes(repo.path)
        if not changes["raw"]:
            return [{"kind": "card.notice", "level": "info",
                     "text": f"{repo.display_name} 对 HEAD 无任何差异（含未跟踪文件），没有可检查的增量。"}]
        payload = {
            "instruction": "对话入口：验证当前工作区对 HEAD 的增量是否受到声明测试的约束",
            "source": {"kind": "local", "repo_id": repo.repo_id},
            "constraints": {"budget_seconds": DEFAULT_BUDGET},
        }
        try:
            created = self.manager.create_v2(payload)
        except IntakeError as exc:
            hint = ("仓库里没找到 Python 测试文件，先补测试或用 CLI 指定 --tests"
                    if exc.code == "TEST_DISCOVERY_EMPTY" else str(exc))
            return [{"kind": "card.notice", "level": "warn",
                     "text": f"无法创建审查（{exc.code}）：{hint}"}]
        review_id = created["review_id"]
        plan_sha256 = (created.get("plan") or {}).get("plan_sha256") or ""
        tests = [str(x) for x in ((created.get("request") or {}).get("test_files") or [])]
        base_card = {
            "kind": "card.plan", "review_id": review_id,
            "plan_sha256": plan_sha256, "repo": repo.display_name,
            "repo_id": repo.repo_id, "tests": tests, "budget": DEFAULT_BUDGET,
            "head": snapshot.get("head", ""), "snapshot_sha256": snapshot.get("snapshot_sha256", ""),
            "changes": {"tracked": len(changes["modified"]) + len(changes["deleted"]),
                        "untracked": len(changes["untracked"]),
                        "renamed": len(changes["renamed"]),
                        "binary": len(changes["binary"])},
        }
        # 对话入口的检查计划＝仓库注册解释器＋自动发现的 pytest 全集；
        # 只有与该计划一致（解释器/测试范围都匹配）的预授权才免确认。
        auth_row = find_valid_authorization(repo.path, DEFAULT_BUDGET,
                                            python=Path(repo.python), tests=[])
        if auth_row is not None:
            # 只读预授权（用户终端显式签发、可撤销）：免逐次确认直接开始；
            # 快照漂移仍由 approve 的 STALE_APPROVAL 兜底，授权使用随卡留痕。
            try:
                self.manager.approve(review_id, plan_sha256)
            except IntakeError as exc:
                hint = ("仓库在计划起草后发生了变化（快照漂移），请重新发起检查"
                        if exc.code in {"STALE_APPROVAL", "STALE_PLAN"}
                        else f"审查当前状态不允许批准（{exc.code}）")
                return [dict(base_card, status="pending", action_id="",
                             text="检查计划如下，确认后才会开始实验："),
                        {"kind": "card.notice", "level": "warn", "text": hint}]
            self._spawn_progress(conv_id, review_id, repo.path, tests)
            return [dict(base_card, status="preauthorized",
                         authorization={"auth_id": auth_row["auth_id"],
                                        "valid_until": auth_row["valid_until"]},
                         text=f"按只读预授权 {auth_row['auth_id']} 自动确认，实验已开始"
                              f"（≤{auth_row['budget_seconds_max']}s/次；撤销：patchgauge check --auth-revoke {auth_row['auth_id']}）。")]
        action_id = f"act-{uuid.uuid4().hex[:8]}"
        with self._lock(conv_id):
            self._pending.setdefault(conv_id, {})[action_id] = {
                "action_id": action_id, "review_id": review_id,
                "plan_sha256": plan_sha256, "repo_path": repo.path,
                "tests": tests, "budget": DEFAULT_BUDGET, "at": _now()}
        return [dict(base_card, action_id=action_id, status="pending",
                     text="检查计划如下，确认后才会开始实验（确认前一行代码都不会执行）：")]

    def _retest(self, conv_id: str) -> list[dict]:
        for row in reversed(self._read_all(conv_id)):
            if row.get("kind") == "card.result" and row.get("retest_md"):
                return [{"kind": "assistant.text",
                         "text": f"上次检查（{row.get('review_id')}）的补测指令：\n\n"
                                 + str(row["retest_md"])}]
        return [{"kind": "assistant.text",
                 "text": "这个会话里还没有检查结果。先说\"检查\"跑一次，有\"无据/游离\"结论后我再给你补测指令。"}]

    def _history(self, conv_id: str) -> list[dict]:
        entries = []
        for row in self._read_all(conv_id):
            if row.get("kind") == "card.result":
                by_label = row.get("by_label") or {}
                entries.append({
                    "review_id": row.get("review_id"), "at": row.get("at"),
                    "state": row.get("state"),
                    "exit_code": row.get("exit_code"),
                    "承重": by_label.get("承重", 0), "无据": by_label.get("无据", 0),
                    "游离": by_label.get("游离", 0)})
        if not entries:
            return [{"kind": "assistant.text", "text": "这个会话里还没有做过检查。说\"检查\"开始第一次。"}]
        return [{"kind": "card.history", "entries": list(reversed(entries))}]

    def _trend(self, conv_id: str) -> list[dict]:
        trend = collect_trend()
        repos = trend.get("repos") or {}
        if not repos:
            return [{"kind": "assistant.text",
                     "text": "还没有任何检查历史。先说「检查」跑一次，之后就能看承重率趋势了。"}]
        cards = []
        for repo, rows in sorted(repos.items()):
            cards.append({"kind": "card.trend", "repo": repo, "entries": rows})
        return cards[:4] + ([{"kind": "card.notice", "level": "info",
                              "text": f"共 {len(repos)} 个仓库有历史，仅展示前 4 个。"}]
                            if len(repos) > 4 else [])

    # ------------------------------------------------------------ watch

    def _watch_toggle(self, conv_id: str, name_hint: str, *, enable: bool) -> list[dict]:
        if enable:
            repo, redirect = self._resolve_repo(name_hint or "")
            if repo is None and redirect and any(r.get("kind") == "card.repos" for r in redirect):
                return redirect
            if repo is None:
                return redirect
            snapshot = _repo_snapshot(repo.path).get("snapshot_sha256") or ""
            with self._guard:
                state = self._watch.setdefault(repo.repo_id, {
                    "repo_id": repo.repo_id, "display_name": repo.display_name,
                    "path": str(repo.path), "last": snapshot, "convs": set()})
                state["convs"].add(conv_id)
            self._ensure_watch_thread()
            return [{"kind": "card.watch", "repo": repo.display_name,
                     "repo_id": repo.repo_id, "on": True,
                     "text": f"开始盯 {repo.display_name}：每 {WATCH_INTERVAL:.0f} 秒看一次工作区快照，有新改动我会在这里提醒你。"}]
        with self._guard:
            for state in self._watch.values():
                state["convs"].discard(conv_id)
        return [{"kind": "card.watch", "repo": "", "repo_id": "", "on": False,
                 "text": "已停止所有盯守。"}]

    def _ensure_watch_thread(self) -> None:
        with self._guard:
            if self._watch_thread and self._watch_thread.is_alive():
                return
            self._watch_thread = threading.Thread(
                target=self._watch_loop, name="patchgauge-chat-watch", daemon=True)
            self._watch_thread.start()

    def _watch_loop(self) -> None:
        while True:
            time.sleep(self._watch_interval)
            with self._guard:
                targets = [(repo_id, dict(state), set(state["convs"]))
                           for repo_id, state in self._watch.items() if state["convs"]]
            for repo_id, state, convs in targets:
                try:
                    current = _repo_snapshot(Path(state["path"])).get("snapshot_sha256") or ""
                except Exception:
                    continue
                if not current or current == state["last"]:
                    continue
                with self._guard:
                    if repo_id in self._watch:
                        self._watch[repo_id]["last"] = current
                    targets_convs = set(self._watch.get(repo_id, {}).get("convs") or set())
                for conv_id in convs & targets_convs:
                    self._append(conv_id, {
                        "kind": "card.watch_notice", "repo": state["display_name"],
                        "repo_id": repo_id,
                        "text": f"{state['display_name']} 有新改动。对我说\"检查 {state['display_name']}\"或点下方按钮一键检查。"})

    # ------------------------------------------------------------ 进度与结果

    def _spawn_progress(self, conv_id: str, review_id: str,
                        repo_path: Path, tests: list[str]) -> None:
        thread = threading.Thread(target=self._progress_loop,
                                  args=(conv_id, review_id, repo_path, tests),
                                  name=f"patchgauge-chat-{review_id[:8]}", daemon=True)
        thread.start()

    def _progress_loop(self, conv_id: str, review_id: str,
                       repo_path: Path, tests: list[str]) -> None:
        last_status, deadline = "", time.monotonic() + DEFAULT_BUDGET + 900
        while time.monotonic() < deadline:
            try:
                describe = self.manager.describe(review_id)
            except Exception:
                return
            status = str((describe.get("state") or {}).get("status") or "")
            if status and status != last_status and status in TERMINAL_VALUES:
                self._append(conv_id, {"kind": "card.progress",
                                       "review_id": review_id, "status": status})
                break
            if status and status != last_status:
                self._append(conv_id, {"kind": "card.progress",
                                       "review_id": review_id, "status": status})
                last_status = status
            time.sleep(POLL_INTERVAL)
        self._emit_result(conv_id, review_id, repo_path, tests)

    def _emit_result(self, conv_id: str, review_id: str,
                     repo_path: Path, tests: list[str]) -> None:
        try:
            bundle_path = self.manager.review_bundle_path(review_id)
            bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
            describe = self.manager.describe(review_id)
        except Exception as exc:
            self._append(conv_id, {"kind": "card.notice", "level": "warn",
                                   "text": f"审查 {review_id} 已结束但证据包不可读：{exc}"})
            return
        status = str((describe.get("state") or {}).get("status") or "")
        exit_code = exit_code_from(status, bundle)
        lines = bundle_lines(bundle)
        summary = ((bundle.get("evidence_bundle") or {}).get("report") or {}).get("summary") or {}
        items = []
        for row in lines:
            label = str(row.get("label") or "")
            if label in {"承重", "无据", "游离"}:
                items.append({"label": label, "file": str(row.get("file") or "?"),
                              "line": int(row.get("line") or 0)})
        grouped = []
        for (label, file) in sorted({(i["label"], i["file"]) for i in items}):
            numbers = [i["line"] for i in items if i["label"] == label and i["file"] == file]
            grouped.append({"label": label, "file": file,
                            "ranges": [[a, b] for a, b in group_ranges(numbers)]})
        result_stub = {"review_id": review_id, "state": status, "exit_code": exit_code,
                       "summary": summary,
                       "restore_state": bundle.get("restore_state") or {}}
        retest_md = retest_instructions_md(result_stub, lines, tests, repo_path)
        try:
            out_dir = history_root() / slug_for(repo_path) / review_id
            out_dir.mkdir(parents=True, exist_ok=True)
            report_path = str(out_dir / "report.md")
        except OSError:
            report_path = ""
        self._append(conv_id, {
            "kind": "card.result", "review_id": review_id, "state": status,
            "exit_code": exit_code, "exit_meaning": EXIT_MEANINGS[exit_code],
            "by_label": summary.get("by_label") or {},
            "by_reason": summary.get("by_reason") or {},
            "restore_state": bundle.get("restore_state") or {},
            "items": grouped, "retest_md": retest_md, "report_path": report_path,
            "text": "实验完成。结论来自回执，不是聊天判断："})


def register_chat_routes(app, service: ChatService) -> None:
    """把对话端点接到既有 FastAPI 应用上（自动落入 Bearer+Origin 中间件边界）。

    注意：本模块启用了 `from __future__ import annotations`，注解以字符串形式
    存在，FastAPI 会在模块 globals 里解析它们——`Request` 必须是模块级导入，
    放进函数闭包会被当作普通 query 参数（422）。
    """

    @app.post("/api/v2/chat/conversations", status_code=201)
    async def chat_new_conversation():
        return service.new_conversation()

    @app.get("/api/v2/chat/conversations")
    async def chat_list_conversations():
        return service.list_conversations()

    @app.get("/api/v2/chat/conversations/{conversation_id}/events")
    async def chat_events(conversation_id: str, after: int = 0):
        return service.events(conversation_id, after)

    @app.post("/api/v2/chat/conversations/{conversation_id}/messages")
    async def chat_send(conversation_id: str, request: Request):
        raw = await request.json()
        if not isinstance(raw, dict) or set(raw) != {"text"}:
            raise IntakeError("CHAT_MESSAGE_INVALID", "body 只需要 {\"text\": ...}")
        return service.send(conversation_id, str(raw["text"]))

    @app.post("/api/v2/chat/conversations/{conversation_id}/actions")
    async def chat_action(conversation_id: str, request: Request):
        raw = await request.json()
        if not isinstance(raw, dict) or set(raw) != {"action_id", "decision"}:
            raise IntakeError("CHAT_ACTION_INVALID",
                              "body 只需要 {\"action_id\", \"decision\"}")
        return service.act(conversation_id, str(raw["action_id"]), str(raw["decision"]))
