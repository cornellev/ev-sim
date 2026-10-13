"""Put this directory on ``sys.path`` so example scripts can import ``control``."""

from __future__ import annotations

import sys
from pathlib import Path


def bootstrap() -> None:
    root = str(Path(__file__).resolve().parent)
    if root not in sys.path:
        sys.path.insert(0, root)
