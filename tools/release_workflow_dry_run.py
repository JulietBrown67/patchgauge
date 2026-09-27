#!/usr/bin/env python3
"""Offline dry-run for the fail-closed GitHub Release decision.

This is the deterministic local equivalent of the sandbox-repository check; it
does not call GitHub or create tags/releases.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

from tools.release_metadata import verify_existing_release


def dry_run(*, tag: str, notes_file: Path) -> dict:
    title = f"水木验码 {tag}"
    body = notes_file.read_text(encoding="utf-8")
    payload = json.dumps({"isPrerelease": True, "name": title, "body": body,
                          "targetCommitish": "HEAD"}, ensure_ascii=False)
    old = os.environ.get("RELEASE_JSON")
    try:
        os.environ["RELEASE_JSON"] = payload
        expected_public_commit = __import__("subprocess").run(
            ["git", "rev-parse", "HEAD"], check=True, capture_output=True,
            text=True, cwd=notes_file.resolve().parents[2],
        ).stdout.strip()
        verify_existing_release(tag, notes_file, title, payload,
                                expected_public_commit)
    finally:
        if old is None:
            os.environ.pop("RELEASE_JSON", None)
        else:
            os.environ["RELEASE_JSON"] = old
    return {"status": "PASS", "tag": tag, "prerelease": True,
            "notes_sha256": __import__("hashlib").sha256(body.encode()).hexdigest(),
            "target": "HEAD", "generate_notes": False}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--tag", default="v0.2.0-experimental.1")
    parser.add_argument("--notes-file", type=Path, required=True)
    args = parser.parse_args(argv)
    print(json.dumps(dry_run(tag=args.tag, notes_file=args.notes_file), ensure_ascii=False, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
