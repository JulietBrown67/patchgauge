"""macOS Seatbelt 沙箱启动器（正式路径）。

从 ``tools/sandbox/launch.py`` 原样收编进 ``patchgauge`` 包：``pyproject.toml``
只打包 ``patchgauge*``，留在 tools 里的实现装进 wheel 后不存在，
``SandboxedExecutor`` 会在运行时 ImportError——沙箱模式因此整个不可用。

三层一起上，缺一层都不够：

| 层 | 挡住什么 | 靠什么 |
| --- | --- | --- |
| seatbelt profile | 写工作区外、读凭据、联网 | `sandbox-exec -f` |
| rlimit | CPU 时间、单文件大小 | `setrlimit`（preexec） |
| 环境清理 | API key / token 泄进被测进程 | 白名单 env |

**两件在 macOS 上做不到的事，必须如实标为未覆盖**（见
`experiments/沙箱可行性_0823.md`）：

- **内存封顶**：`RLIMIT_AS` / `DATA` / `RSS` / `STACK` 的 `setrlimit` 在
  macOS 上直接失败，实测分配 600 MiB 照样成功。要封顶得轮询 RSS 再杀，
  或者上容器。
- **fork bomb**：`RLIMIT_NPROC` 按**用户**计而不是按进程树计。开发机上
  已有三百多个进程，压到 128 会让**所有** fork 失败（`BlockingIOError 35`），
  压不到有意义的低位就防不住 fork bomb。

`sandbox-exec` 被 Apple 标记为 deprecated，但在 macOS 26.6.2 上仍然存在且
生效。这一点要写进对外口径，不能假装它是长期方案。
"""
from __future__ import annotations

import os
import resource
import signal
import subprocess
import sys
from pathlib import Path

#: seatbelt profile 模板内联在包里：wheel 安装没有 repo 树，读不到
#: tools/sandbox/profile.sb.tmpl。占位符与原模板一致。
_PROFILE_TEMPLATE = """\
;; PatchGauge沙箱 profile 模板（seatbelt / SBPL）。占位符由 sandbox.py 填充。
;;
;; 8/23 在 macOS 26.6.2 上实测：写越界、读凭据、联网全部拦住，
;; PatchGauge自身 157/157 测试在其中全绿。见 experiments/沙箱可行性_0823.md。
;;
;; 拦不住的两件事写在文档里，不写在这里假装拦住了：
;;   · 内存封顶——RLIMIT_AS/DATA/RSS 在 macOS 上 setrlimit 直接失败；
;;   · fork bomb——RLIMIT_NPROC 按**用户**计不按进程树计，桌面上没法压低。
(version 1)
(deny default)
(allow process-exec process-fork signal)
(allow sysctl-read)
(allow mach-lookup)
(allow file-read*)
(deny file-read*
  (subpath "{HOME}/.ssh")
  (subpath "{HOME}/.aws")
  (subpath "{HOME}/.config/gh")
  (subpath "{HOME}/.claude")
  (literal "{HOME}/.git-credentials")
  (literal "{HOME}/.netrc"))
(allow file-write*
  (subpath "{SCRATCH}")
  (literal "/dev/null") (literal "/dev/dtracehelper") (literal "/dev/urandom"))
(deny network*)
"""

#: 只有这些环境变量能进沙箱。白名单而不是黑名单——
#: 黑名单永远漏，而漏掉的那个恰好会是 key。
ENV_ALLOW = frozenset({"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR",
                       "PWD", "SHELL", "USER", "PATCHGAUGE_SCRATCH",
                       "PYTHONDONTWRITEBYTECODE", "PYTHONWARNINGS",
                       "PYTEST_ADDOPTS", "COVERAGE_FILE", "COVERAGE_RCFILE"})

#: 这些是能拿到的限制。**拿不到的不写在这里**，见模块 docstring。
CPU_SECONDS = 600
MAX_FILE_BYTES = 256 << 20


def build_profile(scratch: Path, home: Path | None = None) -> str:
    home = home or Path.home()
    return _PROFILE_TEMPLATE.format(HOME=str(home), SCRATCH=str(scratch))


def _limits(cpu_seconds: int = CPU_SECONDS,
            max_file_bytes: int = MAX_FILE_BYTES) -> None:
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_FSIZE, (max_file_bytes, max_file_bytes))


def execute(argv: list[str], *, scratch: Path, profile_path: Path,
        cwd: Path | None = None, credential_home: Path | None = None,
        process_home: Path | None = None, timeout: float | None = None,
        env: dict | None = None,
        cpu_seconds: int = CPU_SECONDS,
        max_file_bytes: int = MAX_FILE_BYTES,
        process_record: Path | None = None) -> subprocess.CompletedProcess:
    """在沙箱里运行命令，返回与 ``subprocess.run`` 相同的结果结构。"""
    scratch = Path(scratch).resolve()
    profile_path.write_text(
        build_profile(scratch, credential_home or Path.home()), encoding="utf-8")
    source = dict(os.environ) if env is None else dict(env)
    child_env = {k: str(v) for k, v in source.items() if k in ENV_ALLOW}
    child_env["HOME"] = str(process_home or scratch / "home")
    child_env["TMPDIR"] = str(scratch / "tmp")
    child_env["PATCHGAUGE_SCRATCH"] = str(scratch)
    child_env["PYTHONDONTWRITEBYTECODE"] = "1"
    process = subprocess.Popen(
        ["/usr/bin/sandbox-exec", "-f", str(profile_path), *argv],
        env=child_env, cwd=str(cwd) if cwd else None,
        preexec_fn=lambda: _limits(cpu_seconds, max_file_bytes),
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
        start_new_session=os.name != "nt")
    if process_record is not None:
        from patchgauge.executor import _write_process_record
        try:
            _write_process_record(process_record, process, argv)
        except Exception:
            if os.name == "nt":
                process.kill()
            else:
                os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=2)
            raise
    try:
        try:
            stdout, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            if os.name == "nt":
                process.kill()
            else:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            stdout, stderr = process.communicate()
            raise subprocess.TimeoutExpired(
                process.args, timeout, output=stdout or exc.output,
                stderr=stderr or exc.stderr) from exc
    finally:
        if process.poll() is not None and process_record is not None:
            from patchgauge.executor import _clear_process_record
            _clear_process_record(process_record)
    return subprocess.CompletedProcess(process.args, process.returncode,
                                       stdout, stderr)


def run(argv: list[str], *, scratch: Path, profile_path: Path,
        cwd: Path | None = None, home: Path | None = None,
        cpu_seconds: int = CPU_SECONDS,
        max_file_bytes: int = MAX_FILE_BYTES,
        quiet: bool = False) -> int:
    """兼容原型探针的退出码接口；正式路径使用 ``execute``。"""
    result = execute(
        argv, scratch=scratch, profile_path=profile_path, cwd=cwd,
        credential_home=home, process_home=scratch / "home",
        cpu_seconds=cpu_seconds, max_file_bytes=max_file_bytes)
    if not quiet:
        if result.stdout:
            print(result.stdout, end="")
        if result.stderr:
            print(result.stderr, end="", file=sys.stderr)
    return result.returncode


def available() -> bool:
    """这台机器上能不能用。不能用就必须退回 trusted-local 并明示。"""
    return sys.platform == "darwin" and Path("/usr/bin/sandbox-exec").exists()
