# PatchGauge quickstart

Check out `v0.2.0-experimental.3` from the
[public repository](https://github.com/JulietBrown67/patchgauge), then run:

```sh
python3 -m venv .venv
. .venv/bin/activate
python -m pip install .
patchgauge --help
```

For a trusted, recoverable Python repository, `patchgauge check` previews a
reversible test-evidence experiment and asks for terminal confirmation. To
explore the local workspace, use `python -m patchgauge.server` and follow the
printed address. The web interface is experimental.

Repository checks: `python tools/public_release_check.py --root . --notes-file
docs/release/v0.2.0-experimental.3.md`, `python tests/run.py`, and, in `web/`,
`npm ci`, `npm test`, `npm run build`, and `npm run test:e2e`.
