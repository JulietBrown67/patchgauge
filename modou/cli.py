"""最小命令行：对一个本地仓库的改动跑一次审查，结论直接打在终端里。

    python -m modou check -t tests/
    python -m modou check path/to/repo -t tests/test_x.py --base main
    python -m modou check -t tests/ --format json --fail-on inert,unevidenced

不需要启动本地服务、不需要构建前端、不需要预置配置。它只是
`application.analyze_patch` 外面的一层薄壳：判定仍然全部在引擎里。

**默认四态。** 惰性（测试执行到了这段新增代码，但把它删掉后声明的测试
全部照样通过）是这里最有用的信号：它指向"只跑不断言"的测试。
空心惰性（单元里有从未执行的行，典型是只在 import 时执行了 def 行的
未测函数）由引擎挡掉，归为 未标注/inert_hollow，不会呈现成惰性。
`--three-state` 可恢复旧口径，把惰性退回 未标注/inert_withheld。

退出码：0 完成且没有命中 --fail-on；1 命中 --fail-on；2 输入错误或审查失败。
"""
from __future__ import annotations

import argparse
import contextlib
import json
import os
import sys
from pathlib import Path

from .inputs import InputError
from .models import Label

#: 英文短名 → 引擎标签。--fail-on 与 JSON 输出用英文短名，终端用中文。
LABELS = {
    "inert": Label.INERT,
    "unevidenced": Label.UNEVIDENCED,
    "orphaned": Label.DRIFT,
    "load-bearing": Label.LOAD_BEARING,
}
SLUG = {v.value: k for k, v in LABELS.items()}

#: 终端里每一类结论的一句话解释。措辞遵守边界纪律：不说"可删"、不说"正确"。
MEANING = {
    Label.INERT: "测试执行到了，但删掉后声明的测试全部照样通过——测试可能只跑不断言",
    Label.UNEVIDENCED: "声明的测试从没执行到这些行",
    Label.DRIFT: "新增文件不被声明的测试收集或静态引用",
    Label.LOAD_BEARING: "删掉后有具名测试回归",
}
ORDER = (Label.INERT, Label.UNEVIDENCED, Label.DRIFT, Label.LOAD_BEARING)

_COLOR = {Label.INERT: "35", Label.UNEVIDENCED: "33", Label.DRIFT: "37",
          Label.LOAD_BEARING: "31"}


class CliError(Exception):
    pass


# ------------------------------------------------------------------ 参数

def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m modou",
        description="水木验码：用可逆删除实验检查新增代码是否真正受测试约束。")
    sub = p.add_subparsers(dest="command", required=True)
    c = sub.add_parser(
        "check", help="审查仓库相对某个版本的改动（默认：工作树相对 HEAD 的未提交改动）",
        description="只在你信任的仓库上运行：它会在临时工作区里执行仓库的测试代码。")
    c.add_argument("repo", nargs="?", default=".", help="Git 仓库路径（默认当前目录）")
    c.add_argument("-t", "--tests", action="append", default=[], required=True,
                   metavar="PATH",
                   help="声明的 pytest 测试文件或目录（可重复）；目录会展开成其中的 "
                        "test_*.py / *_test.py。结论只在这个范围内成立")
    c.add_argument("--base", default="", metavar="REV",
                   help="与哪个版本比较（默认 HEAD）。未提交改动与未跟踪文件都会算进补丁")
    c.add_argument("--patch", type=Path, metavar="FILE",
                   help="改为审查一个 diff 文件（打在 --base 上）")
    c.add_argument("--python", default="", metavar="PY",
                   help="运行测试的解释器，需装有 pytest 与 coverage（默认当前解释器）")
    c.add_argument("--budget", type=float, default=300.0, metavar="SEC",
                   help="探测预算秒数（默认 300）；耗尽的行记为 budget_exhausted")
    c.add_argument("--format", choices=("text", "json"), default="text")
    c.add_argument("--fail-on", default="", metavar="LABELS",
                   help="逗号分隔：inert,unevidenced,orphaned,load-bearing；"
                        "出现任一即以退出码 1 结束，用于 CI")
    c.add_argument("--three-state", action="store_true",
                   help="旧口径：不呈现惰性，退回 未标注/inert_withheld")
    c.add_argument("--out", type=Path, metavar="DIR",
                   help="产物目录（默认 ~/.modou/scratch/modou_runs）")
    c.add_argument("--no-color", action="store_true")
    return p


def _fail_on(raw: str) -> set[Label]:
    out = set()
    for name in filter(None, (x.strip() for x in raw.split(","))):
        if name not in LABELS:
            raise CliError(f"--fail-on 不认识 {name!r}；可选：{', '.join(LABELS)}")
        out.add(LABELS[name])
    return out


def expand_tests(repo: Path, raw: list[str]) -> tuple[str, ...]:
    """把 -t 参数变成仓库内相对的测试文件列表。目录展开，顺序稳定、去重。"""
    files: list[str] = []
    for item in raw:
        cand = Path(item)
        if not cand.is_absolute():
            # 先按仓库根解释；不在那儿再按当前目录解释（在子目录里敲命令时）。
            cand = repo / item if (repo / item).exists() else Path.cwd() / item
        cand = cand.resolve()
        if not cand.exists():
            raise CliError(f"测试路径不存在：{item}")
        try:
            cand.relative_to(repo)
        except ValueError:
            raise CliError(f"测试路径不在仓库内：{item}") from None
        if cand.is_dir():
            found = sorted({p for pat in ("test_*.py", "*_test.py")
                            for p in cand.rglob(pat) if p.is_file()})
            if not found:
                raise CliError(f"目录里没有 test_*.py / *_test.py：{item}")
        else:
            found = [cand]
        for p in found:
            rel = p.relative_to(repo).as_posix()
            if rel not in files:
                files.append(rel)
    return tuple(files)


# ------------------------------------------------------------------ 结论整理

def _ranges(lines: list[int]) -> list[tuple[int, int]]:
    out: list[tuple[int, int]] = []
    for n in sorted(lines):
        if out and n == out[-1][1] + 1:
            out[-1] = (out[-1][0], n)
        else:
            out.append((n, n))
    return out


def collect_findings(payload: dict, repo: Path) -> list[dict]:
    """按 (标签, 文件) 把逐行结论合成连续区间，并带上首行源码。"""
    by: dict[tuple[str, str], list[int]] = {}
    for line in payload.get("lines", []):
        if line.get("label") in SLUG:
            by.setdefault((line["label"], line["file"]), []).append(int(line["line"]))
    # 承重区间对应的具名回归测试：从 render_model 的单元里取。
    regressions: dict[str, list[tuple[int, int, list[str]]]] = {}
    for unit in (payload.get("render_model") or {}).get("units", []):
        if unit.get("verdict") != Label.LOAD_BEARING.value:
            continue
        loc = unit.get("location") or {}
        tests = [f"{r['test_id']} {r['before']}→{r['after']}"
                 for r in unit.get("regressions", [])]
        regressions.setdefault(loc.get("file", ""), []).append(
            (int(loc.get("start", 0)), int(loc.get("end", 0)), tests))

    source: dict[str, list[str]] = {}
    findings = []
    for (label, path), nums in sorted(by.items(),
                                      key=lambda kv: (ORDER.index(Label(kv[0][0])), kv[0][1])):
        if path not in source:
            try:
                source[path] = (repo / path).read_text(
                    encoding="utf-8", errors="replace").splitlines()
            except OSError:
                source[path] = []
        for start, end in _ranges(nums):
            src = source[path]
            code = [src[i - 1] for i in range(start, end + 1) if 0 < i <= len(src)]
            tests: list[str] = []
            if label == Label.LOAD_BEARING.value:
                for s, e, t in regressions.get(path, []):
                    if s <= end and start <= e:
                        tests += [x for x in t if x not in tests]
            findings.append({"label": SLUG[label], "label_zh": label, "file": path,
                             "start": start, "end": end, "code": code, "tests": tests})
    return findings


# ------------------------------------------------------------------ 输出

def _paint(text: str, code: str, on: bool) -> str:
    return f"\033[{code}m{text}\033[0m" if on else text


def render_text(findings: list[dict], summary: dict, report: str, *,
                color: bool, three_state: bool) -> str:
    out: list[str] = []
    for label in ORDER:
        items = [f for f in findings if f["label_zh"] == label.value]
        if not items:
            continue
        count = sum(f["end"] - f["start"] + 1 for f in items)
        out.append(_paint(f"{label.value}（{SLUG[label.value]}）· {count} 行", "1;" + _COLOR[label], color))
        out.append(_paint(f"  {MEANING[label]}", "2", color))
        for f in items:
            where = f"{f['file']}:{f['start']}" + (f"-{f['end']}" if f["end"] != f["start"] else "")
            first = next((c.strip() for c in f["code"] if c.strip()), "")
            if len(first) > 72:
                first = first[:69] + "..."
            out.append(f"  {where:<32} {first}")
            for t in f["tests"][:3]:
                out.append(_paint(f"      ↳ {t}", "2", color))
        out.append("")

    by_label = summary.get("by_label") or {}
    by_reason = summary.get("by_reason") or {}
    parts = [f"{lab.value} {by_label.get(lab.value, 0)}" for lab in ORDER]
    parts.append(f"未标注 {by_label.get(Label.UNLABELED.value, 0)}")
    out.append(f"新增 {summary.get('total_added_lines', 0)} 行：" + " · ".join(parts))
    if by_reason:
        out.append(_paint("  未标注原因：" + "，".join(
            f"{k} {v}" for k, v in sorted(by_reason.items(), key=lambda kv: -kv[1])), "2", color))
    if by_reason.get("budget_exhausted"):
        out.append(_paint(f"  预算耗尽，{by_reason['budget_exhausted']} 行没有探测；"
                          "可用 --budget 加大预算或缩小 -t 范围", "33", color))
    if three_state:
        out.append(_paint("  --three-state：惰性结论已退回 未标注/inert_withheld", "2", color))
    out.append(_paint(f"  耗时 {summary.get('seconds', 0)} 秒 · 报告 {report}", "2", color))
    out.append(_paint("  结论只在声明的测试范围与本次环境内成立；不证明代码正确，也不代表可以安全删除。",
                      "2", color))
    return "\n".join(out)


# ------------------------------------------------------------------ 主流程

def _progress(stream):
    # 一个锚点就是补丁里的一个文件；probe.completed 在该文件的全部实验跑完后发一次。
    state = {"total": 0, "done": 0}

    def sink(kind: str, data: dict) -> None:
        if kind == "universe.frozen":
            state["total"] = int(data.get("count") or 0)
        elif kind == "baseline.completed":
            print(f"基线：{data.get('declared_tests')} 个测试，{data.get('seconds')} 秒；"
                  f"开始对 {state['total']} 个文件做删除实验", file=stream, flush=True)
        elif kind == "probe.completed":
            state["done"] += 1
            if stream.isatty():
                print(f"\r  文件 {state['done']}/{state['total']}",
                      end="", file=stream, flush=True)
        elif kind in ("run.synthesizing", "run.failed") and stream.isatty() and state["done"]:
            print(file=stream, flush=True)
    return sink


def check(args) -> int:
    from .application import AnalysisRequest, ExecutionMode, analyze_patch

    repo = Path(args.repo).expanduser().resolve()
    if not (repo / ".git").exists():
        raise CliError(f"不是 Git 仓库根目录：{repo}")
    fail_on = _fail_on(args.fail_on)
    tests = expand_tests(repo, args.tests)
    req = AnalysisRequest(
        repo_path=repo, patch_file=args.patch, base_commit=args.base,
        test_files=tests, python=args.python or sys.executable,
        budget_seconds=args.budget, mode=ExecutionMode.TRUSTED_LOCAL,
        out_root=args.out, three_state=args.three_state, quiet=True)

    print(f"审查 {repo}（{len(tests)} 个测试文件）· 受信任本地仓库模式",
          file=sys.stderr, flush=True)
    # 引擎内部偶有直接打印；JSON 模式下 stdout 只能有 JSON。
    with contextlib.redirect_stdout(sys.stderr):
        handle = analyze_patch(req, event_sink=_progress(sys.stderr))
    if not handle.ok:
        raise CliError(f"审查失败 [{handle.failure_stage}] {handle.failure_detail}")

    payload = json.loads(Path(handle.report_path).read_text(encoding="utf-8"))
    summary = payload.get("summary") or handle.summary
    findings = collect_findings(payload, repo)
    hit = sorted({f["label"] for f in findings if LABELS[f["label"]] in fail_on})

    if args.format == "json":
        json.dump({"schema_version": "shuimu-cli-check-v1",
                   "repo": str(repo), "tests": list(tests),
                   "three_state": args.three_state,
                   "summary": summary, "findings": findings,
                   "fail_on": sorted(SLUG[l.value] for l in fail_on),
                   "failed_on": hit, "report": str(handle.report_path)},
                  sys.stdout, ensure_ascii=False, indent=2)
        print()
    else:
        color = (not args.no_color and sys.stdout.isatty()
                 and os.environ.get("NO_COLOR") is None)
        print(render_text(findings, summary, str(handle.report_path),
                          color=color, three_state=args.three_state))
        if hit:
            print(f"\n命中 --fail-on：{', '.join(hit)}")
    return 1 if hit else 0


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "check":
            return check(args)
    except (CliError, InputError) as exc:
        print(f"错误：{exc}", file=sys.stderr)
        return 2
    return 2


if __name__ == "__main__":
    sys.exit(main())
