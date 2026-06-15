from __future__ import annotations

from pathlib import Path

import bpy


PROJECT_ROOT = Path("/home/nick/projectnova-master")
OUT_ROOT = PROJECT_ROOT / "client/public/assets/models/arrowheads"


TIERS = {
    "Bronze": (0.82, 0.42, 0.15, 1.0),
    "Iron": (0.62, 0.64, 0.66, 1.0),
    "Steel": (0.78, 0.88, 0.95, 1.0),
    "Mithril": (0.08, 0.42, 0.68, 1.0),
    "BlackBronze": (0.16, 0.06, 0.02, 1.0),
}


def set_input(node, names: tuple[str, ...], value) -> None:
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


def color_scale(color: tuple[float, float, float, float], scale: float, lift: float = 0.0) -> tuple[float, float, float, float]:
    return (
        clamp01(color[0] * scale + lift),
        clamp01(color[1] * scale + lift),
        clamp01(color[2] * scale + lift),
        color[3],
    )


def make_material(name: str, color: tuple[float, float, float, float], roughness: float) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        set_input(bsdf, ("Base Color",), color)
        set_input(bsdf, ("Roughness",), roughness)
        set_input(bsdf, ("Metallic",), 0.0)
        set_input(bsdf, ("Specular IOR Level", "Specular"), 0.16)
    return mat


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.curves, bpy.data.objects):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def make_arrowhead(tier: str, color: tuple[float, float, float, float]) -> bpy.types.Object:
    highlight = make_material(f"{tier}Arrow_Head_Highlight", color_scale(color, 1.18, 0.035), 0.78)
    mid = make_material(f"{tier}Arrow_Head", color, 0.86)
    shadow = make_material(f"{tier}Arrow_Head_Shadow", color_scale(color, 0.48), 0.94)

    def gltf_vertex(x: float, y: float, z: float) -> tuple[float, float, float]:
        # Author in runtime glTF axes (Y up, arrow points +Z), then convert to
        # Blender axes before export_yup maps Blender Z-up back to glTF Y-up.
        return (x, -z, y)

    verts = [
        gltf_vertex(0.000, 0.002, 0.096),    # 0 tip
        gltf_vertex(-0.068, -0.002, -0.026), # 1 left shoulder
        gltf_vertex(0.068, -0.002, -0.026),  # 2 right shoulder
        gltf_vertex(0.000, -0.004, -0.066),  # 3 rear notch
        gltf_vertex(0.000, 0.026, -0.018),   # 4 raised ridge
        gltf_vertex(0.000, -0.017, -0.020),  # 5 underside ridge
        gltf_vertex(-0.014, 0.004, -0.060),  # 6 tang front left top
        gltf_vertex(0.014, 0.004, -0.060),   # 7 tang front right top
        gltf_vertex(0.014, 0.000, -0.108),   # 8 tang rear right top
        gltf_vertex(-0.014, 0.000, -0.108),  # 9 tang rear left top
        gltf_vertex(-0.014, -0.012, -0.060), # 10 tang front left bottom
        gltf_vertex(0.014, -0.012, -0.060),  # 11 tang front right bottom
        gltf_vertex(0.014, -0.012, -0.108),  # 12 tang rear right bottom
        gltf_vertex(-0.014, -0.012, -0.108), # 13 tang rear left bottom
    ]
    faces = [
        (0, 4, 1),
        (0, 2, 4),
        (1, 4, 3),
        (4, 2, 3),
        (0, 1, 5),
        (0, 5, 2),
        (1, 3, 5),
        (2, 5, 3),
        (6, 7, 8, 9),
        (10, 13, 12, 11),
        (6, 10, 11, 7),
        (7, 11, 12, 8),
        (8, 12, 13, 9),
        (9, 13, 10, 6),
    ]
    material_indices = [
        0, 0,
        1, 1,
        2, 2, 2, 2,
        1,
        2,
        1,
        2, 2, 2,
    ]

    mesh = bpy.data.meshes.new(f"{tier}ArrowheadMesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(f"{tier}Arrowhead", mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(highlight)
    obj.data.materials.append(mid)
    obj.data.materials.append(shadow)
    for poly, material_index in zip(mesh.polygons, material_indices):
        poly.use_smooth = False
        poly.material_index = material_index
    return obj


def export_object(obj: bpy.types.Object, out_path: Path) -> None:
    out_path.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
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
        clear_scene()
        obj = make_arrowhead(tier, color)
        export_object(obj, OUT_ROOT / f"{tier}Arrowhead.glb")


if __name__ == "__main__":
    main()
