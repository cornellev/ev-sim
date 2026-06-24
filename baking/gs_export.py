import json
import os
from pathlib import Path


def _run_dir(run_id):
    return Path("baked") / run_id


def _frames_log_path(run_id):
    return _run_dir(run_id) / "frames.jsonl"


def _manifest_path(run_id):
    return _run_dir(run_id) / "manifest.json"


def _transforms_path(run_id):
    return _run_dir(run_id) / "transforms.json"


def _parse_json_field(value, default=None):
    if value is None:
        return default
    if isinstance(value, (dict, list)):
        return value
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def _camera_angle_x(intrinsics):
    if not intrinsics:
        return None
    width = intrinsics.get("width")
    fx = intrinsics.get("fx")
    if not width or not fx:
        return None
    import math
    return 2 * math.atan(width / (2 * fx))


def load_frame_records(run_id):
    path = _frames_log_path(run_id)
    if not path.exists():
        return []

    records = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            records.append(json.loads(line))
    return records


def build_transforms(run_id):
    records = load_frame_records(run_id)
    frames = []

    for record in records:
        metadata = record.get("metadata", {})
        intrinsics = _parse_json_field(metadata.get("cameraIntrinsics"), {})
        extrinsics = _parse_json_field(metadata.get("cameraExtrinsics"), {})
        position = extrinsics.get("position") if extrinsics else None
        rotation = extrinsics.get("rotation") if extrinsics else None
        final_paths = record.get("final", {})
        final_image = next(iter(final_paths.values()), None)

        frame = {
            "file_path": final_image,
            "sample_id": record.get("sampleId"),
            "frame_index": record.get("frameIndex"),
            "transform_matrix": extrinsics.get("matrixWorld") if extrinsics else None,
            "position": position,
            "rotation": rotation,
            "camera_angle_x": _camera_angle_x(intrinsics),
            "intrinsics": intrinsics,
            "aux": record.get("aux", []),
        }
        frames.append(frame)

    manifest = {}
    manifest_path = _manifest_path(run_id)
    if manifest_path.exists():
        with open(manifest_path, "r", encoding="utf-8") as f:
            manifest = json.load(f)

    return {
        "run_id": run_id,
        "coordinate_system": "threejs-y-up-right-handed",
        "environment_id": manifest.get("environmentId"),
        "seed": manifest.get("seed"),
        "buildings": manifest.get("buildings", []),
        "frames": frames,
    }


def update_transforms_for_run(run_id):
    transforms = build_transforms(run_id)
    output = _transforms_path(run_id)
    output.parent.mkdir(parents=True, exist_ok=True)
    with open(output, "w", encoding="utf-8") as f:
        json.dump(transforms, f, indent=2)
    return output


if __name__ == "__main__":
    import sys

    run = sys.argv[1] if len(sys.argv) > 1 else "default"
    path = update_transforms_for_run(run)
    print(f"Wrote {path}")
