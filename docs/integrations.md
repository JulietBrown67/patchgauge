# CLI、MCP 与 VS Code 接入

## 独立命令行（不需要本地后台）

`python -m modou check` 直接在本地仓库上跑一次审查，结论打在终端里，不经过本地后台和前端：

```bash
python -m modou check [REPO] -t tests/ [--base REV | --patch FILE] [--python PY]
                      [--budget 300] [--format text|json] [--fail-on LABELS]
                      [--three-state] [--out DIR]
```

- `-t` 可重复，接受测试文件或目录（目录展开成其中的 `test_*.py` / `*_test.py`）；结论只在这个范围内成立。
- 默认审查工作树相对 `HEAD` 的未提交改动（含未跟踪文件）；`--base` 换比较版本，`--patch` 改为审查 diff 文件。
- 默认呈现四类结论：承重、无据、游离，以及实验性的惰性（测试执行到了，但删除后测试全部照样通过）。含从未执行行的单元不判惰性，记为 `未标注/inert_hollow`。`--three-state` 把惰性退回 `未标注/inert_withheld`。
- `--fail-on` 取 `inert`、`unevidenced`、`orphaned`、`load-bearing` 的逗号组合；出现任一时退出码为 1。输入错误或审查失败时退出码为 2。
- 只在受信任本地仓库模式下运行：它会在临时工作区执行仓库的测试代码。

## 连接本地后台

所有入口都连接同一本地后台，读取同一任务和版本回执。用户负责选择仓库、批准计划和创建授权；入口不会自行扩大权限。

在已经启动的本地后台上使用包内 Python 解释器运行客户端。连接地址和一次性令牌只从当前会话或本地运行目录读取，不要把令牌写入仓库或提交到日志：

```bash
python -m modou.mcp --connect http://127.0.0.1:8765 --token-file ../run/server.token
```

实际端口以启动器输出为准。使用 VS Code 时设置 `shuimu.projectPath`、`shuimu.pythonPath` 和 `shuimu.server`，首次连接时输入本次服务令牌。扩展只支持受信本地工作区，不发布到扩展市场。
