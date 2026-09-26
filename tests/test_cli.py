"""最小 CLI 与惰性结论：公开回归。

惰性要放出来，就得先证明它不会把"只在 import 时执行了 def 行的未测函数"
说成惰性（H3 护栏的原始反例）。这里用一个很小的仓库同时放两种情况：

- `pick(rng=None)` 被测试调用，但测试总是注入 rng，`rng = rng or _default`
  这一行删掉后测试照样绿 → 真惰性；
- `untested()` 从没被测试调用，只有 def 行在 import 时执行 → 空心惰性，
  必须退回 未标注/inert_hollow，而不是惰性。
"""
from __future__ import annotations

import contextlib
import io
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from modou import cli
from modou.models import Label, LineResult, Unlabeled

BASE = '''def double(x):
    return x * 2
'''

PATCHED = '''def double(x):
    return x * 2


def _default():
    return 1


def pick(rng=None):
    rng = rng or _default
    return double(rng())


def untested(x):
    """从没有测试调用它。"""
    y = x + 1
    return y
'''

TESTS = '''from lib import double, pick


def test_double():
    assert double(2) == 4


def test_pick():
    assert pick(lambda: 3) == 6
'''


def _git(repo: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True)


def _repo(root: Path) -> Path:
    repo = root / "clirepo"
    (repo / "tests").mkdir(parents=True)
    (repo / "lib.py").write_text(BASE, encoding="utf-8")
    (repo / "tests" / "test_lib.py").write_text(
        "from lib import double\n\n\ndef test_double():\n    assert double(2) == 4\n",
        encoding="utf-8")
    (repo / ".gitignore").write_text("__pycache__/\n.pytest_cache/\n", encoding="utf-8")
    _git(repo, "init", "-q", ".")
    _git(repo, "config", "user.email", "cli@example.invalid")
    _git(repo, "config", "user.name", "cli")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-q", "-m", "base")
    (repo / "lib.py").write_text(PATCHED, encoding="utf-8")
    (repo / "tests" / "test_lib.py").write_text(TESTS, encoding="utf-8")
    return repo


def _run(argv: list[str]) -> tuple[int, str]:
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        code = cli.main(argv)
    return code, out.getvalue()


def _line(repo: Path, text: str) -> int:
    lines = (repo / "lib.py").read_text(encoding="utf-8").splitlines()
    return next(i for i, line in enumerate(lines, 1) if line.strip() == text)


def test_cli_reports_inert_and_holds_back_hollow_units():
    root = Path(tempfile.mkdtemp())
    try:
        repo = _repo(root)
        code, out = _run(["check", str(repo), "-t", "tests", "--format", "json",
                          "--out", str(root / "runs"), "--budget", "180"])
        assert code == 0, out
        data = json.loads(out)
        inert = {(f["start"], f["end"]) for f in data["findings"] if f["label"] == "inert"}
        rng_line = _line(repo, "rng = rng or _default")
        assert any(s <= rng_line <= e for s, e in inert), data["findings"]

        # 未测函数：def 行不能被说成惰性，函数体是无据。
        def_line = _line(repo, "def untested(x):")
        body_line = _line(repo, "y = x + 1")
        assert not any(s <= def_line <= e for s, e in inert), data["findings"]
        report = json.loads(Path(data["report"]).read_text(encoding="utf-8"))
        by_line = {r["line"]: r for r in report["lines"] if r["file"] == "lib.py"}
        assert by_line[def_line]["label"] == "未标注"
        assert by_line[def_line]["reason"] == "inert_hollow"
        assert by_line[body_line]["label"] == "无据"
        # 引擎与账本推导两套实现必须一致，否则整次运行会失败关闭。
        assert data["summary"]["derive_parity"]["ok"] is True
        assert data["summary"]["three_state"] is False

        code, out = _run(["check", str(repo), "-t", "tests/test_lib.py",
                          "--format", "json", "--fail-on", "inert",
                          "--out", str(root / "runs"), "--budget", "180"])
        assert code == 1
        assert json.loads(out)["failed_on"] == ["inert"]

        code, out = _run(["check", str(repo), "-t", "tests", "--three-state",
                          "--format", "json", "--out", str(root / "runs"),
                          "--budget", "180"])
        assert code == 0
        data = json.loads(out)
        assert not [f for f in data["findings"] if f["label"] == "inert"]
        assert data["summary"]["by_reason"].get("inert_withheld", 0) >= 1
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_cli_rejects_bad_input_with_exit_code_2():
    root = Path(tempfile.mkdtemp())
    try:
        repo = _repo(root)
        assert _run(["check", str(repo), "-t", "missing"])[0] == 2
        assert _run(["check", str(repo), "-t", "tests", "--fail-on", "bogus"])[0] == 2
        assert _run(["check", str(root), "-t", "tests"])[0] == 2
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_expand_tests_walks_directories_and_dedupes():
    root = Path(tempfile.mkdtemp())
    try:
        repo = _repo(root).resolve()
        (repo / "tests" / "sub").mkdir()
        (repo / "tests" / "sub" / "api_test.py").write_text("", encoding="utf-8")
        (repo / "tests" / "helpers.py").write_text("", encoding="utf-8")
        got = cli.expand_tests(repo, ["tests", "tests/test_lib.py"])
        assert got == ("tests/sub/api_test.py", "tests/test_lib.py")
    finally:
        shutil.rmtree(root, ignore_errors=True)


def test_merge_withholds_inert_from_a_unit_with_unexecuted_lines():
    """label.merge 单独的规则测试：单元里有无据行，整个单元不给惰性。"""
    from modou import label
    from modou.models import EvidenceUnit, Transform

    base = [
        LineResult("m.py", 1, Label.UNLABELED, Unlabeled.NOT_ISOLATED),   # def：import 时执行
        LineResult("m.py", 2, Label.UNEVIDENCED, None),                   # 函数体：从没执行
        LineResult("m.py", 5, Label.UNLABELED, Unlabeled.NOT_ISOLATED),   # 另一个单元，真被执行
    ]
    unit = dict(path="m.py", node_type="FunctionDef",
                transform=Transform(deleted_lines=(1, 2), pass_inserted_at=None),
                baseline=None, mutated=None, verdict=Label.INERT)
    hollow = EvidenceUnit(unit_id="u1", line_start=1, line_end=2, **unit)
    solid = EvidenceUnit(unit_id="u2", line_start=5, line_end=5, **unit)
    out = {r.lineno: r for r in label.merge(base, [hollow, solid], set())}
    assert out[1].label is Label.UNLABELED and out[1].reason is Unlabeled.INERT_HOLLOW
    assert out[2].label is Label.UNEVIDENCED
    assert out[5].label is Label.INERT


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("PASS", name)
    sys.exit(0)
