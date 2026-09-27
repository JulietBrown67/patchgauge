"""patchgauge check——一条命令的单次测试证据检查（个人实用化 P1-1～P1-4）。

进程内直跑一次审查：构造 ReviewManager → create_v2 → 终端一次确认 →
approve（含 STALE_APPROVAL 快照复查）→ 轮询终态 → 汇总输出与报告归档。

边界（对应总计划 P1）：
- 不自动启动后台服务；与网页服务互不共享 reviews 根（默认独立目录）；
- 不改用户工作树与 index；隔离实验走既有 ~/.patchgauge/scratch worktree 机制；
- 首次登记与批准合并为同一次终端确认；非交互环境无预授权则失败关闭；
- 退出码互斥分级（见 EXIT_MEANINGS），具名结论以审查回执为准；
- 标准模式零模型：模型可以缺席，实验与恢复照常。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import shlex
import subprocess
import sys
import time
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

from patchgauge.agent.review import TERMINAL
from patchgauge.capabilities import CapabilityError
from patchgauge.env import get as env_get
from patchgauge.safe_git import run_git
from patchgauge.server import RepoRegistry, ReviewManager
from patchgauge.server.control import IntakeError, _repo_snapshot

SCHEMA_VERSION = "patchgauge-check-v1"
TRUSTED_SCHEMA = "patchgauge-check-trusted-v1"
# v2：授权绑定解释器与测试范围（v1 只绑仓库/期限/预算，命中判断与实际
# 执行计划不一致——换了 --repo-python 或 --tests 的检查也能蹭旧授权）。
# v1 文件按 schema 校验自然失效，重签即可。
AUTH_SCHEMA = "patchgauge-check-authorization-v2"
AUTH_ACTIONS = ("read_only_check",)   # 预授权只放行只读检查；采用/交付/写入永不授权

EXIT_OK = 0
EXIT_ITEMS = 2          # 检查完整，存在无据/游离等需处理项
EXIT_ERROR = 3          # 参数/环境/授权/取消/超预算/恢复异常
EXIT_NO_CHANGES = 4     # 确认无差异，不是验收通过
EXIT_INSUFFICIENT = 5   # 执行结束但证据不足或范围不完整

EXIT_MEANINGS = {
    EXIT_OK: "检查完整、恢复干净且没有需处理项（仅代表本次检查状态，不代表正确性或可合并）",
    EXIT_ITEMS: "声明范围检查完整，存在无据/游离等需处理项",
    EXIT_INSUFFICIENT: "执行结束但无足够证据或范围不完整，不得冒充无据或完整三态",
    EXIT_NO_CHANGES: "输入有效且确认无差异（no_changes），不是验收通过",
    EXIT_ERROR: "参数/环境/授权/基线/恢复异常，或取消、超预算等执行未完整结束",
}

#: 未标注原因里属于"证据缺口"的：本轮没有完成对行的检查（区别于引擎已
#: 完整记账的正常豁免——non_executable/inert_withheld/unsupported_file/
#: not_isolated/no_valid_transform 等在 complete 运行里是确定性判定，
#: 不冒充缺口；恢复类异常由 restore_state 走退出码 3）。
GAP_REASONS = frozenset({
    "budget_exhausted", "not_measured", "probe_timeout", "environment_shift",
})

#: GAP_REASONS 里属于"执行未完整结束"的：预算耗尽或单次探测超时，本轮
#: 没把该跑的实验跑完——按 P1-3 优先级表归退出码 3（不签发整轮成功），
#: 与 quickstart 的口径一致。其余缺口（not_measured/environment_shift）
#: 是"执行结束但证据不足/范围不完整"，归 5，不冒充无据或完整三态。
INTERRUPTED_GAP_REASONS = frozenset({"budget_exhausted", "probe_timeout"})

#: 输入侧错误（IntakeError code → 退出码 5）；其余 IntakeError 一律 3。
_SCOPE_ERROR_CODES = frozenset({
    "TEST_DISCOVERY_EMPTY", "TEST_DISCOVERY_TOO_BROAD", "TEST_PATH_INVALID",
})


class CheckError(Exception):
    def __init__(self, code: str, message: str, exit_code: int = EXIT_ERROR):
        super().__init__(message)
        self.code, self.message, self.exit_code = code, message, exit_code


def state_root() -> Path:
    return Path(env_get("CHECK_STATE") or Path.home() / ".patchgauge" / "check")


def history_root() -> Path:
    return Path(env_get("CHECK_HISTORY") or Path.home() / ".patchgauge" / "check-history")


def default_reviews_root() -> Path:
    """check 专用审查根，独立于网页服务的 ~/.patchgauge/reviews。

    两个 manager 共享同一根会触发彼此的重启恢复（终止对方非终态审查），
    因此默认分开；--reviews-root 显式指定时不加阻拦，责任在使用者。
    """
    return Path(env_get("CHECK_REVIEWS") or Path.home() / ".patchgauge" / "check-reviews")


# ---------------------------------------------------------------- 输入预检

def repo_toplevel(raw: Path) -> Path:
    try:
        proc = run_git(["rev-parse", "--show-toplevel"], cwd=raw.expanduser(), timeout=10)
    except (OSError, subprocess.SubprocessError) as exc:
        raise CheckError("NOT_A_GIT_REPO", f"无法在 {raw} 运行 git：{exc}") from exc
    if proc.returncode != 0:
        raise CheckError("NOT_A_GIT_REPO", f"{raw} 不是 Git 仓库（或不在仓库内）")
    return Path(proc.stdout.strip()).resolve()


def collect_changes(repo: Path) -> dict:
    """HEAD 视角的现场清点：已跟踪修改/删除、未跟踪、重命名、二进制警告。"""
    proc = run_git(["status", "--porcelain=v1", "-uall"], cwd=repo, check=True, timeout=30)
    out = {"raw": [], "modified": [], "deleted": [], "untracked": [], "renamed": [], "binary": []}
    for line in proc.stdout.splitlines():
        if not line.strip():
            continue
        out["raw"].append(line)
        code, path = line[:2], line[3:].strip('"')
        if code == "??":
            out["untracked"].append(path)
        elif "R" in code:
            out["renamed"].append(path)
        elif "D" in code:
            out["deleted"].append(path)
        else:
            out["modified"].append(path)
    numstat = run_git(["diff", "HEAD", "--numstat"], cwd=repo, check=True, timeout=30)
    for line in numstat.stdout.splitlines():
        parts = line.split("\t")
        if len(parts) == 3 and parts[0] == "-" and parts[1] == "-":
            out["binary"].append(parts[2])
    return out


def load_trusted() -> dict:
    path = state_root() / "trusted-repos.json"
    if not path.exists():
        return {"schema_version": TRUSTED_SCHEMA, "repos": {}}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise CheckError("TRUSTED_REPOS_UNREADABLE", f"无法读取信任登记：{exc}") from exc
    if data.get("schema_version") != TRUSTED_SCHEMA or not isinstance(data.get("repos"), dict):
        raise CheckError("TRUSTED_REPOS_INVALID", "信任登记结构不合法")
    return data


def save_trusted(data: dict) -> None:
    root = state_root()
    root.mkdir(parents=True, exist_ok=True)
    path = root / "trusted-repos.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def collect_trend(repo: Path | None = None) -> dict:
    """聚合检查历史为趋势视图。

    纪律（总计划 P4-3）：比率只在可比分母上给，且分母、未标注、未完成
    一并展示；删测试或缩范围不能制造改善——因此每行都带完整计数。
    """
    root = history_root()
    target = str(repo.expanduser().resolve()) if repo is not None else None
    repos: dict[str, list[dict]] = {}
    if not root.exists():
        return {"repos": {}}
    for result_file in root.glob("**/result.json"):
        try:
            data = json.loads(result_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if data.get("schema_version") != SCHEMA_VERSION:
            continue
        if target is not None and str(data.get("repo") or "") != target:
            continue
        by_label = {str(k): int(v) for k, v in
                    ((data.get("summary") or {}).get("by_label") or {}).items()}
        by_reason = {str(k): int(v) for k, v in
                     ((data.get("summary") or {}).get("by_reason") or {}).items()}
        labeled = sum(by_label.get(k, 0) for k in ("承重", "无据", "游离"))
        when = str(data.get("created_at") or "")
        if not when:
            when = datetime.fromtimestamp(
                result_file.stat().st_mtime, timezone.utc).isoformat()
        repos.setdefault(str(data.get("repo") or result_file.parent.parent.name),
                         []).append({
            "review_id": data.get("review_id"), "at": when,
            "state": data.get("state"), "exit_code": data.get("exit_code"),
            "承重": by_label.get("承重", 0), "无据": by_label.get("无据", 0),
            "游离": by_label.get("游离", 0),
            "未标注": sum(by_reason.values()),
            "已标注行数": labeled,
            "测试数": len(data.get("tests") or [])})
    for rows in repos.values():
        rows.sort(key=lambda row: str(row["at"]))
    return {"repos": repos}


def render_trend_table(trend: dict) -> str:
    lines = []
    for repo, rows in sorted(trend.get("repos", {}).items()):
        lines.append(f"仓库 {repo}（{len(rows)} 次检查）")
        for row in rows:
            labeled = int(row["已标注行数"])
            rate = (f"{row['承重'] / labeled:.0%}" if labeled else "—")
            lines.append(
                f"  {str(row['at'])[:19]}  承重 {row['承重']}｜无据 {row['无据']}｜"
                f"游离 {row['游离']}｜未标注 {row['未标注']}｜已标注分母 {labeled}｜"
                f"承重率 {rate}  {str(row['review_id'])[:8]}")
        lines.append("")
    return "\n".join(lines) or "（还没有检查历史；先跑一次 patchgauge check）"


def authorizations_root() -> Path:
    return state_root() / "authorizations"


def _load_authorization(path: Path) -> dict:
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {}
    if not isinstance(data, dict) or data.get("schema_version") != AUTH_SCHEMA:
        return {}
    if data.get("allowed_actions") != list(AUTH_ACTIONS):
        return {}
    if not isinstance(data.get("python"), str) or not isinstance(data.get("tests"), list):
        return {}
    return {"auth_id": data.get("auth_id", ""), "repo": data.get("repo", ""),
            "python": data.get("python", ""),
            "tests": [str(t) for t in data.get("tests") or []],
            "budget_seconds_max": data.get("budget_seconds_max", 0),
            "valid_until": data.get("valid_until", ""),
            "revoked_at": data.get("revoked_at", ""), "note": data.get("note", ""),
            "path": str(path)}


def list_authorizations() -> list[dict]:
    root = authorizations_root()
    if not root.exists():
        return []
    rows = []
    for path in sorted(root.glob("auth-*.json")):
        row = _load_authorization(path)
        if row:
            rows.append(row)
    return rows


def _auth_active(row: dict, now: datetime | None = None) -> bool:
    if not row or row.get("revoked_at"):
        return False
    try:
        until = datetime.fromisoformat(str(row.get("valid_until")))
    except ValueError:
        return False
    return until.tzinfo is not None and until > (now or datetime.now(timezone.utc))


def _canonical_python(python: Path | str) -> str:
    """解释器的规范形态：resolve() 穿透符号链接。

    同一个 venv 解释器有 python / python3 / python3.14 多种拼法（控制台
    脚本的 shebang 就与签发时敲的命令不同），字符串直比会把同一解释器
    判成两个。不存在路径的 resolve() 原样返回，失配判定不受影响。
    """
    return str(Path(python).expanduser().resolve())


def find_valid_authorization(repo: Path, budget: int, *, python: Path,
                             tests: list[str]) -> dict | None:
    """找覆盖该仓库且预算在额度内、且执行计划一致的有效只读预授权。

    计划一致性＝解释器（按 resolve() 归一）与测试范围逐字相等（tests 为空
    表示"自动发现全集"，授权与检查两侧都为空才算匹配）。撤销/过期立即
    失效；任何一项不匹配都回退逐次确认——授权摘要里展示什么，实际就允许
    跑什么。
    """
    canonical = str(repo.expanduser().resolve())
    wanted_python = _canonical_python(python)
    wanted_tests = sorted(tests)
    for row in list_authorizations():
        if not (_auth_active(row) and row.get("repo") == canonical
                and budget <= int(row.get("budget_seconds_max") or 0)):
            continue
        if _canonical_python(row.get("python") or "") != wanted_python:
            continue
        if sorted(row.get("tests") or []) != wanted_tests:
            continue
        return row
    return None


def issue_authorization(repo: Path, *, hours: float, budget: int,
                        python: Path, tests: list[str],
                        confirm, interactive: bool) -> dict:
    """签发只读预授权。唯一入口是用户显式终端操作：非交互一律拒绝。

    预授权只跳过"只读检查"的逐次确认；不授权采用/交付/任何源码写入，
    快照漂移仍由 approve 的 STALE_APPROVAL 复查兜底。授权绑定的执行计划
    （解释器、测试范围）与检查计划一致，换计划即失配回退确认。
    """
    if not interactive:
        raise CheckError("AUTH_ISSUE_REQUIRES_TERMINAL",
                         "签发预授权必须由用户在终端显式完成；脚本/智能体不能签发")
    if not 0.5 <= hours <= 24 * 30 or not 1 <= budget <= 3600:
        raise CheckError("AUTH_ISSUE_INVALID", "hours 需在 0.5..720，budget 需在 1..3600")
    repo = repo.expanduser().resolve()
    valid_until = datetime.now(timezone.utc) + timedelta(hours=hours)
    python = Path(python).expanduser().resolve()   # 与命中判定同一规范形态
    scope = ("、".join(sorted(tests)) if tests else "自动发现的 pytest 文件全集")
    terms = [
        f"仓库：{repo}",
        f"允许动作：只读检查（{', '.join(AUTH_ACTIONS)}）——不含采用、交付或任何源码写入",
        f"测试解释器：{python}",
        f"测试范围：{scope}（检查计划与此不一致时不命中，回退逐次确认）",
        f"预算上限：{budget} 秒/次",
        f"有效期至：{valid_until.isoformat()}（{hours:g} 小时）",
        "随时撤销：patchgauge check --auth-revoke <auth_id>",
    ]
    if not confirm("签发只读预授权：\n  " + "\n  ".join(terms) + "\n确认签发"):
        raise CheckError("AUTH_ISSUE_DECLINED", "用户未确认，未签发")
    auth_id = f"auth-{uuid.uuid4().hex[:12]}"
    row = {"schema_version": AUTH_SCHEMA, "auth_id": auth_id, "repo": str(repo),  # 已 resolve
           "allowed_actions": list(AUTH_ACTIONS), "budget_seconds_max": budget,
           "python": str(python), "tests": sorted(tests),
           "valid_until": valid_until.isoformat(),
           "created_at": datetime.now(timezone.utc).isoformat(),
           "created_via": "terminal", "note": ""}
    root = authorizations_root()
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{auth_id}.json"
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(row, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    return row


def revoke_authorization(auth_id: str) -> dict:
    """撤销即刻生效：查找只在读取时做有效性判断，标记 revoked 即不再命中。"""
    if not re.fullmatch(r"auth-[a-f0-9]{12}", auth_id or ""):
        raise CheckError("AUTH_ID_INVALID", "auth_id 形如 auth-xxxxxxxxxxxx")
    path = authorizations_root() / f"{auth_id}.json"
    row = _load_authorization(path)
    if not row:
        raise CheckError("AUTH_NOT_FOUND", f"找不到授权 {auth_id}")
    data = json.loads(path.read_text(encoding="utf-8"))
    data["revoked_at"] = datetime.now(timezone.utc).isoformat()
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)
    return data


def slug_for(repo: Path) -> str:
    digest = hashlib.sha256(str(repo).encode("utf-8")).hexdigest()[:8]
    return f"{repo.name}-{digest}"


# ---------------------------------------------------------------- 结果判定

def exit_code_from(state_status: str, bundle: dict) -> int:
    """按总计划 P1-3 的优先级表给出互斥退出码。具名结论以回执为准。

    优先级内再分两档缺口：预算/探测中断（INTERRUPTED_GAP_REASONS）是
    "执行未完整结束"→3；其余缺口与 partial 是"执行结束但证据不足"→5。
    """
    if state_status in {"FAILED", "ABORTED", "CANCELLED"}:
        return EXIT_ERROR
    restore = bundle.get("restore_state") or {}
    if not restore.get("verified") or restore.get("run_status") != "COMPLETE":
        return EXIT_ERROR
    summary = ((bundle.get("evidence_bundle") or {}).get("report") or {}).get("summary") or {}
    by_label = {str(k): int(v) for k, v in (summary.get("by_label") or {}).items()}
    by_reason = {str(k): int(v) for k, v in (summary.get("by_reason") or {}).items()}
    interrupted = sum(v for k, v in by_reason.items() if k in INTERRUPTED_GAP_REASONS)
    if interrupted > 0:
        return EXIT_ERROR
    if state_status == "PARTIAL" or summary.get("analysis_completion") != "complete":
        return EXIT_INSUFFICIENT
    if int(summary.get("total_added_lines") or 0) <= 0:
        return EXIT_INSUFFICIENT
    gap_unlabeled = sum(v for k, v in by_reason.items() if k in GAP_REASONS)
    if gap_unlabeled > 0:
        return EXIT_INSUFFICIENT
    if by_label.get("无据", 0) > 0 or by_label.get("游离", 0) > 0:
        return EXIT_ITEMS
    return EXIT_OK


def group_ranges(numbers: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for n in sorted(numbers):
        if out and n == out[-1][1] + 1:
            out[-1] = (out[-1][0], n)
        else:
            out.append((n, n))
    return out


def bundle_lines(bundle: dict) -> list[dict]:
    model = ((bundle.get("evidence_bundle") or {}).get("report") or {}).get("render_model") or {}
    return [row for row in (model.get("lines") or []) if isinstance(row, dict)]


# ---------------------------------------------------------------- 报告与输出

def recheck_command(repo: Path, tests: list[str]) -> str:
    parts = [sys.executable, "-m", "patchgauge.check", "--repo", str(repo)]
    for t in tests:
        parts += ["--tests", t]
    # shlex.join：仓库路径常含空格（如 "my projects/repo"），空格拼接复制出来
    # 会拆成两个参数，复验命令直接不可用。
    return shlex.join(parts)


def retest_instructions_md(result: dict, lines: list[dict], tests: list[str], repo: Path) -> str:
    """"给 AI 的补测指令"段：确定性模板，CLI 报告与对话结果卡共用。"""
    labeled = {}
    for row in lines:
        label = str(row.get("label") or "")
        if label in {"无据", "游离"}:
            labeled.setdefault((label, str(row.get("file") or "?")), []).append(
                int(row.get("line") or 0))
    if not labeled:
        return ""
    rows = ["## 给 AI 的补测指令（可直接粘贴给编程智能体）", ""]
    rows.append(f"在仓库 `{repo}` 中，以下本次新增代码缺乏测试约束证据"
                "（PatchGauge反事实移除实验未观察到具名测试失败）：")
    rows.append("")
    for (label, file), numbers in sorted(labeled.items()):
        spans = ", ".join(f"{a}" if a == b else f"{a}-{b}" for a, b in group_ranges(numbers))
        fact = ("反事实移除后声明范围内无具名测试失败" if label == "无据"
                else "文件未被测试收集且无静态引用，移除前后测试结果不变")
        rows.append(f"- `{file}` 行 {spans}（{label}：{fact}）")
    rows.append("")
    scope = ("、".join(tests)) if tests else "（本次为自动发现的测试文件全集）"
    rows.append(f"请为上述代码补写具名测试（断言其真实行为），放入当前声明测试范围"
                f"（{scope}），不要为凑绿修改被测代码或弱化断言。完成后运行复验：")
    rows.append("")
    rows.append("```sh")
    rows.append(recheck_command(repo, tests))
    rows.append("```")
    rows.append("")
    return "\n".join(rows)


def build_report_md(result: dict, lines: list[dict], tests: list[str], repo: Path) -> str:
    summary = result["summary"]
    by_label = {str(k): int(v) for k, v in (summary.get("by_label") or {}).items()}
    by_reason = {str(k): int(v) for k, v in (summary.get("by_reason") or {}).items()}
    restore = result["restore_state"]
    rows = []
    rows.append("# PatchGauge · 检查报告")
    rows.append("")
    rows.append(f"- 审查：`{result['review_id']}`　状态：**{result['state']}**　退出码：{result['exit_code']}")
    rows.append(f"- 历史身份：HEAD `{result['head'][:12]}`　快照 `{result['snapshot_sha256'][:12]}`"
                "（源码变化后本报告即成为历史，不复用）")
    rows.append(f"- 仓库：`{repo}`　声明测试范围：{len(tests)} 个文件")
    rows.append(f"- 恢复：verified={restore.get('verified')} run_status={restore.get('run_status')}"
                f" worktree_clean={restore.get('worktree_clean')}")
    rows.append(f"- 结论口径：{EXIT_MEANINGS[result['exit_code']]}")
    rows.append("")
    rows.append("## 三态汇总")
    for key in ("承重", "无据", "游离"):
        rows.append(f"- {key}：{by_label.get(key, 0)} 行")
    unlabeled_total = sum(by_reason.values())
    rows.append(f"- 未标注：{unlabeled_total} 行"
                + (f"（{', '.join(f'{k}={v}' for k, v in sorted(by_reason.items()))}）"
                   if by_reason else ""))
    rows.append("")

    labeled = {}
    for row in lines:
        label = str(row.get("label") or "")
        if label in {"无据", "游离", "承重"}:
            labeled.setdefault((label, str(row.get("file") or "?")), []).append(int(row.get("line") or 0))
    if labeled:
        rows.append("## 明细（按文件）")
        for (label, file), numbers in sorted(labeled.items()):
            spans = ", ".join(f"{a}" if a == b else f"{a}-{b}" for a, b in group_ranges(numbers))
            rows.append(f"- **{label}**　`{file}`：行 {spans}")
        rows.append("")

    retest = retest_instructions_md(result, lines, tests, repo)
    if retest:
        rows.append(retest)
        rows.append("")

    gap_reasons = {k: v for k, v in by_reason.items() if k in GAP_REASONS}
    if gap_reasons or result["exit_code"] == EXIT_INSUFFICIENT:
        rows.append("## 诊断建议（与上方签发事实分开，仅供参考）")
        if gap_reasons:
            rows.append(f"- 存在证据缺口（{', '.join(f'{k}={v}' for k, v in sorted(gap_reasons.items()))}）："
                        "可提高 --budget 后重跑，或收窄 --tests 到相关文件。")
        else:
            rows.append("- 本轮没有可分析的文本增量或范围不完整：确认改动已保存；"
                        "二进制/重命名等未支持项见终端输出明细。")
        rows.append("")
    return "\n".join(rows) + "\n"


def render_terminal(result: dict, lines: list[dict]) -> str:
    summary = result["summary"]
    by_label = {str(k): int(v) for k, v in (summary.get("by_label") or {}).items()}
    by_reason = {str(k): int(v) for k, v in (summary.get("by_reason") or {}).items()}
    restore = result["restore_state"]
    out = []
    out.append(f"审查 {result['review_id']} 终态 {result['state']}，"
               f"HEAD {result['head'][:12]} 快照 {result['snapshot_sha256'][:12]}")
    out.append(f"承重 {by_label.get('承重', 0)}｜无据 {by_label.get('无据', 0)}｜"
               f"游离 {by_label.get('游离', 0)}｜未标注 {sum(by_reason.values())}")
    if by_reason:
        out.append("未标注原因：" + ", ".join(f"{k}={v}" for k, v in sorted(by_reason.items())))
    labeled = {}
    for row in lines:
        label = str(row.get("label") or "")
        if label in {"无据", "游离"}:
            labeled.setdefault((label, str(row.get("file") or "?")), []).append(int(row.get("line") or 0))
    for (label, file), numbers in sorted(labeled.items()):
        spans = ", ".join(f"{a}" if a == b else f"{a}-{b}" for a, b in group_ranges(numbers))
        out.append(f"{label}　{file}：行 {spans}")
    out.append(f"恢复 verified={restore.get('verified')} "
               f"run_status={restore.get('run_status')}；报告 {result['report_path']}")
    out.append(f"退出码 {result['exit_code']}：{EXIT_MEANINGS[result['exit_code']]}")
    return "\n".join(out)


# ---------------------------------------------------------------- 主流程

def _default_confirm(prompt: str) -> bool:
    answer = input(f"{prompt} [y/N] ").strip().lower()
    return answer in {"y", "yes"}


def _is_interactive() -> bool:
    return sys.stdin.isatty() and sys.stdout.isatty()


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="patchgauge check",
        description="单次测试证据检查：对当前工作区相对 HEAD 的增量做反事实实验，输出三态结论。")
    parser.add_argument("--repo", type=Path, default=Path("."), help="仓库路径（默认当前目录）")
    parser.add_argument("--repo-python", action="append", default=[], metavar="REPO=PYTHON",
                        help="绑定被检仓库的测试解释器（可重复），如 ./=.venv/bin/python")
    parser.add_argument("--tests", action="append", default=[], metavar="PATH",
                        help="声明测试文件（可重复，仓库内相对路径）；缺省自动发现 pytest 文件")
    parser.add_argument("--budget", type=int, default=300, help="时间预算秒（1..3600，默认 300）")
    parser.add_argument("--json", action="store_true", help="机器可读输出（不混提示文本）")
    parser.add_argument("--report", type=Path, default=None,
                        help="额外把 Markdown 报告写到指定路径")
    parser.add_argument("--reviews-root", type=Path, default=None,
                        help="审查数据根（默认 ~/.patchgauge/check-reviews，与网页服务分开）")
    parser.add_argument("--open", action="store_true",
                        help="显示在网页工作台查看本次审查的启动说明"
                             "（不自动启动服务；--json 下不打印，保持 JSON 纯净）")
    parser.add_argument("--mcp-config", action="store_true",
                        help="打印把本工具接入 Claude Code / ZCode 等 MCP 客户端的现成命令后退出")
    parser.add_argument("--auth-issue", action="store_true",
                        help="为 --repo 仓库签发只读预授权（仅限用户终端显式操作）")
    parser.add_argument("--auth-hours", type=float, default=24.0,
                        help="预授权有效期小时（默认 24，上限 720）")
    parser.add_argument("--auth-budget", type=int, default=300,
                        help="预授权单次预算上限秒（默认 300）")
    parser.add_argument("--auth-list", action="store_true", help="列出预授权及状态")
    parser.add_argument("--trend", nargs="?", const="", default=None, metavar="REPO",
                        help="趋势视图：聚合该仓库（缺省全部仓库）的检查历史")
    parser.add_argument("--auth-revoke", metavar="AUTH_ID", default="",
                        help="撤销预授权，立即生效")
    return parser


def print_mcp_config() -> int:
    """打印两种模式的接入命令；密钥仍只走钥匙串，不进命令与配置文件。"""
    root = Path(__file__).resolve().parents[1]
    python = str(Path(sys.executable))
    print("== 模式 A（推荐）：连接正在运行的后台服务（与网页/对话入口并行）==")
    print("# 1) 生成一次性令牌文件（手动执行一次，文件自行保管）")
    print(f"   python3 -c \"import secrets;open('/tmp/patchgauge-local-token','w').write(secrets.token_urlsafe(32))\"")
    print("# 2) 登记到 Claude Code（ZCode 同理，改用其 MCP 配置字段）")
    print(f"   claude mcp add patchgauge -e PYTHONPATH={root} -- {python} -m patchgauge.mcp "
          "--connect http://127.0.0.1:8765 --token-file /tmp/patchgauge-local-token")
    print()
    print("== 模式 B：独立独占模式（不依赖后台，仓库白名单内嵌）==")
    print(f"   claude mcp add patchgauge -e PYTHONPATH={root} -- {python} -m patchgauge.mcp "
          "--allow-repo /绝对路径/你的仓库 --reviews-root ~/.patchgauge/check-reviews")
    print()
    print("对编程智能体说：\"用 patchgauge 检查一下当前改动\" 即可；它会给出计划指纹，"
          "你在网页/对话入口确认后实验开始，结论以回执为准。")
    return 0


def _parse_repo_python(pairs: list[str], repo: Path) -> Path:
    for pair in pairs:
        left, sep, right = pair.partition("=")
        if not sep or not right:
            raise CheckError("REPO_PYTHON_INVALID", f"--repo-python 需要 REPO=PYTHON 形式：{pair}")
        bound = Path(left).expanduser()
        bound = bound.resolve() if bound.is_absolute() else (repo / bound).resolve()
        if bound == repo:
            py = Path(right).expanduser()
            return py if py.is_absolute() else (repo / py).resolve()
    return Path(sys.executable)


def run_check(argv: list[str] | None = None, *, _confirm=None, _interactive=None) -> int:
    args = build_parser().parse_args(argv)
    if args.mcp_config:
        return print_mcp_config()
    if args.auth_list:
        rows = list_authorizations()
        for row in rows:
            state = "有效" if _auth_active(row) else ("已撤销" if row.get("revoked_at") else "已过期")
            scope = ("、".join(row["tests"]) if row["tests"] else "自动发现全集")
            print(f"{row['auth_id']}  {state}  {row['repo']}  "
                  f"{row['python']}  测试={scope}  "
                  f"≤{row['budget_seconds_max']}s  至 {row['valid_until'][:19]}")
        if not rows:
            print("（没有预授权记录）")
        return 0
    if args.auth_revoke:
        data = revoke_authorization(args.auth_revoke)
        print(f"已撤销 {data['auth_id']}（对 {data['repo']} 的只读检查将重新要求逐次确认）")
        return 0
    if args.trend is not None:
        repo_arg = Path(args.trend) if args.trend else None
        print(render_trend_table(collect_trend(repo_arg)))
        return 0
    if args.auth_issue:
        confirm_issue = _confirm or _default_confirm
        interactive_issue = _is_interactive() if _interactive is None else _interactive
        repo_for_auth = repo_toplevel(args.repo)
        # 签发时绑定的解释器/测试范围与检查计划同源（同一个解析函数、
        # 同一份 --tests 参数），授权摘要展示什么，实际就允许跑什么。
        python_for_auth = _parse_repo_python(args.repo_python, repo_for_auth)
        row = issue_authorization(repo_for_auth, hours=args.auth_hours,
                                  budget=args.auth_budget,
                                  python=python_for_auth,
                                  tests=[t for t in args.tests],
                                  confirm=confirm_issue, interactive=interactive_issue)
        print(f"已签发 {row['auth_id']}：{row['repo']} 只读检查免确认，"
              f"解释器 {row['python']}、测试 {'、'.join(row['tests']) or '自动发现全集'}，"
              f"≤{row['budget_seconds_max']}s/次，有效期至 {row['valid_until'][:19]}。")
        print("检查计划（解释器/测试范围/预算）与授权不一致时不命中，回退逐次确认。")
        print(f"撤销：patchgauge check --auth-revoke {row['auth_id']}")
        return 0
    emit_json = args.json
    confirm = _confirm or _default_confirm
    interactive = _is_interactive() if _interactive is None else _interactive
    started = time.monotonic()
    review_id = ""

    def fail(code: str, message: str, exit_code: int = EXIT_ERROR) -> int:
        payload = {"error": {"code": code, "message": message}}
        print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
        return exit_code

    try:
        if not 1 <= args.budget <= 3600:
            return fail("BUDGET_INVALID", "--budget 必须在 1..3600 秒")
        repo = repo_toplevel(args.repo)
        changes = collect_changes(repo)
        if not changes["raw"]:
            message = "对 HEAD 无任何差异（含未跟踪文件）：no_changes，不是验收通过"
            if emit_json:
                print(json.dumps({"schema_version": SCHEMA_VERSION, "repo": str(repo),
                                  "outcome": "no_changes", "exit_code": EXIT_NO_CHANGES},
                                 ensure_ascii=False))
            else:
                print(message)
            return EXIT_NO_CHANGES
        snapshot = _repo_snapshot(repo)
        if not snapshot.get("head") or not snapshot.get("snapshot_sha256"):
            return fail("SOURCE_SNAPSHOT_UNAVAILABLE", "无法绑定仓库身份与工作区快照")

        trusted = load_trusted()
        first_time = str(repo) not in trusted["repos"]
        python = _parse_repo_python(args.repo_python, repo)

        tests = [t for t in args.tests]
        warn_bits = []
        if changes["binary"]:
            warn_bits.append("二进制变更不计入分析：" + ", ".join(changes["binary"][:5]))
        if changes["renamed"]:
            warn_bits.append("重命名不在支持范围：" + ", ".join(changes["renamed"][:5]))

        # 单次终端确认：首次合并"登记仓库 + 批准检查计划"，之后仅批准本次计划。
        plan_bits = [
            f"仓库：{repo}" + ("（首次，将登记为受信任本地仓库）" if first_time else ""),
            f"测试解释器：{python}",
            f"测试范围：{'、'.join(tests) if tests else '自动发现的 pytest 文件全集'}",
            f"预算：{args.budget} 秒",
            f"基点：HEAD {snapshot['head'][:12]}　快照：{snapshot['snapshot_sha256'][:12]}",
            f"改动：已跟踪 {len(changes['modified']) + len(changes['deleted'])} 项，"
            f"未跟踪 {len(changes['untracked'])} 项",
        ]
        if warn_bits:
            plan_bits.extend("注意：" + b for b in warn_bits)
        auth_row = find_valid_authorization(repo, args.budget,
                                            python=python, tests=tests)
        if auth_row is not None:
            # 只读预授权：用户显式签发、有限期、可撤销；此处只跳过逐次确认，
            # 快照漂移仍由 approve 的 STALE_APPROVAL 复查兜底，采用/交付仍逐次确认。
            if not emit_json:
                auth_scope = ("、".join(auth_row["tests"])
                              if auth_row["tests"] else "自动发现全集")
                print(f"按只读预授权 {auth_row['auth_id']} 自动确认"
                      f"（解释器 {auth_row['python']}、测试 {auth_scope}、"
                      f"≤{auth_row['budget_seconds_max']}s/次，"
                      f"有效期至 {auth_row['valid_until'][:19]}；撤销 --auth-revoke）。")
        else:
            if not interactive:
                return fail("CONFIRMATION_REQUIRED",
                            "需要终端确认（首次登记与批准）；非交互环境且无有效预授权，失败关闭。"
                            "可先在终端执行：patchgauge check --repo <仓库> --auth-issue")
            prompt = "检查计划摘要：\n  " + "\n  ".join(plan_bits) + "\n确认执行"
            if not confirm(prompt):
                return fail("CONFIRMATION_DECLINED", "用户未确认，未创建审查", EXIT_ERROR)
            if first_time:
                trusted["repos"][str(repo)] = {
                    "python": str(python),
                    "registered_at": datetime.now(timezone.utc).isoformat(),
                }
                save_trusted(trusted)

        reviews_root = (args.reviews_root or default_reviews_root()).expanduser()
        reviews_root.mkdir(parents=True, exist_ok=True)
        registry = RepoRegistry([repo], python_by_repo={repo: python})
        try:
            manager = ReviewManager(registry, root=reviews_root)
        except CapabilityError as exc:
            # 能力注册表缺失/损坏（如安装不完整）：给脚本稳定的错误码，
            # 而不是一段 traceback——原因原样透传，不吞不改判。
            return fail("CAPABILITY_REGISTRY_UNREADABLE", str(exc))
        repo_id = next(r.repo_id for r in registry.registered() if r.path == repo)

        payload = {
            "instruction": "个人检查：验证当前工作区对 HEAD 的增量是否受到声明测试的约束",
            "source": {"kind": "local", "repo_id": repo_id},
            "constraints": {"budget_seconds": args.budget},
        }
        if tests:
            payload["scope"] = {"test_files": tests}
        created = manager.create_v2(payload)
        review_id = created["review_id"]
        resolved_tests = [str(t) for t in
                          ((created.get("request") or {}).get("test_files") or [])]
        if resolved_tests:
            tests = resolved_tests
        plan_sha256 = (created.get("plan") or {}).get("plan_sha256") or ""
        if not plan_sha256:
            return fail("PLAN_FINGERPRINT_MISSING", "审查计划缺少指纹，拒绝继续", EXIT_ERROR)
        manager.approve(review_id, plan_sha256)

        deadline = time.monotonic() + args.budget + 600
        status = ""
        while time.monotonic() < deadline:
            status = str((manager.describe(review_id).get("state") or {}).get("status") or "")
            if status in {s.value for s in TERMINAL}:
                break
            time.sleep(0.5)
        else:
            try:
                manager.cancel(review_id)
            except IntakeError:
                pass
            return fail("REVIEW_TIMEOUT", f"审查 {review_id} 超时未到终态", EXIT_ERROR)
        bundle_path = manager.review_bundle_path(review_id)
        while not bundle_path.exists() and time.monotonic() < deadline:
            time.sleep(0.2)
        if not bundle_path.exists():
            return fail("BUNDLE_NOT_READY", f"终态 {status} 但证据包未落盘：{review_id}", EXIT_ERROR)
        bundle = json.loads(bundle_path.read_text(encoding="utf-8"))

        exit_code = exit_code_from(status, bundle)
        lines = bundle_lines(bundle)
        summary = ((bundle.get("evidence_bundle") or {}).get("report") or {}).get("summary") or {}
        result = {
            "schema_version": SCHEMA_VERSION,
            "review_id": review_id,
            "repo": str(repo),
            "head": snapshot["head"],
            "snapshot_sha256": snapshot["snapshot_sha256"],
            "state": status,
            "summary": summary,
            "restore_state": bundle.get("restore_state") or {},
            "exit_code": exit_code,
            "exit_meaning": EXIT_MEANINGS[exit_code],
            "lines": lines,
            "tests": tests,
            "budget": args.budget,
            "seconds": round(time.monotonic() - started, 1),
            "created_at": datetime.now(timezone.utc).isoformat(),
            "authorization": ({"auth_id": auth_row["auth_id"],
                               "valid_until": auth_row["valid_until"]}
                              if auth_row is not None else None),
            "report_path": "",
        }
        out_dir = history_root() / slug_for(repo) / review_id
        out_dir.mkdir(parents=True, exist_ok=True)
        report_text = build_report_md(result, lines, tests, repo)
        (out_dir / "report.md").write_text(report_text, encoding="utf-8")
        # report_path 必须在写 result.json 之前就位：归档的 JSON 要能独立指回
        # 自己的报告，趋势/历史读取方只看 JSON，不看当次终端输出。
        result["report_path"] = str(out_dir / "report.md")
        (out_dir / "result.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        if args.report:
            args.report.parent.mkdir(parents=True, exist_ok=True)
            args.report.write_text(report_text, encoding="utf-8")

        if emit_json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            print(render_terminal(result, lines))
            for bit in warn_bits:
                print(f"注意：{bit}")
        # --json 时 --open 的启动说明只进报告终端形态；机器输出必须整份恰好
        # 是一个 JSON 文档，后面跟任何文本都会让 json.loads 断掉。
        if args.open and not emit_json:
            print("\n在网页工作台查看（按需手动启动，check 不自动拉起服务）：")
            print(f"  {sys.executable} -m patchgauge.server --allow-repo {repo} "
                  f"--repo-python {repo}={python} --reviews-root {reviews_root}")
            print("  启动后在 Cockpit 打开该服务打印的本地地址，选择该仓库与上述审查号。")
        return exit_code
    except IntakeError as exc:
        code = getattr(exc, "code", "")
        return fail(code or "INTAKE_REJECTED", str(exc),
                    EXIT_INSUFFICIENT if code in _SCOPE_ERROR_CODES else EXIT_ERROR)
    except CheckError as exc:
        return fail(exc.code, exc.message, exc.exit_code)
    except KeyboardInterrupt:
        if review_id:
            try:
                manager.cancel(review_id)
            except Exception:
                pass
        return fail("CANCELLED", "用户中断，已请求取消审查", EXIT_ERROR)


def main(argv: list[str] | None = None) -> int:
    return run_check(argv)


if __name__ == "__main__":
    raise SystemExit(main())
