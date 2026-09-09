"""Build the repository-owned Experiment 1 Blender source and browser GLB."""

from __future__ import annotations

import hashlib
import json
import math
import struct
import sys
import zlib
from pathlib import Path

import bpy
from mathutils import Euler, Matrix, Vector


REPO = Path(__file__).resolve().parents[1]
FIXTURE_PATH = REPO / "app" / "visual-lab" / "experiment-one-fixture.json"
DEFAULT_OUTPUT = REPO / "public" / "visual-lab" / "experiment-1" / "assets"
THREE_TO_BLENDER = Matrix(((1, 0, 0, 0), (0, 0, -1, 0), (0, 1, 0, 0), (0, 0, 0, 1)))


def arguments() -> Path:
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    if "--output-dir" in values:
        return Path(values[values.index("--output-dir") + 1]).resolve()
    return DEFAULT_OUTPUT


def srgb(hex_value: str) -> tuple[float, float, float, float]:
    value = hex_value.lstrip("#")
    return tuple(int(value[index : index + 2], 16) / 255 for index in (0, 2, 4)) + (1.0,)


def noise(pattern: str, x: int, y: int) -> float:
    hashed = ((x * 73856093) ^ (y * 19349663)) & 0xFFFFFFFF
    random_value = ((hashed & 255) / 255) - 0.5
    if pattern == "wood":
        return math.sin((x + random_value * 1.5) * 0.48) * 0.15 + random_value * 0.05
    if pattern == "weave":
        return (0.07 if (x % 4 < 2) == (y % 4 < 2) else -0.07) + random_value * 0.025
    if pattern == "brushed":
        return math.sin(y * 2.7) * 0.035 + random_value * 0.025
    if pattern == "plaster":
        return random_value * 0.075
    if pattern == "paper":
        return random_value * 0.035
    return random_value * 0.018


def make_texture_files(output: Path, name: str, definition: dict) -> tuple[Path, Path]:
    texture_dir = output / "textures"
    texture_dir.mkdir(parents=True, exist_ok=True)
    size = 64
    base = srgb(definition["baseColor"])
    color_pixels = bytearray()
    rough_pixels = bytearray()
    for y in range(size):
        for x in range(size):
            variation = noise(definition["pattern"], x, y)
            color_pixels.extend(round(255 * max(0, min(1, channel * (1 + variation)))) for channel in base[:3])
            color_pixels.append(255)
            roughness = max(0.04, min(1, definition["roughness"] - variation * 0.35))
            rough_pixels.extend([round(255 * roughness)] * 3 + [255])
    paths = []
    for role, pixels in [
        ("base-color", color_pixels),
        ("roughness", rough_pixels),
    ]:
        path = texture_dir / f"{name}-{role}.png"
        write_rgba_png(path, size, size, pixels)
        paths.append(path)
    return paths[0], paths[1]


def write_rgba_png(path: Path, width: int, height: int, pixels: bytearray) -> None:
    def chunk(kind: bytes, payload: bytes) -> bytes:
        return struct.pack(">I", len(payload)) + kind + payload + struct.pack(">I", zlib.crc32(kind + payload))

    stride = width * 4
    rows = b"".join(b"\0" + bytes(pixels[offset : offset + stride]) for offset in range(0, len(pixels), stride))
    header = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", header) + chunk(b"IDAT", zlib.compress(rows, 9)) + chunk(b"IEND", b""))


def material(name: str, definition: dict, output: Path) -> bpy.types.Material:
    base_path, rough_path = make_texture_files(output, name, definition)
    result = bpy.data.materials.new(name=f"experiment-1-{name}")
    result.use_nodes = True
    result.diffuse_color = srgb(definition["baseColor"])
    result.metallic = definition["metalness"]
    result.roughness = definition["roughness"]
    result["cev_texture_scale_meters"] = definition["textureScaleMeters"]
    nodes = result.node_tree.nodes
    links = result.node_tree.links
    nodes.clear()
    output_node = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    shader.inputs["Metallic"].default_value = definition["metalness"]
    shader.inputs["Roughness"].default_value = definition["roughness"]
    base_texture = nodes.new("ShaderNodeTexImage")
    base_texture.image = bpy.data.images.load(str(base_path), check_existing=True)
    rough_texture = nodes.new("ShaderNodeTexImage")
    rough_texture.image = bpy.data.images.load(str(rough_path), check_existing=True)
    rough_texture.image.colorspace_settings.name = "Non-Color"
    bump = nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.16
    bump.inputs["Distance"].default_value = min(0.004, definition["textureScaleMeters"] * 0.08)
    links.new(base_texture.outputs["Color"], shader.inputs["Base Color"])
    links.new(rough_texture.outputs["Color"], shader.inputs["Roughness"])
    links.new(rough_texture.outputs["Color"], bump.inputs["Height"])
    links.new(bump.outputs["Normal"], shader.inputs["Normal"])
    links.new(shader.outputs["BSDF"], output_node.inputs["Surface"])
    return result


def resolved_object(source: dict, fixture: dict) -> dict:
    if not source.get("copyOf"):
        return source
    parent = next(item for item in fixture["objects"] if item["id"] == source["copyOf"])
    return {**parent, **source}


def add_part(record: dict, part: dict, material_value: bpy.types.Material) -> bpy.types.Object:
    size = part["size"]
    if part["shape"] == "box":
        bpy.ops.mesh.primitive_cube_add(size=1)
        obj = bpy.context.object
        obj.dimensions = (size[0], size[2], size[1])
        bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    elif part["shape"] == "cylinder":
        bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=size[0] / 2, depth=size[1])
        obj = bpy.context.object
    else:
        bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=size[0], radius2=size[0] * 0.44, depth=size[1])
        obj = bpy.context.object
    total_position = Vector((
        part["position"][0] + record["position"][0],
        part["position"][1] + record["position"][1],
        part["position"][2] + record["position"][2],
    ))
    obj.location = (THREE_TO_BLENDER @ total_position.to_4d()).to_3d()
    three_rotation = Euler(part.get("rotation", (0, 0, 0)), "XYZ").to_matrix().to_4x4()
    obj.rotation_mode = "QUATERNION"
    obj.rotation_quaternion = (THREE_TO_BLENDER @ three_rotation @ THREE_TO_BLENDER.inverted()).to_quaternion()
    obj.name = f"{record['id']}:{part['id']}"
    obj.data.materials.append(material_value)
    apply_metric_uvs(obj, material_value["cev_texture_scale_meters"])
    obj["cev_object_id"] = record["id"]
    obj["cev_part_id"] = part["id"]
    if part.get("bevel", 0) > 0:
        modifier = obj.modifiers.new(name="Physical edge radius", type="BEVEL")
        modifier.width = min(part["bevel"], min(size) / 2)
        modifier.segments = 4
    return obj


def apply_metric_uvs(obj: bpy.types.Object, scale_meters: float) -> None:
    mesh = obj.data
    uv_layer = mesh.uv_layers.active or mesh.uv_layers.new(name="Metric PBR UV")
    for polygon in mesh.polygons:
        normal = polygon.normal
        axis = max(range(3), key=lambda index: abs(normal[index]))
        for loop_index in polygon.loop_indices:
            point = mesh.vertices[mesh.loops[loop_index].vertex_index].co
            if axis == 0:
                u, v = point.y, point.z
            elif axis == 1:
                u, v = point.x, point.z
            else:
                u, v = point.x, point.y
            uv_layer.data[loop_index].uv = (u / scale_meters, v / scale_meters)


def build_scene(fixture: dict, output: Path) -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for datablocks in (bpy.data.materials, bpy.data.images, bpy.data.collections):
        for block in list(datablocks):
            if block.users == 0:
                datablocks.remove(block)

    materials = {name: material(name, value, output) for name, value in fixture["materials"].items()}
    room_collection = bpy.data.collections.new("Experiment 1 detailed room")
    bpy.context.scene.collection.children.link(room_collection)
    for source in fixture["objects"]:
        record = resolved_object(source, fixture)
        object_collection = bpy.data.collections.new(record["id"])
        room_collection.children.link(object_collection)
        for part in record["parts"]:
            obj = add_part(record, part, materials[part["material"]])
            for collection in list(obj.users_collection):
                collection.objects.unlink(obj)
            object_collection.objects.link(obj)

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT"
    scene.render.resolution_x = 1280
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.unit_settings.system = "METRIC"
    scene.unit_settings.scale_length = 1
    scene["cev_fixture_kind"] = fixture["kind"]
    scene["cev_fixture_version"] = fixture["version"]
    scene["cev_fixture_source_sha256"] = hashlib.sha256(FIXTURE_PATH.read_bytes()).hexdigest()
    scene["cev_blender_build"] = bpy.app.build_hash.decode() if isinstance(bpy.app.build_hash, bytes) else str(bpy.app.build_hash)


def main() -> None:
    output = arguments()
    output.mkdir(parents=True, exist_ok=True)
    for generated in ("experiment-1-room.blend", "experiment-1-room.blend1", "experiment-1-room.glb"):
        (output / generated).unlink(missing_ok=True)
    fixture = json.loads(FIXTURE_PATH.read_text(encoding="utf-8"))
    build_scene(fixture, output)
    blend_path = output / "experiment-1-room.blend"
    bpy.ops.wm.save_as_mainfile(filepath=str(blend_path), compress=True)
    for obj in bpy.context.scene.objects:
        obj.select_set(obj.type == "MESH")
    bpy.context.view_layer.objects.active = next(obj for obj in bpy.context.scene.objects if obj.type == "MESH")
    bpy.ops.export_scene.gltf(
        filepath=str(output / "experiment-1-room.glb"),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )
    print(f"Built Experiment 1 assets in {output}")


if __name__ == "__main__":
    main()
