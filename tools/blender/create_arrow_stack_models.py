from __future__ import annotations

import math
from pathlib import Path

import bpy


PROJECT_ROOT = Path("/home/nick/projectnova-master")
OUT_ROOT = PROJECT_ROOT / "client/public/assets/models/arrows"


TIERS = {
    "Bronze": (0.52, 0.30, 0.12, 1.0),
    "Iron": (0.58, 0.58, 0.55, 1.0),
    "Steel": (0.38, 0.40, 0.41, 1.0),
    "Mithril": (0.10, 0.46, 0.60, 1.0),
    "BlackBronze": (0.045, 0.014, 0.005, 1.0),
}


STACK_COUNTS = {
    "1": 1,
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6Plus": 7,
}


STACK_PLACEMENTS = [
    ((0.00, 0.00, 0.000), 0.00, 0.00),
    ((0.01, 0.055, 0.018), 0.13, 0.55),
    ((-0.02, -0.055, 0.036), -0.15, 1.10),
    ((0.035, 0.018, 0.054), 0.28, 1.65),
    ((-0.035, -0.018, 0.072), -0.30, 2.20),
    ((0.02, -0.075, 0.090), 0.48, 2.75),
    ((-0.02, 0.075, 0.108), -0.48, 3.30),
]


def set_input(node, names: tuple[str, ...], value) -> None:
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def make_material(name: str, color: tuple[float, float, float, float], roughness: float = 0.9) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        set_input(bsdf, ("Base Color",), color)
        set_input(bsdf, ("Roughness",), roughness)
        set_input(bsdf, ("Metallic",), 0.0)
        set_input(bsdf, ("Specular IOR Level", "Specular"), 0.18)
    return mat


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.objects):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def make_fletch_mesh(name: str, vertical: bool, mat: bpy.types.Material) -> bpy.types.Object:
    # A small triangular fin, authored as a low-poly prism so thumbnails read
    # as "arrow" even when the shaft is only a few pixels wide.
    x0, x1 = -0.47, -0.28
    t = 0.012
    h = 0.065
    if vertical:
        verts = [
            (x0, -t, 0.000), (x0, t, 0.000), (x1, -t, 0.000), (x1, t, 0.000),
            (x0, -t, h), (x0, t, h), (x1, -t, h * 0.45), (x1, t, h * 0.45),
        ]
    else:
        verts = [
            (x0, 0.000, -t), (x0, 0.000, t), (x1, 0.000, -t), (x1, 0.000, t),
            (x0, h, -t), (x0, h, t), (x1, h * 0.45, -t), (x1, h * 0.45, t),
        ]
    faces = [
        (0, 2, 3, 1),
        (4, 5, 7, 6),
        (0, 1, 5, 4),
        (2, 6, 7, 3),
        (0, 4, 6, 2),
        (1, 3, 7, 5),
    ]
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    for poly in mesh.polygons:
        poly.use_smooth = False
    return obj


def create_arrow(
    name: str,
    materials: dict[str, bpy.types.Material],
    location: tuple[float, float, float],
    yaw: float,
    roll: float,
) -> list[bpy.types.Object]:
    parent = bpy.data.objects.new(name, None)
    bpy.context.collection.objects.link(parent)
    parent.location = location
    parent.rotation_euler = (roll, 0.0, yaw)

    parts: list[bpy.types.Object] = []

    bpy.ops.mesh.primitive_cylinder_add(
        vertices=6,
        radius=0.016,
        depth=0.84,
        location=(0.0, 0.0, 0.0),
        rotation=(0.0, math.pi / 2.0, 0.0),
    )
    shaft = bpy.context.object
    shaft.name = f"{name}_shaft"
    shaft.data.materials.append(materials["shaft"])
    parts.append(shaft)

    bpy.ops.mesh.primitive_cone_add(
        vertices=4,
        radius1=0.052,
        radius2=0.0,
        depth=0.15,
        location=(0.485, 0.0, 0.0),
        rotation=(0.0, math.pi / 2.0, math.pi / 4.0),
    )
    head = bpy.context.object
    head.name = f"{name}_head"
    head.data.materials.append(materials["head"])
    parts.append(head)

    fletch_vertical = make_fletch_mesh(f"{name}_fletch_v", True, materials["feather"])
    fletch_horizontal = make_fletch_mesh(f"{name}_fletch_h", False, materials["feather"])
    parts.extend([fletch_vertical, fletch_horizontal])

    for obj in parts:
        obj.parent = parent
        obj.matrix_parent_inverse = parent.matrix_world.inverted()
        if hasattr(obj.data, "polygons"):
            for poly in obj.data.polygons:
                poly.use_smooth = False

    return [parent, *parts]


def create_arrow_stack(tier: str, head_color: tuple[float, float, float, float], count: int) -> list[bpy.types.Object]:
    clear_scene()
    materials = {
        "shaft": make_material("Arrow_wood_shaft", (0.46, 0.27, 0.12, 1.0), 0.94),
        "feather": make_material("Arrow_feather_vellum", (0.78, 0.70, 0.54, 1.0), 0.96),
        "head": make_material(f"{tier}_arrow_tip", head_color, 0.72),
    }

    objects: list[bpy.types.Object] = []
    for index in range(count):
        loc, yaw, roll = STACK_PLACEMENTS[index]
        objects.extend(create_arrow(f"{tier}Arrow_{index + 1}", materials, loc, yaw, roll))

    bpy.ops.object.light_add(type="AREA", location=(0, -2.0, 2.2))
    light = bpy.context.object
    light.name = "ArrowStack_Key_Light"
    light.data.energy = 220
    light.data.size = 2.4

    bpy.ops.object.camera_add(location=(0, -2.2, 1.35), rotation=(1.05, 0, 0))
    bpy.context.scene.camera = bpy.context.object
    bpy.context.scene.view_settings.view_transform = "Standard"
    bpy.context.scene.unit_settings.system = "METRIC"

    return objects


def export_selection(objects: list[bpy.types.Object], out_path: Path) -> None:
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
    for tier, color in TIERS.items():
        for suffix, count in STACK_COUNTS.items():
            objects = create_arrow_stack(tier, color, count)
            out_path = OUT_ROOT / "stacks" / f"{tier}ArrowStack{suffix}.glb"
            export_selection(objects, out_path)

        objects = create_arrow_stack(tier, color, 1)
        export_selection(objects, OUT_ROOT / f"{tier}Arrow.glb")


if __name__ == "__main__":
    main()
