from __future__ import annotations

import math
from pathlib import Path

import bpy
from mathutils import Matrix


PROJECT_ROOT = Path("/home/nick/projectnova-master")
GLB_OUT = PROJECT_ROOT / "client/public/assets/equipment/Tools/SmithingHammer_v2.glb"
BLEND_OUT = PROJECT_ROOT / "tools/blender/evilquest_hammer.blend"


def set_input(node, names: tuple[str, ...], value) -> None:
    for name in names:
        if name in node.inputs:
            node.inputs[name].default_value = value
            return


def make_material(name: str, color: tuple[float, float, float, float], roughness: float = 0.75) -> bpy.types.Material:
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        set_input(bsdf, ("Base Color",), color)
        set_input(bsdf, ("Roughness",), roughness)
        set_input(bsdf, ("Metallic",), 0.0)
        set_input(bsdf, ("Alpha",), color[3])
        set_input(bsdf, ("Specular IOR Level", "Specular"), 0.22)
    return mat


def clear_scene() -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for collection in (bpy.data.meshes, bpy.data.materials, bpy.data.curves):
        for block in list(collection):
            if block.users == 0:
                collection.remove(block)


def add_beveled_cube(
    name: str,
    location: tuple[float, float, float],
    scale: tuple[float, float, float],
    material: bpy.types.Material,
    bevel: float = 0.015,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cube_add(size=1, location=location)
    obj = bpy.context.object
    obj.name = name
    obj.data.name = f"{name}_mesh"
    obj.dimensions = scale
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.materials.append(material)
    if bevel > 0:
        mod = obj.modifiers.new(f"{name}_low_bevel", "BEVEL")
        mod.width = bevel
        mod.segments = 1
        mod.affect = "EDGES"
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=mod.name)
    if parent:
        obj.parent = parent
    return obj


def add_cylinder(
    name: str,
    location: tuple[float, float, float],
    radius: float,
    depth: float,
    material: bpy.types.Material,
    vertices: int = 8,
    parent: bpy.types.Object | None = None,
) -> bpy.types.Object:
    bpy.ops.mesh.primitive_cylinder_add(
        vertices=vertices,
        radius=radius,
        depth=depth,
        location=location,
        rotation=(math.radians(90), 0, 0),
    )
    obj = bpy.context.object
    obj.name = name
    obj.data.name = f"{name}_mesh"
    obj.data.materials.append(material)
    if parent:
        obj.parent = parent
    return obj


def wedge_mesh(
    name: str,
    material: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    verts = [
        (0.22, 0.86, -0.14),
        (0.22, 1.14, -0.14),
        (0.22, 1.14, 0.14),
        (0.22, 0.86, 0.14),
        (0.48, 0.94, -0.08),
        (0.48, 1.06, -0.08),
        (0.48, 1.06, 0.08),
        (0.48, 0.94, 0.08),
    ]
    faces = [
        (0, 1, 2, 3),
        (4, 7, 6, 5),
        (0, 4, 5, 1),
        (1, 5, 6, 2),
        (2, 6, 7, 3),
        (3, 7, 4, 0),
    ]
    mesh = bpy.data.meshes.new(f"{name}_mesh")
    mesh.from_pydata(verts, [], faces)
    mesh.update(calc_edges=True)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    obj.data.materials.append(material)
    obj.parent = parent
    return obj


def merge_to_single_mesh(root: bpy.types.Object) -> bpy.types.Object:
    mesh_objects = [obj for obj in root.children_recursive if obj.type == "MESH"]
    if not mesh_objects:
        raise RuntimeError("Hammer has no mesh objects to merge")

    bpy.ops.object.select_all(action="DESELECT")
    for obj in mesh_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = mesh_objects[0]
    bpy.ops.object.join()

    combined = bpy.context.object
    combined.name = "Hammer"
    combined.data.name = "Hammer_mesh"

    # Bake the joined object's transform into vertex coordinates so the export
    # has one mesh object with its origin at the grip base.
    world = combined.matrix_world.copy()
    for vertex in combined.data.vertices:
        vertex.co = world @ vertex.co
    combined.matrix_world = Matrix.Identity(4)
    combined.parent = None
    root.name = "Hammer_source_root"
    bpy.data.objects.remove(root, do_unlink=True)
    combined.select_set(True)
    return combined


def create_hammer() -> bpy.types.Object:
    clear_scene()

    metal = make_material("Hammer_iron_mid", (0.54, 0.55, 0.56, 1), 0.62)
    metal_light = make_material("Hammer_iron_light", (0.78, 0.78, 0.76, 1), 0.58)
    metal_dark = make_material("Hammer_iron_dark", (0.26, 0.26, 0.27, 1), 0.74)
    wood = make_material("Hammer_oak_handle", (0.45, 0.25, 0.11, 1), 0.92)
    leather = make_material("Hammer_dark_leather", (0.16, 0.08, 0.04, 1), 0.9)

    root = bpy.data.objects.new("Hammer", None)
    root.empty_display_type = "PLAIN_AXES"
    root.empty_display_size = 0.18
    bpy.context.collection.objects.link(root)

    handle = add_cylinder("Hammer_handle", (0, 0.43, 0), 0.065, 0.86, wood, vertices=6, parent=root)
    handle.rotation_euler[1] = math.radians(3)

    add_cylinder("Hammer_grip", (0, 0.17, 0), 0.078, 0.18, leather, vertices=6, parent=root)

    add_beveled_cube("Hammer_head_core", (-0.07, 1.0, 0), (0.56, 0.28, 0.32), metal, 0.02, root)
    add_beveled_cube("Hammer_flat_face", (-0.39, 1.0, 0), (0.12, 0.30, 0.34), metal_light, 0.015, root)
    wedge_mesh("Hammer_cross_peen", metal_dark, root)
    add_beveled_cube("Hammer_socket_band", (0, 0.83, 0), (0.20, 0.08, 0.22), metal_dark, 0.01, root)

    for obj in root.children_recursive:
        if hasattr(obj.data, "polygons"):
            for poly in obj.data.polygons:
                poly.use_smooth = False

    hammer = merge_to_single_mesh(root)

    bpy.ops.object.light_add(type="AREA", location=(0, -2.5, 3.0))
    light = bpy.context.object
    light.name = "Hammer_Key_Light"
    light.data.energy = 320
    light.data.size = 3

    bpy.ops.object.camera_add(location=(0.0, -2.2, 1.25), rotation=(math.radians(62), 0, 0))
    bpy.context.scene.camera = bpy.context.object
    bpy.context.scene.view_settings.view_transform = "Standard"
    bpy.context.scene.unit_settings.system = "METRIC"

    return hammer


def export(root: bpy.types.Object) -> None:
    GLB_OUT.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.object.select_all(action="DESELECT")
    root.select_set(True)
    bpy.context.view_layer.objects.active = root
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
    print(f"Exported hammer GLB to {GLB_OUT}")
    print(f"Saved source scene to {BLEND_OUT}")


def main() -> None:
    root = create_hammer()
    export(root)


if __name__ == "__main__":
    main()
