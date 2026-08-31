#!/usr/bin/env python3
from __future__ import annotations

import argparse
import filecmp
import shutil
import sys
import tempfile
from pathlib import Path

from grpc_tools import protoc

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
PROTO_ROOT = REPOSITORY_ROOT / "proto"
PROTO_FILE = PROTO_ROOT / "cev_sim" / "headless" / "v1" / "headless.proto"
OUTPUT_ROOT = REPOSITORY_ROOT / "python" / "src"
GENERATED_FILES = (
    Path("cev_sim/headless/v1/headless_pb2.py"),
    Path("cev_sim/headless/v1/headless_pb2.pyi"),
    Path("cev_sim/headless/v1/headless_pb2_grpc.py"),
)


def generate(output_root: Path) -> None:
    result = protoc.main(
        [
            "grpc_tools.protoc",
            f"-I{PROTO_ROOT}",
            f"--python_out={output_root}",
            f"--pyi_out={output_root}",
            f"--grpc_python_out={output_root}",
            str(PROTO_FILE),
        ]
    )
    if result != 0:
        raise SystemExit(result)


def check() -> None:
    with tempfile.TemporaryDirectory(prefix="cev-sim-proto-") as directory:
        temporary_root = Path(directory)
        generate(temporary_root)
        stale = [
            str(relative)
            for relative in GENERATED_FILES
            if not filecmp.cmp(temporary_root / relative, OUTPUT_ROOT / relative, shallow=False)
        ]
    if stale:
        print("Generated Python protobuf bindings are stale:", file=sys.stderr)
        for relative in stale:
            print(f"  {relative}", file=sys.stderr)
        print("Run: python scripts/generate_proto.py", file=sys.stderr)
        raise SystemExit(1)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail when checked-in bindings differ")
    options = parser.parse_args()
    if options.check:
        check()
        return
    for relative in GENERATED_FILES:
        (OUTPUT_ROOT / relative).parent.mkdir(parents=True, exist_ok=True)
    generate(OUTPUT_ROOT)
    for cache in OUTPUT_ROOT.rglob("__pycache__"):
        shutil.rmtree(cache)


if __name__ == "__main__":
    main()
