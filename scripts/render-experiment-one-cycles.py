"""Render the frozen Experiment 1 still/path schedule with pinned Blender Cycles."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Vector


THREE_TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))
SIMPLE_PARTS = {
    "table": {"top", "leg-nw", "leg-ne"},
    "chair-a": {"seat", "back", "leg-nw", "leg-ne"},
    "chair-b": {"seat", "back", "leg-nw", "leg-ne"},
    "cabinet": {"body", "top"},
    "fabric": {"fold-1"},
    "clutter-books": {"book-1"},
    "clutter-box": {"body"},
}


def arguments() -> argparse.Namespace:
    values = []
    if "--" in __import__("sys").argv:
        values = __import__("sys").argv[__import__("sys").argv.index("--") + 1 :]
    parser = argparse.ArgumentParser()
    parser.add_argument("--schedule", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--full", action="store_true")
    parser.add_argument("--limit", type=int, default=0)
    return parser.parse_args(values)


def three_point(values: list[float]) -> Vector:
    return (THREE_TO_BLENDER @ Vector((*values, 1))).to_3d()


def configure_cycles(scene: bpy.types.Scene) -> dict:
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    cycles_available = False
    try:
        scene.render.engine = "CYCLES"
        cycles_available = True
    except TypeError:
        pass
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.render.use_file_extension = True
    scene.render.use_compositing = False
    scene.render.use_sequencer = False
    scene.view_settings.view_transform = "AgX"
    scene.view_settings.look = "AgX - Medium High Contrast"
    if cycles_available:
        scene.cycles.samples = 512
        scene.cycles.use_denoising = False
        scene.cycles.seed = 4831
        scene.cycles.max_bounces = 10
        scene.cycles.diffuse_bounces = 4
        scene.cycles.glossy_bounces = 4
        scene.cycles.transmission_bounces = 4
        scene.cycles.transparent_max_bounces = 4
        scene.cycles.volume_bounces = 0
        scene.cycles.use_adaptive_sampling = False
        try:
            preferences = bpy.context.preferences.addons["cycles"].preferences
            preferences.compute_device_type = "METAL"
            preferences.get_devices()
            for device in preferences.devices:
                device.use = device.type in {"METAL", "GPU"}
            scene.cycles.device = "GPU"
        except (KeyError, TypeError, RuntimeError):
            scene.cycles.device = "CPU"
    return {
        "engine": "cycles" if cycles_available else "unavailable",
        "samples": 512,
        "denoising": False,
        "seed": 4831,
        "device": scene.cycles.device if cycles_available else None,
        "bounces": {"max": 10, "diffuse": 4, "glossy": 4, "transmission": 4, "transparent": 4, "volume": 0},
        "viewTransform": "AgX",
        "look": scene.view_settings.look,
    }


def configure_camera(scene: bpy.types.Scene) -> bpy.types.Object:
    camera_data = bpy.data.cameras.new("Experiment 1 calibrated camera")
    camera = bpy.data.objects.new("Experiment 1 calibrated camera", camera_data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    camera_data.type = "PERSP"
    camera_data.sensor_fit = "HORIZONTAL"
    camera_data.sensor_width = 36
    camera_data.lens = 910 * camera_data.sensor_width / 1280
    camera_data.shift_x = 0
    camera_data.shift_y = 0
    camera_data.clip_start = 0.05
    camera_data.clip_end = 50
    return camera


def set_camera(camera: bpy.types.Object, pose: dict) -> None:
    camera.location = three_point(pose["position"])
    target = three_point(pose["target"])
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def object_identity(obj: bpy.types.Object) -> tuple[str | None, str | None]:
    object_id = obj.get("cev_object_id")
    part_id = obj.get("cev_part_id")
    if not object_id and ":" in obj.name:
        object_id, part_id = obj.name.split(":", 1)
    return object_id, part_id


def configure_detail(detail: str) -> None:
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH":
            continue
        object_id, part_id = object_identity(obj)
        visible = detail == "detailed" or object_id in {"room-shell", "metal-lamp"} or part_id in SIMPLE_PARTS.get(object_id, set())
        obj.hide_render = not visible
        obj.hide_viewport = not visible


def add_light(scene: bpy.types.Scene, name: str, kind: str, position: list[float], energy: float, color: tuple[float, float, float], size: float = 0.5) -> bpy.types.Object:
    data = bpy.data.lights.new(name, kind)
    data.energy = energy
    data.color = color
    if kind == "AREA":
        data.shape = "DISK"
        data.size = size
    obj = bpy.data.objects.new(name, data)
    obj.location = three_point(position)
    scene.collection.objects.link(obj)
    return obj


def configure_lighting(scene: bpy.types.Scene, condition: str) -> dict[str, bpy.types.Object]:
    for obj in [item for item in scene.objects if item.type == "LIGHT"]:
        bpy.data.objects.remove(obj, do_unlink=True)
    world = scene.world or bpy.data.worlds.new("Experiment 1 world")
    scene.world = world
    world.use_nodes = True
    background = world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.055, 0.065, 0.08, 1)
    background.inputs["Strength"].default_value = 0.12 if condition == "ordinary-environment" else 0.035
    directional = condition == "directional-challenge"
    key = add_light(scene, "room-key", "AREA", [-1.7, 2.62, -1.45], 1450 if directional else 760, (1, 0.91, 0.78), 0.42 if directional else 1.25)
    key.rotation_euler = (three_point([0.35, 1.1, 0.15]) - key.location).to_track_quat("-Z", "Y").to_euler()
    fill = add_light(scene, "room-fill", "AREA", [2.35, 2.35, 1.35], 45 if directional else 310, (0.67, 0.78, 1), 1.5)
    fill.rotation_euler = (three_point([0, 1, 0]) - fill.location).to_track_quat("-Z", "Y").to_euler()
    lamp = add_light(scene, "lamp-light", "POINT", [-2.12, 1.72, 1.58], 65 if directional else 105, (1, 0.58, 0.31))
    lamp.data.shadow_soft_size = 0.18
    return {"room-key": key, "room-fill": fill, "lamp-light": lamp}


def lighting_settings(condition: str, edit_variant: str) -> dict:
    """Return the declared settings that correspond exactly to configure_lighting/apply_edit."""
    directional = condition == "directional-challenge"
    key_position = [2.4, 2.5, -1.8] if edit_variant == "light-moved" else [-1.7, 2.62, -1.45]
    key_target = [0, 0.9, 0] if edit_variant == "light-moved" else [0.35, 1.1, 0.15]
    return {
        "world": {"colorLinearRgb": [0.055, 0.065, 0.08], "strength": 0.035 if directional else 0.12},
        "lights": [
            {"id": "room-key", "type": "area-disk", "position": key_position, "target": key_target, "energyW": 1450 if directional else 760, "colorLinearRgb": [1, 0.91, 0.78], "sizeM": 0.42 if directional else 1.25},
            {"id": "room-fill", "type": "area-disk", "position": [2.35, 2.35, 1.35], "target": [0, 1, 0], "energyW": 45 if directional else 310, "colorLinearRgb": [0.67, 0.78, 1], "sizeM": 1.5},
            {"id": "lamp-light", "type": "point", "position": [-2.12, 1.72, 1.58], "energyW": 65 if directional else 105, "colorLinearRgb": [1, 0.58, 0.31], "radiusM": 0.18},
        ],
    }


def snapshot_objects() -> dict[str, Matrix]:
    return {obj.name_full: obj.matrix_world.copy() for obj in bpy.context.scene.objects if obj.type == "MESH"}


def restore_objects(snapshot: dict[str, Matrix]) -> None:
    for name, matrix in snapshot.items():
        obj = bpy.data.objects.get(name)
        if obj:
            obj.matrix_world = matrix.copy()


def apply_edit(edit_variant: str, lights: dict[str, bpy.types.Object]) -> None:
    chair_objects = [obj for obj in bpy.context.scene.objects if object_identity(obj)[0] == "chair-a"]
    if edit_variant == "chair-translated":
        delta = three_point([0.32, 0, 0.2]) - three_point([0, 0, 0])
        for obj in chair_objects:
            obj.location += delta
    elif edit_variant == "chair-rotated":
        pivot = three_point([-1.12, 0, -0.15])
        rotation_three = Euler((0, 0.7, 0), "XYZ").to_matrix().to_4x4()
        rotation = THREE_TO_BLENDER @ rotation_three @ THREE_TO_BLENDER.inverted()
        transform = Matrix.Translation(pivot) @ rotation @ Matrix.Translation(-pivot)
        for obj in chair_objects:
            obj.matrix_world = transform @ obj.matrix_world
    elif edit_variant == "light-moved":
        lights["room-key"].location = three_point([2.4, 2.5, -1.8])
        lights["room-key"].rotation_euler = (three_point([0, 0.9, 0]) - lights["room-key"].location).to_track_quat("-Z", "Y").to_euler()


def save_render(scene: bpy.types.Scene, output_base: Path) -> tuple[str, str]:
    output_base.parent.mkdir(parents=True, exist_ok=True)
    scene.render.image_settings.file_format = "OPEN_EXR"
    scene.render.image_settings.color_depth = "32"
    scene.render.image_settings.exr_codec = "ZIP"
    linear_path = output_base.with_suffix(".exr")
    bpy.data.images["Render Result"].save_render(filepath=str(linear_path), scene=scene)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_depth = "8"
    scene.render.image_settings.color_mode = "RGBA"
    display_path = output_base.with_suffix(".png")
    bpy.data.images["Render Result"].save_render(filepath=str(display_path), scene=scene)
    return str(display_path), str(linear_path)


def render_sample(scene: bpy.types.Scene, camera: bpy.types.Object, pose: dict, output_base: Path) -> tuple[str, str]:
    display_path = output_base.with_suffix(".png")
    linear_path = output_base.with_suffix(".exr")
    if display_path.exists() and linear_path.exists():
        return str(display_path), str(linear_path)
    set_camera(camera, pose)
    scene.render.filepath = str(output_base)
    bpy.ops.render.render()
    return save_render(scene, output_base)


def main() -> None:
    args = arguments()
    schedule = json.loads(Path(args.schedule).read_text())
    output_dir = Path(args.output_dir)
    scene = bpy.context.scene
    renderer = configure_cycles(scene)
    if renderer["engine"] != "cycles":
        raise RuntimeError("Pinned Blender build does not expose Cycles")
    camera = configure_camera(scene)
    base_objects = snapshot_objects()
    records = []
    rendered = 0
    for candidate_id, detail in [("b2-cycles", "simple"), ("b3-cycles", "detailed")]:
        configure_detail(detail)
        for condition in schedule["conditions"]:
            for edit_variant in schedule["editVariants"]:
                if args.limit and rendered >= args.limit:
                    break
                restore_objects(base_objects)
                lights = configure_lighting(scene, condition)
                apply_edit(edit_variant, lights)
                output_id = f"{candidate_id}-{condition}-{edit_variant}"
                record = {"id": output_id, "candidateId": candidate_id, "conditionId": condition, "editVariantId": edit_variant, "includePaths": bool(args.full and edit_variant == "base"), "rendererSettings": renderer, "lightingSettings": lighting_settings(condition, edit_variant), "displayFiles": [], "linearFiles": []}
                for viewpoint in schedule["viewpoints"]:
                    if args.limit and rendered >= args.limit:
                        break
                    base = output_dir / candidate_id / output_id / "stills" / viewpoint["id"]
                    display, linear = render_sample(scene, camera, viewpoint["pose"], base)
                    record["displayFiles"].append(display)
                    record["linearFiles"].append(linear)
                    rendered += 1
                    print(f"Rendered {rendered}: {output_id} / {viewpoint['id']}", flush=True)
                if record["includePaths"] and (not args.limit or rendered < args.limit):
                    for path_record in schedule["paths"]:
                        for sample in path_record["samples"]:
                            if args.limit and rendered >= args.limit:
                                break
                            base = output_dir / candidate_id / output_id / path_record["id"] / f"{sample['sampleIndex']:04d}"
                            display, linear = render_sample(scene, camera, sample["pose"], base)
                            record["displayFiles"].append(display)
                            record["linearFiles"].append(linear)
                            rendered += 1
                        if args.limit and rendered >= args.limit:
                            break
                records.append(record)
            if args.limit and rendered >= args.limit:
                break
        if args.limit and rendered >= args.limit:
            break
    (output_dir / "render-records.json").write_text(json.dumps({"renderer": renderer, "records": records}, indent=2) + "\n")


if __name__ == "__main__":
    main()
