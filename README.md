# PatchGauge

[![Public CI](https://github.com/JulietBrown67/patchgauge/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/JulietBrown67/patchgauge/actions/workflows/ci.yml)
[![Experimental release](https://img.shields.io/badge/release-v0.2.0--experimental.3-blue)](https://github.com/JulietBrown67/patchgauge/releases/tag/v0.2.0-experimental.3)

PatchGauge uses reversible experiments to check whether named tests actually
constrain a code change. It temporarily removes candidate additions in an
isolated workspace, reruns the declared tests, checks restoration, and writes
replayable evidence. A passing test suite alone does not establish that every
new line is tested.

**Current preview:** `v0.2.0-experimental.3` (experimental, opt in). This
Release contains source archives only. There is no installer bundle or PyPI
publication for this version. Use the explicit tag rather than GitHub's
`releases/latest` shortcut.

## Install from the tagged source

Use Python 3.11 or newer in a trusted, recoverable working copy:

```sh
git clone https://github.com/JulietBrown67/patchgauge.git
cd patchgauge
git checkout v0.2.0-experimental.3
python3 -m venv .venv
. .venv/bin/activate
python -m pip install .
patchgauge --help
```

Start a local review with `patchgauge check`. The command displays its plan
and requests terminal confirmation before the experiment. The local web app
can be started with `python -m patchgauge.server` and is an experimental
interface to the same evidence engine. See [the release notes](docs/release/v0.2.0-experimental.3.md)
for limitations and [the changelog](CHANGELOG.md) for version history.

## What is included

- A local Python review engine, CLI, and service in `patchgauge/`.
- A web workspace in `web/` and a VS Code integration in
  `extensions/patchgauge-evidence/`.
- Public checks and a capability registry in `configs/capabilities.json`.

The import package and executable are both `patchgauge`. Earlier experimental
checkouts used different names; this release provides no old import or command
alias. Browser state stored by older versions is not imported automatically.
Retain older reports and checkouts if you need their history.

## Scope and safety

This is an independent experimental tool, without institutional endorsement.
Its evidence is scoped to the declared repository, tests, and environment. It
does not establish semantic equivalence, safe deletion, or compatibility with
arbitrary repositories. The command does not push, merge, or publish code.
Use GitHub Private Vulnerability Reporting for sensitive issues; keep secrets,
private paths, and private source out of public issues.

License and notices: [LICENSE](LICENSE), [NOTICE](NOTICE).
