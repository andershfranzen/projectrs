from __future__ import annotations

from pathlib import Path

import bpy


PROJECT_ROOT = Path("/home/nick/projectnova-master")
GLB_OUT = PROJECT_ROOT / "client/public/assets/models/FletchingKnife_v2.glb"
BLEND_OUT = PROJECT_ROOT / "tools/blender/evilquest_fletching_knife.blend"


MAT_HANDLE = 0
MAT_GRIP_DARK = 1
MAT_STEEL = 2
MAT_STEEL_LIGHT = 3
MAT_SOCKET = 4
MAT_STEEL_DARK = 5


def set_input(node, names: tuple[str, ...], value) -> None:
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def make_material(name: str, color: tuple[float, float, float, float], roughness: float) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        set_input(bsdf, ("Base Color",), color)
        set_input(bsdf, ("Roughness",), roughness)
        set_input(bsdf, ("Metallic",), 0.0)
        set_input(bsdf, ("Alpha",), color[3])
        set_input(bsdf, ("Specular IOR Level", "Specular"), 0.2)
    return mat


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.curves):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


class MeshBuilder:
    def __init__(self) -> None:
        self.verts: list[tuple[float, float, float]] = []
        self.faces: list[tuple[int, ...]] = []
        self.material_indices: list[int] = []

    def add_box(
        self,
        center: tuple[float, float, float],
        size: tuple[float, float, float],
        mat_index: int,
    ) -> None:
        cx, cy, cz = center
        sx, sy, sz = (value * 0.5 for value in size)
        start = len(self.verts)
        self.verts.extend([
            (cx - sx, cy - sy, cz - sz),
            (cx + sx, cy - sy, cz - sz),
            (cx + sx, cy + sy, cz - sz),
            (cx - sx, cy + sy, cz - sz),
            (cx - sx, cy - sy, cz + sz),
            (cx + sx, cy - sy, cz + sz),
            (cx + sx, cy + sy, cz + sz),
            (cx - sx, cy + sy, cz + sz),
        ])
        for face in (
            (0, 1, 2, 3),
            (4, 7, 6, 5),
            (0, 4, 5, 1),
            (1, 5, 6, 2),
            (2, 6, 7, 3),
            (3, 7, 4, 0),
        ):
            self.faces.append(tuple(start + i for i in face))
            self.material_indices.append(mat_index)

    def add_tapered_box(
        self,
        bottom_width: float,
        top_width: float,
        y0: float,
        y1: float,
        depth0: float,
        depth1: float,
        mat_index: int,
        x_offset0: float = 0.0,
        x_offset1: float = 0.0,
    ) -> None:
        start = len(self.verts)
        self.verts.extend([
            (x_offset0 - bottom_width * 0.5, y0, -depth0 * 0.5),
            (x_offset0 + bottom_width * 0.5, y0, -depth0 * 0.5),
            (x_offset1 + top_width * 0.5, y1, -depth1 * 0.5),
            (x_offset1 - top_width * 0.5, y1, -depth1 * 0.5),
            (x_offset0 - bottom_width * 0.5, y0, depth0 * 0.5),
            (x_offset0 + bottom_width * 0.5, y0, depth0 * 0.5),
            (x_offset1 + top_width * 0.5, y1, depth1 * 0.5),
            (x_offset1 - top_width * 0.5, y1, depth1 * 0.5),
        ])
        for face in (
            (0, 1, 2, 3),
            (4, 7, 6, 5),
            (0, 4, 5, 1),
            (1, 5, 6, 2),
            (2, 6, 7, 3),
            (3, 7, 4, 0),
        ):
            self.faces.append(tuple(start + i for i in face))
            self.material_indices.append(mat_index)

    def add_blade(self) -> None:
        start = len(self.verts)
        # Long faceted carving blade, matching the reference's broad central
        # face and clipped low-poly point. A slight raised ridge gives the
        # runtime thumbnail one clean light/dark split instead of mushy grey.
        self.verts.extend([
            (-0.13, 0.58, -0.038),
            (0.13, 0.58, -0.038),
            (0.16, 1.36, -0.030),
            (0.06, 1.68, -0.018),
            (-0.10, 1.48, -0.026),
            (-0.20, 0.72, -0.038),
            (-0.13, 0.58, 0.038),
            (0.13, 0.58, 0.038),
            (0.16, 1.36, 0.030),
            (0.06, 1.68, 0.018),
            (-0.10, 1.48, 0.026),
            (-0.20, 0.72, 0.038),
            (-0.005, 0.64, 0.052),
            (0.03, 1.43, 0.040),
        ])
        face_specs = [
            ((0, 1, 2, 3, 4, 5), MAT_STEEL_DARK),
            ((6, 7, 13, 12), MAT_STEEL_LIGHT),
            ((7, 8, 13), MAT_STEEL_LIGHT),
            ((8, 9, 13), MAT_STEEL_LIGHT),
            ((6, 12, 11), MAT_STEEL),
            ((11, 12, 13, 10), MAT_STEEL),
            ((10, 13, 9), MAT_STEEL),
            ((0, 6, 7, 1), MAT_STEEL),
            ((1, 7, 8, 2), MAT_STEEL_LIGHT),
            ((2, 8, 9, 3), MAT_STEEL_LIGHT),
            ((3, 9, 10, 4), MAT_STEEL),
            ((4, 10, 11, 5), MAT_STEEL),
            ((5, 11, 6, 0), MAT_STEEL),
        ]
        for face, mat in face_specs:
            self.faces.append(tuple(start + i for i in face))
            self.material_indices.append(mat)

    def build(self) -> bpy.types.Object:
        mesh = bpy.data.meshes.new("FletchingKnife_mesh")
        mesh.from_pydata(self.verts, [], self.faces)
        mesh.update(calc_edges=True)
        obj = bpy.data.objects.new("FletchingKnife", mesh)
        bpy.context.collection.objects.link(obj)
        for poly, mat_index in zip(mesh.polygons, self.material_indices):
            poly.material_index = mat_index
            poly.use_smooth = False
        return obj


def create_knife() -> bpy.types.Object:
    clear_scene()

    materials = [
        make_material("Knife_warm_wood", (0.50, 0.27, 0.12, 1), 0.9),
        make_material("Knife_dark_grip", (0.18, 0.09, 0.04, 1), 0.92),
        make_material("Knife_steel_mid", (0.52, 0.54, 0.55, 1), 0.58),
        make_material("Knife_steel_light", (0.80, 0.80, 0.77, 1), 0.52),
        make_material("Knife_socket_dark", (0.28, 0.29, 0.30, 1), 0.7),
        make_material("Knife_steel_dark", (0.34, 0.35, 0.36, 1), 0.66),
    ]

    builder = MeshBuilder()
    builder.add_tapered_box(0.30, 0.22, -0.15, 0.06, 0.16, 0.13, MAT_STEEL_LIGHT, -0.02, 0.0)
    builder.add_tapered_box(0.23, 0.18, 0.05, 0.50, 0.135, 0.105, MAT_HANDLE, 0.0, -0.015)
    builder.add_tapered_box(0.20, 0.29, 0.49, 0.62, 0.115, 0.14, MAT_STEEL_LIGHT, -0.015, -0.025)
    builder.add_box((-0.015, 0.59, 0.0), (0.25, 0.08, 0.13), MAT_SOCKET)
    builder.add_blade()
    knife = builder.build()
    for mat in materials:
        knife.data.materials.append(mat)

    bpy.ops.object.light_add(type="AREA", location=(0, -2.0, 2.4))
    light = bpy.context.object
    light.name = "FletchingKnife_Key_Light"
    light.data.energy = 280
    light.data.size = 2.6

    bpy.ops.object.camera_add(location=(0, -2.2, 1.25), rotation=(1.08, 0, 0))
    bpy.context.scene.camera = bpy.context.object
    bpy.context.scene.view_settings.view_transform = "Standard"
    bpy.context.scene.unit_settings.system = "METRIC"

    return knife


def export(obj: bpy.types.Object) -> None:
    GLB_OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_OUT),
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_animations=False,
        export_cameras=False,
        export_lights=False,
    )
    BLEND_OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_OUT))
    print(f"Exported fletching knife GLB to {GLB_OUT}")
    print(f"Saved source scene to {BLEND_OUT}")


def main() -> None:
    export(create_knife())


if __name__ == "__main__":
    main()
