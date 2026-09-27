"""Environment settings for the PatchGauge public release."""
from __future__ import annotations

import os

PREFIX = "PATCHGAUGE_"


def get(name: str, default: str = "") -> str:
    suffix = name.removeprefix(PREFIX)
    return os.environ.get(PREFIX + suffix, default)


def names(suffix: str) -> tuple[str, ...]:
    return (PREFIX + suffix.removeprefix(PREFIX),)
