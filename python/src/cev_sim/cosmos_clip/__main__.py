"""Command line for exporting and checking a Cosmos transfer clip."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .check import check_clip
from .contract import ClipError
from .export import export_clip


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m cev_sim.cosmos_clip")
    commands = parser.add_subparsers(dest="command", required=True)
    export = commands.add_parser("export", help="Export one clip from a finalized headless run.")
    export.add_argument("--run-output", required=True, type=Path)
    export.add_argument("--camera-id", default="front-camera")
    export.add_argument("--window-index", default=0, type=int)
    export.add_argument("--output-root", required=True, type=Path)
    check = commands.add_parser("check", help="Validate one published clip directory.")
    check.add_argument("clip", type=Path)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = _parser().parse_args(argv)
    try:
        if args.command == "export":
            destination = export_clip(args.run_output, args.output_root, args.camera_id, args.window_index)
            print(destination)
        else:
            print(json.dumps(check_clip(args.clip), sort_keys=True))
    except ClipError as error:
        print(str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
