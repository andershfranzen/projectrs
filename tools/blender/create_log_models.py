from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Vector


PROJECT_ROOT = Path("/home/nick/projectnova-master")
OUT_ROOT = PROJECT_ROOT / "client/public/assets/models/logs"
BLEND_OUT = PROJECT_ROOT / "tools/blender/evilquest_logs.blend"

SEGMENTS = 16
LENGTH = 1.0
RADIUS = 0.26


LOG_TYPES = {
    "Log": {
        "bark": (0.42, 0.29, 0.10, 1.0),
        "bark_dark": (0.18, 0.12, 0.04, 1.0),
        "bark_light": (0.66, 0.45, 0.16, 1.0),
        "wood": (0.76, 0.57, 0.22, 1.0),
        "ring": (0.50, 0.34, 0.09, 1.0),
    },
    "OakLog": {
        "bark": (0.28, 0.15, 0.06, 1.0),
        "bark_dark": (0.12, 0.07, 0.03, 1.0),
        "bark_light": (0.46, 0.27, 0.11, 1.0),
        "wood": (0.78, 0.56, 0.20, 1.0),
        "ring": (0.48, 0.31, 0.08, 1.0),
    },
    "WillowLog": {
        "bark": (0.34, 0.37, 0.18, 1.0),
        "bark_dark": (0.16, 0.18, 0.09, 1.0),
        "bark_light": (0.52, 0.54, 0.27, 1.0),
        "wood": (0.66, 0.59, 0.43, 1.0),
        "ring": (0.43, 0.36, 0.22, 1.0),
    },
    "MapleLog": {
        "bark": (0.72, 0.27, 0.06, 1.0),
        "bark_dark": (0.34, 0.12, 0.03, 1.0),
        "bark_light": (0.92, 0.42, 0.13, 1.0),
        "wood": (0.78, 0.60, 0.29, 1.0),
        "ring": (0.52, 0.33, 0.12, 1.0),
    },
    "YewLog": {
        "bark": (0.20, 0.35, 0.18, 1.0),
        "bark_dark": (0.08, 0.16, 0.09, 1.0),
        "bark_light": (0.35, 0.52, 0.24, 1.0),
        "wood": (0.70, 0.55, 0.30, 1.0),
        "ring": (0.42, 0.30, 0.14, 1.0),
    },
    "MysticLog": {
        "bark": (0.13, 0.09, 0.18, 1.0),
        "bark_dark": (0.05, 0.04, 0.08, 1.0),
        "bark_light": (0.26, 0.17, 0.35, 1.0),
        "wood": (0.56, 0.28, 0.68, 1.0),
        "ring": (0.35, 0.14, 0.46, 1.0),
        "rune": (0.72, 0.28, 1.0, 1.0),
    },
}


def set_input(node, names: tuple[str, ...], value) -> None:
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def make_material(
    name: str,
    color: tuple[float, float, float, float],
    roughness: float = 0.92,
    emissive: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        set_input(bsdf, ("Base Color",), color)
        set_input(bsdf, ("Roughness",), roughness)
        set_input(bsdf, ("Metallic",), 0.0)
        set_input(bsdf, ("Specular IOR Level", "Specular"), 0.18)
        if emissive > 0:
            set_input(bsdf, ("Emission Color",), color)
            set_input(bsdf, ("Emission Strength",), emissive)
    return mat


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.objects):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


class MeshBuilder:
    def __init__(self) -> None:
        self.verts: list[tuple[float, float, float]] = []
        self.faces: list[tuple[int, ...]] = []
        self.material_indices: list[int] = []

    def add_face(self, indices: tuple[int, ...], mat_index: int) -> None:
        self.faces.append(indices)
        self.material_indices.append(mat_index)

    def add_ring_disc(self, x: float, outward: int, radii: list[float], mat_a: int, mat_b: int) -> None:
        center = len(self.verts)
        self.verts.append((x, 0.0, 0.0))
        rings: list[list[int]] = []
        for radius in radii:
            ring = []
            for i in range(SEGMENTS):
                angle = 2.0 * math.pi * i / SEGMENTS
                # Slight wobble keeps the cut surface handmade and stops the
                # rings from reading as perfect UI circles.
                wobble = 1.0 + 0.045 * math.sin(i * 1.7 + radius * 13.0)
                y = math.cos(angle) * radius * wobble
                z = math.sin(angle) * radius * wobble
                ring.append(len(self.verts))
                self.verts.append((x, y, z))
            rings.append(ring)

        first = rings[0]
        for i in range(SEGMENTS):
            j = (i + 1) % SEGMENTS
            face = (center, first[i], first[j]) if outward > 0 else (center, first[j], first[i])
            self.add_face(face, mat_a)

        for ridx in range(1, len(rings)):
            inner = rings[ridx - 1]
            outer = rings[ridx]
            mat = mat_b if ridx % 2 else mat_a
            for i in range(SEGMENTS):
                j = (i + 1) % SEGMENTS
                face = (inner[i], outer[i], outer[j], inner[j]) if outward > 0 else (inner[i], inner[j], outer[j], outer[i])
                self.add_face(face, mat)

    def add_bark_side(self) -> None:
        left: list[int] = []
        right: list[int] = []
        for x, store in ((-LENGTH / 2.0, left), (LENGTH / 2.0, right)):
            for i in range(SEGMENTS):
                angle = 2.0 * math.pi * i / SEGMENTS
                radius = RADIUS * (1.0 + 0.04 * math.sin(i * 2.3))
                y = math.cos(angle) * radius
                z = math.sin(angle) * radius
                store.append(len(self.verts))
                self.verts.append((x, y, z))

        for i in range(SEGMENTS):
            j = (i + 1) % SEGMENTS
            mat = 0 if i % 3 else 1
            self.add_face((left[i], right[i], right[j], left[j]), mat)

    def build(self, name: str, materials: list[bpy.types.Material]) -> bpy.types.Object:
        mesh = bpy.data.meshes.new(f"{name}_mesh")
        mesh.from_pydata(self.verts, [], self.faces)
        mesh.update(calc_edges=True)
        obj = bpy.data.objects.new(name, mesh)
        bpy.context.collection.objects.link(obj)
        for mat in materials:
            obj.data.materials.append(mat)
        for poly, mat_index in zip(mesh.polygons, self.material_indices):
            poly.material_index = mat_index
            poly.use_smooth = False
        return obj


def add_ridge(
    name: str,
    materials: dict[str, bpy.types.Material],
    angle: float,
    x_offset: float,
    length: float,
    width: float,
    height: float,
    material_name: str,
) -> bpy.types.Object:
    radius = RADIUS + height * 0.35
    y = math.cos(angle) * radius
    z = math.sin(angle) * radius
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x_offset, y, z))
    ridge = bpy.context.object
    ridge.name = name
    ridge.dimensions = (length, width, height)
    ridge.rotation_euler = (angle, 0.0, 0.0)
    ridge.data.materials.append(materials[material_name])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return ridge


def add_rune_segment(
    name: str,
    materials: dict[str, bpy.types.Material],
    x: float,
    angle: float,
    length: float,
    tilt: float,
) -> bpy.types.Object:
    radius = RADIUS + 0.024
    y = math.cos(angle) * radius
    z = math.sin(angle) * radius
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=(x, y, z))
    rune = bpy.context.object
    rune.name = name
    rune.dimensions = (length, 0.018, 0.012)
    rune.rotation_euler = (angle, 0.0, tilt)
    rune.data.materials.append(materials["rune"])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return rune


def create_log(log_name: str, palette: dict[str, tuple[float, float, float, float]]) -> list[bpy.types.Object]:
    clear_scene()

    materials = {
        "bark": make_material(f"{log_name}_bark", palette["bark"]),
        "bark_dark": make_material(f"{log_name}_bark_dark", palette["bark_dark"]),
        "bark_light": make_material(f"{log_name}_bark_light", palette["bark_light"]),
        "wood": make_material(f"{log_name}_cut_wood", palette["wood"]),
        "ring": make_material(f"{log_name}_growth_rings", palette["ring"]),
    }
    if "rune" in palette:
        materials["rune"] = make_material(f"{log_name}_rune_glow", palette["rune"], 0.55, emissive=1.1)

    builder = MeshBuilder()
    builder.add_bark_side()
    builder.add_ring_disc(-LENGTH / 2.0 - 0.002, -1, [0.045, 0.095, 0.145, 0.198, RADIUS * 0.95], 3, 4)
    builder.add_ring_disc(LENGTH / 2.0 + 0.002, 1, [0.045, 0.095, 0.145, 0.198, RADIUS * 0.95], 3, 4)
    trunk = builder.build(log_name, [materials["bark"], materials["bark_dark"], materials["bark_light"], materials["wood"], materials["ring"]])

    objects: list[bpy.types.Object] = [trunk]
    ridge_specs = [
        (0.33, -0.03, 0.92, 0.032, 0.028, "bark_light"),
        (0.78, 0.03, 0.84, 0.026, 0.024, "bark_dark"),
        (1.16, 0.00, 0.88, 0.028, 0.026, "bark_light"),
        (1.58, -0.05, 0.78, 0.024, 0.020, "bark_dark"),
        (2.03, 0.06, 0.82, 0.028, 0.024, "bark_light"),
        (2.48, -0.02, 0.74, 0.024, 0.020, "bark_dark"),
    ]
    for idx, (angle, x, length, width, height, material_name) in enumerate(ridge_specs, start=1):
        objects.append(add_ridge(f"{log_name}_ridge_{idx}", materials, angle, x, length, width, height, material_name))

    if "rune" in materials:
        rune_specs = [
            (-0.18, 1.02, 0.18, 0.70),
            (0.04, 0.82, 0.14, -0.55),
            (0.22, 1.21, 0.16, 0.38),
            (0.34, 0.70, 0.10, 1.05),
        ]
        for idx, (x, angle, length, tilt) in enumerate(rune_specs, start=1):
            objects.append(add_rune_segment(f"{log_name}_rune_{idx}", materials, x, angle, length, tilt))

    # Rotate the authored log so the default thumbnail camera sees the front
    # growth rings and the bark ridges at the same time.
    root = bpy.data.objects.new(f"{log_name}_Root", None)
    bpy.context.collection.objects.link(root)
    for obj in objects:
        obj.parent = root
    root.rotation_euler = (0.0, 0.0, -0.12)
    objects.insert(0, root)

    bpy.ops.object.light_add(type="AREA", location=(0, -2.0, 2.4))
    light = bpy.context.object
    light.name = f"{log_name}_Key_Light"
    light.data.energy = 260
    light.data.size = 2.5

    bpy.ops.object.camera_add(location=(0, -2.0, 1.25), rotation=(1.04, 0.0, 0.0))
    bpy.context.scene.camera = bpy.context.object
    bpy.context.scene.view_settings.view_transform = "Standard"
    bpy.context.scene.unit_settings.system = "METRIC"
    return objects


def export_objects(objects: list[bpy.types.Object], out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = next((obj for obj in objects if obj.type == "MESH"), objects[0])
    bpy.ops.export_scene.gltf(
        filepath=str(out_path),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
        export_yup=True,
    )


def main() -> None:
    for name, palette in LOG_TYPES.items():
        objects = create_log(name, palette)
        export_objects(objects, OUT_ROOT / f"{name}.glb")

    clear_scene()
    for idx, name in enumerate(LOG_TYPES.keys()):
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=str(OUT_ROOT / f"{name}.glb"))
        imported = [obj for obj in bpy.data.objects if obj not in before]
        roots = [obj for obj in imported if obj.parent is None]
        offset = Vector(((idx % 3) * 1.35, -(idx // 3) * 0.9, 0.0))
        for root in roots:
            root.location += offset

        bpy.ops.object.text_add(location=(offset.x, offset.y - 0.48, -0.28), rotation=(math.radians(75), 0, 0))
        label = bpy.context.object
        label.name = f"{name}_Label"
        label.data.body = name.replace("Log", " Log") if name != "Log" else "Log"
        label.data.align_x = "CENTER"
        label.data.align_y = "CENTER"
        label.data.size = 0.12

    bpy.ops.object.light_add(type="AREA", location=(1.35, -2.2, 2.8))
    light = bpy.context.object
    light.name = "Logs_Key_Light"
    light.data.energy = 420
    light.data.size = 3.5

    bpy.ops.object.camera_add(location=(1.35, -3.2, 1.8), rotation=(math.radians(60), 0, 0))
    camera = bpy.context.object
    camera.name = "Logs_Review_Camera"
    camera.data.type = "ORTHO"
    camera.data.ortho_scale = 3.1
    bpy.context.scene.camera = camera
    BLEND_OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_OUT))


if __name__ == "__main__":
    main()
