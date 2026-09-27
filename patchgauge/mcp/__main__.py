"""CLI entry point: python -m patchgauge.mcp --allow-repo ..."""
from .server import main

if __name__ == "__main__":
    raise SystemExit(main())
