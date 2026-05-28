from __future__ import annotations

import math
import os
from pathlib import Path

import bpy
from mathutils import Vector


PROJECT_ROOT = Path("/home/nick/projectnova-master")
MODEL_DIR = PROJECT_ROOT / "client/public/assets/models/gems"
SOURCE_BLEND = PROJECT_ROOT / "tools/blender/evilquest_gems.blend"


GEMS = [
    {
        "id": "Sapphire",
        "name": "Sapphire",
        "shape": "brilliant",
        "color": (0.05, 0.22, 0.88),
        "scale": (1.0, 0.95, 1.0),
        "value": 160,
    },
    {
        "id": "Emerald",
        "name": "Emerald",
        "shape": "emerald",
        "color": (0.02, 0.72, 0.34),
        "scale": (1.1, 0.78, 0.86),
        "value": 240,
    },
    {
        "id": "Ruby",
        "name": "Ruby",
        "shape": "brilliant",
        "color": (0.88, 0.04, 0.09),
        "scale": (0.98, 1.02, 1.0),
        "value": 320,
    },
    {
        "id": "Diamond",
        "name": "Diamond",
        "shape": "brilliant",
        "color": (0.78, 0.95, 1.0),
        "scale": (1.02, 1.02, 0.94),
        "value": 500,
    },
    {
        "id": "Amethyst",
        "name": "Amethyst",
        "shape": "cluster",
        "color": (0.55, 0.14, 0.86),
        "scale": (1.0, 1.0, 1.0),
        "value": 120,
    },
    {
        "id": "Topaz",
        "name": "Topaz",
        "shape": "pear",
        "color": (1.0, 0.48, 0.08),
        "scale": (0.92, 1.16, 0.96),
        "value": 180,
    },
    {
        "id": "Opal",
        "name": "Opal",
        "shape": "opal",
        "color": (0.86, 0.96, 0.92),
        "scale": (1.0, 0.82, 0.62),
        "value": 220,
    },
    {
        "id": "Onyx",
        "name": "Onyx",
        "shape": "brilliant",
        "color": (0.02, 0.025, 0.04),
        "scale": (1.02, 1.0, 0.92),
        "value": 260,
    },
]


def clamp(v: float) -> float:
    return max(0.0, min(1.0, v))


def color_variant(color: tuple[float, float, float], factor: float) -> tuple[float, float, float, float]:
    return (
        clamp(color[0] * factor),
        clamp(color[1] * factor),
        clamp(color[2] * factor),
        1.0,
    )


def set_input(node, names: tuple[str, ...], value) -> None:
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def make_material(name: str, color: tuple[float, float, float, float], roughness: float = 0.42) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        set_input(bsdf, ("Base Color",), color)
        set_input(bsdf, ("Roughness",), roughness)
        set_input(bsdf, ("Metallic",), 0.0)
        set_input(bsdf, ("Alpha",), color[3])
        set_input(bsdf, ("Specular IOR Level", "Specular"), 0.72)
    return mat


def make_gem_materials(gem_id: str, color: tuple[float, float, float]) -> list[bpy.types.Material]:
    return [
        make_material(f"{gem_id}_facet_mid", color_variant(color, 1.0), 0.34),
        make_material(f"{gem_id}_facet_light", color_variant(color, 1.45), 0.28),
        make_material(f"{gem_id}_facet_dark", color_variant(color, 0.52), 0.5),
        make_material(f"{gem_id}_facet_flash", color_variant(color, 1.85), 0.22),
    ]


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.images, bpy.data.curves):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def ring_points(count: int, radius: float, z: float, scale_x: float = 1.0, scale_y: float = 1.0, offset: float = 0.0) -> list[tuple[float, float, float]]:
    return [
        (
            math.cos((i / count) * math.tau + offset) * radius * scale_x,
            math.sin((i / count) * math.tau + offset) * radius * scale_y,
            z,
        )
        for i in range(count)
    ]


def assign_materials(mesh: bpy.types.Mesh, pattern: list[int]) -> None:
    for i, poly in enumerate(mesh.polygons):
        poly.material_index = pattern[i % len(pattern)]


def mesh_object(name: str, verts: list[tuple[float, float, float]], faces: list[list[int]], mats: list[bpy.types.Material]) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    for mat in mats:
        mesh.materials.append(mat)
    return obj


def create_root(name: str, location: tuple[float, float, float]) -> bpy.types.Object:
    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.18
    root.location = location
    bpy.context.collection.objects.link(root)
    return root


def create_brilliant(gem: dict, location: tuple[float, float, float]) -> bpy.types.Object:
    mats = make_gem_materials(gem["id"], gem["color"])
    scale_x, scale_y, scale_z = gem["scale"]
    sides = 8
    top = ring_points(sides, 0.23, 0.23 * scale_z, scale_x, scale_y, math.pi / sides)
    crown = ring_points(sides, 0.52, 0.0, scale_x, scale_y)
    bottom = [(0.0, 0.0, -0.36 * scale_z)]
    verts = top + crown + bottom
    bottom_i = len(verts) - 1
    faces: list[list[int]] = [list(range(sides))]
    for i in range(sides):
        j = (i + 1) % sides
        faces.append([i, j, sides + j, sides + i])
    for i in range(sides):
        j = (i + 1) % sides
        faces.append([sides + i, sides + j, bottom_i])

    obj = mesh_object(f"{gem['id']}_gem", verts, faces, mats)
    assign_materials(obj.data, [1, 0, 2, 3, 0, 2])
    root = create_root(gem["id"], location)
    obj.parent = root
    obj.rotation_euler[2] = math.radians(22.5)
    return root


def bevel_rect_points(width: float, depth: float, bevel: float, z: float, sx: float, sy: float) -> list[tuple[float, float, float]]:
    w = width * sx
    d = depth * sy
    b = bevel * min(sx, sy)
    return [
        (-w + b, -d, z),
        (w - b, -d, z),
        (w, -d + b, z),
        (w, d - b, z),
        (w - b, d, z),
        (-w + b, d, z),
        (-w, d - b, z),
        (-w, -d + b, z),
    ]


def create_emerald(gem: dict, location: tuple[float, float, float]) -> bpy.types.Object:
    mats = make_gem_materials(gem["id"], gem["color"])
    sx, sy, sz = gem["scale"]
    top = bevel_rect_points(0.34, 0.24, 0.09, 0.2 * sz, sx, sy)
    girdle = bevel_rect_points(0.56, 0.36, 0.12, 0.0, sx, sy)
    bottom = bevel_rect_points(0.28, 0.16, 0.06, -0.25 * sz, sx, sy)
    verts = top + girdle + bottom
    faces: list[list[int]] = [list(range(8)), list(range(16, 24))]
    for i in range(8):
        j = (i + 1) % 8
        faces.append([i, j, 8 + j, 8 + i])
    for i in range(8):
        j = (i + 1) % 8
        faces.append([8 + i, 8 + j, 16 + j, 16 + i])

    obj = mesh_object(f"{gem['id']}_gem", verts, faces, mats)
    assign_materials(obj.data, [1, 3, 0, 2, 0, 1, 2])
    root = create_root(gem["id"], location)
    obj.parent = root
    obj.rotation_euler[2] = math.radians(-8)
    return root


def pear_points(count: int, radius: float, z: float, sx: float, sy: float) -> list[tuple[float, float, float]]:
    pts = []
    for i in range(count):
        a = (i / count) * math.tau + math.pi / 2
        pear = 1.0 - 0.34 * math.sin(a)
        x = math.cos(a) * radius * pear * sx
        y = math.sin(a) * radius * (1.0 + 0.18 * math.sin(a)) * sy
        pts.append((x, y, z))
    return pts


def create_pear(gem: dict, location: tuple[float, float, float]) -> bpy.types.Object:
    mats = make_gem_materials(gem["id"], gem["color"])
    sx, sy, sz = gem["scale"]
    sides = 10
    top = pear_points(sides, 0.23, 0.22 * sz, sx, sy)
    girdle = pear_points(sides, 0.5, 0.0, sx, sy)
    bottom = [(0.0, -0.07 * sy, -0.34 * sz)]
    verts = top + girdle + bottom
    bottom_i = len(verts) - 1
    faces: list[list[int]] = [list(range(sides))]
    for i in range(sides):
        j = (i + 1) % sides
        faces.append([i, j, sides + j, sides + i])
    for i in range(sides):
        j = (i + 1) % sides
        faces.append([sides + i, sides + j, bottom_i])
    obj = mesh_object(f"{gem['id']}_gem", verts, faces, mats)
    assign_materials(obj.data, [1, 0, 2, 3, 0])
    root = create_root(gem["id"], location)
    obj.parent = root
    obj.rotation_euler[2] = math.radians(180)
    return root


def crystal_mesh(name: str, color: tuple[float, float, float], radius: float, height: float) -> bpy.types.Object:
    mats = make_gem_materials(name, color)
    sides = 6
    base = ring_points(sides, radius, 0.0, 1.0, 1.0, math.pi / 6)
    top_ring = ring_points(sides, radius * 0.88, height * 0.72, 1.0, 1.0, math.pi / 6)
    tip = [(0.0, 0.0, height)]
    verts = base + top_ring + tip
    tip_i = len(verts) - 1
    faces: list[list[int]] = [list(reversed(range(sides)))]
    for i in range(sides):
        j = (i + 1) % sides
        faces.append([i, j, sides + j, sides + i])
    for i in range(sides):
        j = (i + 1) % sides
        faces.append([sides + i, sides + j, tip_i])
    obj = mesh_object(f"{name}_crystal", verts, faces, mats)
    assign_materials(obj.data, [2, 0, 1, 0, 3])
    return obj


def create_cluster(gem: dict, location: tuple[float, float, float]) -> bpy.types.Object:
    root = create_root(gem["id"], location)
    color = gem["color"]
    configs = [
        ("main", 0.18, 0.78, (0.0, 0.0, 0.0), (0.0, 0.0, 9.0)),
        ("left", 0.12, 0.55, (-0.21, -0.03, 0.0), (9.0, -12.0, -20.0)),
        ("right", 0.11, 0.48, (0.19, 0.05, 0.0), (-10.0, 8.0, 28.0)),
        ("front", 0.1, 0.42, (0.04, -0.2, 0.0), (15.0, 6.0, -6.0)),
    ]
    for suffix, radius, height, loc, rot in configs:
        obj = crystal_mesh(f"{gem['id']}_{suffix}", color, radius, height)
        obj.parent = root
        obj.location = loc
        obj.rotation_euler = tuple(math.radians(v) for v in rot)
    return root


def create_opal(gem: dict, location: tuple[float, float, float]) -> bpy.types.Object:
    root = create_root(gem["id"], location)
    base = make_material("Opal_pearl", (0.86, 0.96, 0.92, 1.0), 0.26)
    blue = make_material("Opal_blue_flash", (0.18, 0.72, 1.0, 1.0), 0.2)
    green = make_material("Opal_green_flash", (0.18, 1.0, 0.48, 1.0), 0.2)
    pink = make_material("Opal_pink_flash", (1.0, 0.38, 0.84, 1.0), 0.2)
    gold = make_material("Opal_gold_flash", (1.0, 0.76, 0.16, 1.0), 0.2)

    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=6, radius=0.48, location=(0, 0, 0.1))
    obj = bpy.context.object
    obj.name = "Opal_gem"
    obj.data.name = "Opal_gem_mesh"
    obj.scale = gem["scale"]
    obj.data.materials.append(base)
    obj.data.materials.append(blue)
    obj.data.materials.append(green)
    obj.data.materials.append(pink)
    obj.data.materials.append(gold)
    for i, poly in enumerate(obj.data.polygons):
        if poly.center.z < -0.1:
            poly.material_index = 0
        elif i % 17 == 0:
            poly.material_index = 1
        elif i % 13 == 0:
            poly.material_index = 2
        elif i % 11 == 0:
            poly.material_index = 3
        elif i % 7 == 0:
            poly.material_index = 4
        else:
            poly.material_index = 0
    obj.parent = root
    return root


def add_label(text: str, location: tuple[float, float, float]) -> None:
    font_curve = bpy.data.curves.new(f"{text}_label_curve", "FONT")
    font_curve.body = text
    font_curve.align_x = "CENTER"
    font_curve.size = 0.13
    obj = bpy.data.objects.new(f"{text}_label", font_curve)
    obj.location = location
    obj.rotation_euler[0] = math.radians(65)
    bpy.context.collection.objects.link(obj)


def create_scene() -> list[bpy.types.Object]:
    clear_scene()
    roots: list[bpy.types.Object] = []
    positions = [
        (-1.8, 0.8, 0.0),
        (-0.6, 0.8, 0.0),
        (0.6, 0.8, 0.0),
        (1.8, 0.8, 0.0),
        (-1.8, -0.8, 0.0),
        (-0.6, -0.8, 0.0),
        (0.6, -0.8, 0.0),
        (1.8, -0.8, 0.0),
    ]
    creators = {
        "brilliant": create_brilliant,
        "emerald": create_emerald,
        "pear": create_pear,
        "cluster": create_cluster,
        "opal": create_opal,
    }
    for gem, pos in zip(GEMS, positions):
        root = creators[gem["shape"]](gem, pos)
        roots.append(root)
        add_label(gem["name"], (pos[0], pos[1] - 0.58, 0.02))

    bpy.ops.object.light_add(type="AREA", location=(0, -3.2, 4.5))
    key = bpy.context.object
    key.name = "Gem_Key_Light"
    key.data.energy = 450
    key.data.size = 4.0

    bpy.ops.object.camera_add(location=(0, -4.3, 2.6), rotation=(math.radians(61), 0, 0))
    bpy.context.scene.camera = bpy.context.object

    bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in {item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items} else "BLENDER_EEVEE"
    bpy.context.scene.view_settings.view_transform = "Standard"
    bpy.context.scene.unit_settings.system = "METRIC"
    return roots


def selected_hierarchy(root: bpy.types.Object) -> list[bpy.types.Object]:
    objects = [root]
    objects.extend(root.children_recursive)
    return objects


def export_root(root: bpy.types.Object) -> None:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    original_location = root.location.copy()
    root.location = (0, 0, 0)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in selected_hierarchy(root):
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root
    filepath = MODEL_DIR / f"{root.name}.glb"
    kwargs = {
        "filepath": str(filepath),
        "export_format": "GLB",
        "use_selection": True,
        "export_apply": True,
        "export_animations": False,
        "export_cameras": False,
        "export_lights": False,
    }
    try:
        bpy.ops.export_scene.gltf(**kwargs)
    except TypeError:
        kwargs.pop("use_selection", None)
        kwargs["export_selected"] = True
        bpy.ops.export_scene.gltf(**kwargs)
    root.location = original_location


def main() -> None:
    roots = create_scene()
    for root in roots:
        export_root(root)
    SOURCE_BLEND.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE_BLEND))
    print(f"Created {len(roots)} gem GLBs in {MODEL_DIR}")
    print(f"Saved source scene to {SOURCE_BLEND}")


if __name__ == "__main__":
    main()
