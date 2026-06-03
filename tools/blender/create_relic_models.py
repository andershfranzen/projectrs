from __future__ import annotations

import math
from pathlib import Path

import bpy


PROJECT_ROOT = Path("/home/nick/projectnova-master")
MODEL_DIR = PROJECT_ROOT / "client/public/assets/models/relics"
SOURCE_BLEND = PROJECT_ROOT / "tools/blender/evilquest_relics.blend"


RELICS = [
    {"id": "StrangeTotem", "name": "Strange Totem", "creator": "totem", "tier": 1},
    {"id": "OldCoin", "name": "Old Coin", "creator": "coin", "tier": 1},
    {"id": "OldSymbol", "name": "Old Symbol", "creator": "symbol", "tier": 1},
    {"id": "OldJewelry", "name": "Old Jewelry", "creator": "jewelry", "tier": 2},
    {"id": "OldBone", "name": "Old Bone", "creator": "bone", "tier": 2},
    {"id": "Manuscript", "name": "Manuscript", "creator": "manuscript", "tier": 2},
]


def set_input(node, names: tuple[str, ...], value) -> None:
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def make_material(
    name: str,
    color: tuple[float, float, float, float],
    roughness: float = 0.82,
    metallic: float = 0.0,
    emission: tuple[float, float, float, float] | None = None,
    emission_strength: float = 0.0,
) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        set_input(bsdf, ("Base Color",), color)
        set_input(bsdf, ("Roughness",), roughness)
        set_input(bsdf, ("Metallic",), metallic)
        set_input(bsdf, ("Specular IOR Level", "Specular"), 0.22 if metallic < 0.5 else 0.55)
        if emission:
            set_input(bsdf, ("Emission Color", "Emission"), emission)
            set_input(bsdf, ("Emission Strength",), emission_strength)
    return mat


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.objects, bpy.data.images):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def create_root(name: str, location: tuple[float, float, float]) -> bpy.types.Object:
    root = bpy.data.objects.new(name, None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.18
    root.location = location
    bpy.context.collection.objects.link(root)
    return root


def parent_to(root: bpy.types.Object, *objects: bpy.types.Object) -> None:
    for obj in objects:
        obj.parent = root
        if hasattr(obj.data, "polygons"):
            for poly in obj.data.polygons:
                poly.use_smooth = False


def add_cube(
    name: str,
    mat: bpy.types.Material,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.scale = scale
    obj.data.materials.append(mat)
    return obj


def add_cylinder(
    name: str,
    mat: bpy.types.Material,
    vertices: int,
    radius: float,
    depth: float,
    location: tuple[float, float, float],
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def add_cone(
    name: str,
    mat: bpy.types.Material,
    vertices: int,
    radius1: float,
    radius2: float,
    depth: float,
    location: tuple[float, float, float],
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0),
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cone_add(vertices=vertices, radius1=radius1, radius2=radius2, depth=depth, location=location, rotation=rotation)
    obj = bpy.context.object
    obj.name = name
    obj.data.materials.append(mat)
    return obj


def mesh_object(
    name: str,
    mat: bpy.types.Material,
    verts: list[tuple[float, float, float]],
    faces: list[tuple[int, ...]],
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(mat)
    return obj


def create_materials() -> dict[str, bpy.types.Material]:
    return {
        "tier1_stone": make_material("tier1_relic_weathered_stone", (0.42, 0.37, 0.31, 1.0), 0.96),
        "tier1_dark": make_material("tier1_relic_dark_cuts", (0.16, 0.13, 0.10, 1.0), 0.98),
        "tier1_bronze": make_material("tier1_relic_old_bronze", (0.48, 0.29, 0.13, 1.0), 0.78, 0.35),
        "tier1_patina": make_material("tier1_relic_patina", (0.12, 0.43, 0.33, 1.0), 0.9),
        "tier2_gold": make_material("tier2_relic_worn_gold", (0.78, 0.52, 0.20, 1.0), 0.46, 0.7),
        "tier2_silver": make_material("tier2_relic_tarnished_silver", (0.60, 0.58, 0.54, 1.0), 0.58, 0.55),
        "tier2_bone": make_material("tier2_relic_polished_bone", (0.78, 0.68, 0.50, 1.0), 0.86),
        "tier2_parchment": make_material("tier2_relic_old_parchment", (0.73, 0.56, 0.34, 1.0), 0.92),
        "tier2_ink": make_material("tier2_relic_ink", (0.09, 0.05, 0.035, 1.0), 0.95),
        "tier2_glow": make_material(
            "tier2_relic_soft_goodmagic_glow",
            (0.26, 0.74, 0.95, 1.0),
            0.32,
            0.0,
            (0.14, 0.58, 0.82, 1.0),
            0.45,
        ),
    }


def create_totem(root: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    parts = [
        add_cylinder("StrangeTotem_body", mats["tier1_stone"], 6, 0.17, 0.62, (0, 0, 0.36), (0, 0, math.radians(30))),
        add_cone("StrangeTotem_cap", mats["tier1_stone"], 6, 0.20, 0.11, 0.16, (0, 0, 0.75), (0, 0, math.radians(30))),
        add_cylinder("StrangeTotem_base", mats["tier1_dark"], 6, 0.22, 0.12, (0, 0, 0.06), (0, 0, math.radians(30))),
        add_cube("StrangeTotem_eye_a", mats["tier1_dark"], (-0.052, -0.173, 0.48), (0.028, 0.006, 0.018)),
        add_cube("StrangeTotem_eye_b", mats["tier1_dark"], (0.052, -0.173, 0.48), (0.028, 0.006, 0.018)),
        add_cube("StrangeTotem_rune_v", mats["tier1_patina"], (0.0, -0.176, 0.31), (0.018, 0.006, 0.080)),
        add_cube("StrangeTotem_rune_h", mats["tier1_patina"], (0.0, -0.178, 0.30), (0.080, 0.006, 0.015), (0, 0, math.radians(18))),
    ]
    parent_to(root, *parts)


def create_coin(root: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    parts = [
        add_cylinder("OldCoin_face", mats["tier1_bronze"], 18, 0.32, 0.055, (0, 0, 0.035)),
        add_cylinder("OldCoin_rim", mats["tier1_dark"], 18, 0.335, 0.022, (0, 0, 0.066)),
        add_cube("OldCoin_mark_a", mats["tier1_patina"], (-0.060, 0.0, 0.086), (0.020, 0.120, 0.006)),
        add_cube("OldCoin_mark_b", mats["tier1_patina"], (0.055, 0.0, 0.087), (0.018, 0.105, 0.006), (0, 0, math.radians(-24))),
        add_cube("OldCoin_cut", mats["tier1_dark"], (0.0, -0.18, 0.088), (0.105, 0.018, 0.006), (0, 0, math.radians(12))),
    ]
    parent_to(root, *parts)


def create_symbol(root: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    parts = [
        add_cylinder("OldSymbol_triangle", mats["tier1_stone"], 3, 0.38, 0.075, (0, 0, 0.05), (0, 0, math.radians(30))),
        add_cylinder("OldSymbol_center", mats["tier1_bronze"], 6, 0.105, 0.038, (0, 0, 0.105), (0, 0, math.radians(30))),
        add_cube("OldSymbol_arm_a", mats["tier1_dark"], (0.0, -0.13, 0.127), (0.020, 0.145, 0.008)),
        add_cube("OldSymbol_arm_b", mats["tier1_dark"], (0.105, 0.058, 0.128), (0.018, 0.130, 0.008), (0, 0, math.radians(120))),
        add_cube("OldSymbol_arm_c", mats["tier1_dark"], (-0.105, 0.058, 0.128), (0.018, 0.130, 0.008), (0, 0, math.radians(-120))),
    ]
    parent_to(root, *parts)


def create_jewelry(root: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    bpy.ops.mesh.primitive_torus_add(major_segments=14, minor_segments=5, major_radius=0.23, minor_radius=0.035, location=(0, 0, 0.18))
    ring = bpy.context.object
    ring.name = "OldJewelry_bent_ring"
    ring.scale.x = 1.08
    ring.scale.y = 0.78
    ring.data.materials.append(mats["tier2_gold"])
    parts = [
        ring,
        add_cone("OldJewelry_gem", mats["tier2_glow"], 6, 0.090, 0.040, 0.105, (0.0, -0.235, 0.20), (math.radians(90), 0, 0)),
        add_cylinder("OldJewelry_clasp", mats["tier2_silver"], 6, 0.045, 0.12, (0.0, 0.23, 0.18), (math.radians(90), 0, 0)),
    ]
    parent_to(root, *parts)


def create_bone(root: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    parts = [
        add_cylinder("OldBone_shaft", mats["tier2_bone"], 8, 0.065, 0.46, (0.0, 0.0, 0.19), (0.0, math.radians(82), math.radians(-16))),
        add_cone("OldBone_tip", mats["tier2_bone"], 8, 0.072, 0.020, 0.16, (0.235, -0.067, 0.215), (0.0, math.radians(82), math.radians(-16))),
        add_cylinder("OldBone_knob_a", mats["tier2_bone"], 8, 0.090, 0.090, (-0.245, 0.070, 0.165), (0, math.radians(82), math.radians(-16))),
        add_cylinder("OldBone_knob_b", mats["tier2_bone"], 8, 0.072, 0.080, (-0.185, -0.060, 0.168), (0, math.radians(72), math.radians(20))),
        add_cube("OldBone_glyph_a", mats["tier2_glow"], (0.000, -0.020, 0.245), (0.012, 0.006, 0.052), (0, 0, math.radians(-16))),
        add_cube("OldBone_glyph_b", mats["tier2_glow"], (0.072, -0.040, 0.240), (0.010, 0.006, 0.042), (0, 0, math.radians(-48))),
    ]
    parent_to(root, *parts)


def create_manuscript(root: bpy.types.Object, mats: dict[str, bpy.types.Material]) -> None:
    paper = add_cube("Manuscript_sheet", mats["tier2_parchment"], (0, 0, 0.08), (0.33, 0.22, 0.018), (0, 0, math.radians(-8)))
    roll_a = add_cylinder("Manuscript_roll_a", mats["tier2_parchment"], 8, 0.042, 0.46, (-0.34, 0.047, 0.095), (math.radians(90), 0, math.radians(-8)))
    roll_b = add_cylinder("Manuscript_roll_b", mats["tier2_parchment"], 8, 0.035, 0.43, (0.34, -0.047, 0.093), (math.radians(90), 0, math.radians(-8)))
    glyphs = [
        add_cube("Manuscript_glyph_1", mats["tier2_ink"], (-0.12, -0.045, 0.103), (0.095, 0.008, 0.005), (0, 0, math.radians(-8))),
        add_cube("Manuscript_glyph_2", mats["tier2_ink"], (0.03, -0.002, 0.104), (0.135, 0.007, 0.005), (0, 0, math.radians(-8))),
        add_cube("Manuscript_glyph_3", mats["tier2_glow"], (0.12, 0.060, 0.105), (0.075, 0.009, 0.005), (0, 0, math.radians(18))),
        add_cube("Manuscript_seal", mats["tier2_gold"], (-0.005, 0.095, 0.106), (0.045, 0.045, 0.006), (0, 0, math.radians(45))),
    ]
    parent_to(root, paper, roll_a, roll_b, *glyphs)


def add_label(text: str, location: tuple[float, float, float]) -> None:
    bpy.ops.object.text_add(location=location, rotation=(math.radians(75), 0, 0))
    obj = bpy.context.object
    obj.name = f"{text.replace(' ', '')}_label"
    obj.data.body = text
    obj.data.align_x = "CENTER"
    obj.data.align_y = "CENTER"
    obj.data.size = 0.105
    obj.data.materials.append(make_material(f"{obj.name}_mat", (0.13, 0.11, 0.09, 1.0), 0.9))


def create_scene() -> list[bpy.types.Object]:
    clear_scene()
    mats = create_materials()
    creators = {
        "totem": create_totem,
        "coin": create_coin,
        "symbol": create_symbol,
        "jewelry": create_jewelry,
        "bone": create_bone,
        "manuscript": create_manuscript,
    }
    positions = [(-1.4, 0.85, 0), (0, 0.85, 0), (1.4, 0.85, 0), (-1.4, -0.85, 0), (0, -0.85, 0), (1.4, -0.85, 0)]
    roots: list[bpy.types.Object] = []
    for relic, pos in zip(RELICS, positions):
        root = create_root(relic["id"], pos)
        creators[relic["creator"]](root, mats)
        roots.append(root)
        add_label(f"T{relic['tier']} {relic['name']}", (pos[0], pos[1] - 0.55, 0.02))

    bpy.ops.object.light_add(type="AREA", location=(0, -3.0, 4.0))
    key = bpy.context.object
    key.name = "Relic_Key_Light"
    key.data.energy = 420
    key.data.size = 4.0

    bpy.ops.object.camera_add(location=(0, -4.2, 2.4), rotation=(math.radians(62), 0, 0))
    bpy.context.scene.camera = bpy.context.object
    bpy.context.scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in {item.identifier for item in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items} else "BLENDER_EEVEE"
    bpy.context.scene.view_settings.view_transform = "Standard"
    bpy.context.scene.unit_settings.system = "METRIC"
    return roots


def selected_hierarchy(root: bpy.types.Object) -> list[bpy.types.Object]:
    return [root, *root.children_recursive]


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
    print(f"Created {len(roots)} relic GLBs in {MODEL_DIR}")
    print(f"Saved source scene to {SOURCE_BLEND}")


if __name__ == "__main__":
    main()
