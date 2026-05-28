#!/usr/bin/env python3
"""Add a small looping flame animation to the kiln model and export a GLB.

Run with Blender:
  blender --background assets-sources/models/Kiln_recovered_clean.blend \
    --python tools/blender/add_kiln_flame_animation.py
"""

from __future__ import annotations

from pathlib import Path
import math
import sys

import bpy
from mathutils import Vector


PROJECT_ROOT = Path("/home/nick/projectnova-master")
BLEND_OUT = PROJECT_ROOT / "assets-sources/models/Kiln_recovered_clean.blend"
GLB_OUT = PROJECT_ROOT / "client/public/assets/models/Kiln.glb"
PREVIEW_OUT = Path("/tmp/kiln_flame_preview.png")
KILN_STONE_TEXTURE = PROJECT_ROOT / "client/public/assets/textures/kiln_stone_512.png"


def material(name: str, color: tuple[float, float, float, float], emission: float = 0.0) -> bpy.types.Material:
    mat = bpy.data.materials.get(name) or bpy.data.materials.new(name)
    mat.diffuse_color = color
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = 1.0
        bsdf.inputs["Metallic"].default_value = 0.0
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = color
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = emission
    return mat


def delete_old_flames() -> None:
    for obj in list(bpy.data.objects):
        if obj.name.startswith("Kiln_Flame"):
            bpy.data.objects.remove(obj, do_unlink=True)
    for action in list(bpy.data.actions):
        if action.name.startswith("Kiln_Flame"):
            bpy.data.actions.remove(action)


def make_flame_plane(
    name: str,
    width: float,
    height: float,
    local_x: float,
    local_y: float,
    local_z: float,
    rot_z: float,
    mat: bpy.types.Material,
    parent: bpy.types.Object,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    half_width = width * 0.5
    verts = [
        (-half_width, 0.0, 0.0),
        (half_width, 0.0, 0.0),
        (0.0, 0.0, height),
    ]
    mesh.from_pydata(verts, [], [(0, 1, 2)])
    mesh.update(calc_edges=True)
    mesh.materials.append(mat)

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = (local_x, local_y, local_z)
    obj.rotation_euler = (0.0, 0.0, rot_z)
    obj.show_transparent = True
    return obj


def make_flame_cluster(
    name: str,
    specs: list[tuple[str, float, float, float, float, float, float, bpy.types.Material, int]],
    parent: bpy.types.Object,
) -> bpy.types.Object:
    mesh = bpy.data.meshes.new(f"{name}_Mesh")
    origin = Vector((0.0, -0.382, 0.098))
    verts: list[tuple[float, float, float]] = []
    faces: list[tuple[int, int, int]] = []
    mat_indices: list[int] = []
    material_slots: list[bpy.types.Material] = []
    material_index_by_name: dict[str, int] = {}

    for _, width, height, x, y, z, rot_z, mat, _ in specs:
        mat_index = material_index_by_name.get(mat.name)
        if mat_index is None:
            mat_index = len(material_slots)
            material_index_by_name[mat.name] = mat_index
            material_slots.append(mat)

        cos_r = math.cos(rot_z)
        sin_r = math.sin(rot_z)
        local_tri = [(-width * 0.5, 0.0, 0.0), (width * 0.5, 0.0, 0.0), (0.0, 0.0, height)]
        start = len(verts)
        for lx, ly, lz in local_tri:
            rx = lx * cos_r - ly * sin_r
            ry = lx * sin_r + ly * cos_r
            verts.append((x + rx - origin.x, y + ry - origin.y, z + lz - origin.z))
        faces.append((start, start + 1, start + 2))
        mat_indices.append(mat_index)

    mesh.from_pydata(verts, [], faces)
    mesh.update(calc_edges=True)
    for mat in material_slots:
        mesh.materials.append(mat)
    for poly, mat_index in zip(mesh.polygons, mat_indices):
        poly.material_index = mat_index

    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj.location = origin
    obj.show_transparent = True
    return obj


def keyframe_flame(obj: bpy.types.Object, phase: int, base_location: Vector, base_scale: Vector) -> None:
    base_rotation = obj.rotation_euler.copy()
    frames = (1, 7, 13, 19, 25, 31, 37, 43, 49)
    # Deliberately authored, deterministic flicker values. The final frame
    # matches the first so Babylon can loop without a visible snap.
    offsets = (
        (0.00, 0.00, 0.00, 1.00, 1.00, 0.00),
        (0.004, 0.00, 0.008, 0.88, 1.14, 0.07),
        (-0.004, 0.00, 0.014, 1.08, 0.95, -0.06),
        (0.00, 0.00, 0.006, 0.94, 1.10, 0.04),
        (0.004, 0.00, 0.012, 1.12, 0.92, -0.07),
        (-0.004, 0.00, 0.008, 0.91, 1.13, 0.05),
        (0.00, 0.00, 0.016, 1.05, 0.98, -0.03),
        (0.004, 0.00, 0.005, 0.96, 1.08, 0.03),
        (0.00, 0.00, 0.00, 1.00, 1.00, 0.00),
    )
    offset_count = len(offsets) - 1

    for index, frame in enumerate(frames):
        dx, dy, dz, sx, sz, rz = offsets[(index + phase) % offset_count if index < offset_count else 0]
        obj.location = (base_location.x + dx, base_location.y + dy, base_location.z + dz)
        obj.scale = (base_scale.x * sx, base_scale.y, base_scale.z * sz)
        obj.rotation_euler = (base_rotation.x, base_rotation.y, base_rotation.z + rz)
        obj.keyframe_insert(data_path="location", frame=frame)
        obj.keyframe_insert(data_path="scale", frame=frame)
        obj.keyframe_insert(data_path="rotation_euler", frame=frame)

    if obj.animation_data and obj.animation_data.action:
        obj.animation_data.action.name = f"{obj.name}_Action"
        for fcurve in getattr(obj.animation_data.action, "fcurves", []):
            for key in fcurve.keyframe_points:
                key.interpolation = "LINEAR"


def assign_shared_nla(flames: list[bpy.types.Object]) -> None:
    """Export all flame object actions as one glTF animation group."""
    for obj in flames:
        anim = obj.animation_data
        if not anim or not anim.action:
            continue
        action = anim.action
        for track in list(anim.nla_tracks):
            anim.nla_tracks.remove(track)
        track = anim.nla_tracks.new()
        track.name = "Kiln_Flame_Loop"
        strip = track.strips.new("Kiln_Flame_Loop", 1, action)
        strip.frame_start = 1
        strip.frame_end = 49
        anim.action = None


def restore_stone_uvs(body: bpy.types.Object) -> None:
    """The data-API mesh combine preserves materials but not loop UVs.

    Rebuild a compact box projection for the stone texture so the kiln keeps
    using the same embedded 512px stone-wall image as the wall assets.
    """
    mesh = body.data
    stone_indices = {
        index for index, mat in enumerate(mesh.materials)
        if mat and "StoneWallTexture" in mat.name
    }
    if not stone_indices:
        return

    uv_layer = mesh.uv_layers.get("UVMap") or mesh.uv_layers.new(name="UVMap")
    texture_repeat = 3.2
    for poly in mesh.polygons:
        normal = poly.normal
        ax, ay, az = abs(normal.x), abs(normal.y), abs(normal.z)
        for loop_index in poly.loop_indices:
            vertex = mesh.vertices[mesh.loops[loop_index].vertex_index]
            co = vertex.co
            if poly.material_index not in stone_indices:
                uv_layer.data[loop_index].uv = (co.x, co.z)
                continue

            if az >= ax and az >= ay:
                u, v = co.x, co.y
            elif ay >= ax:
                u, v = co.x, co.z
            else:
                u, v = co.y, co.z
            uv_layer.data[loop_index].uv = (u * texture_repeat, v * texture_repeat)

    mesh.update()


def ensure_stone_texture(body: bpy.types.Object) -> None:
    if not KILN_STONE_TEXTURE.exists():
        raise RuntimeError(f"Missing kiln stone texture: {KILN_STONE_TEXTURE}")

    image = bpy.data.images.load(str(KILN_STONE_TEXTURE), check_existing=True)
    image.name = "kiln_stone_512.png"

    for mat in body.data.materials:
        if not mat or "StoneWallTexture" not in mat.name:
            continue
        mat.use_nodes = True
        nodes = mat.node_tree.nodes
        links = mat.node_tree.links

        bsdf = nodes.get("Principled BSDF")
        image_node = next((node for node in nodes if node.bl_idname == "ShaderNodeTexImage"), None)
        if image_node is None:
            image_node = nodes.new("ShaderNodeTexImage")
        image_node.image = image
        image_node.extension = "REPEAT"

        uv_node = next((node for node in nodes if node.bl_idname == "ShaderNodeUVMap"), None)
        if uv_node is None:
            uv_node = nodes.new("ShaderNodeUVMap")
        uv_node.uv_map = "UVMap"

        mapping = next((node for node in nodes if node.bl_idname == "ShaderNodeMapping"), None)
        if mapping is None:
            mapping = nodes.new("ShaderNodeMapping")

        if not any(link.from_node == uv_node and link.to_node == mapping for link in links):
            links.new(uv_node.outputs["UV"], mapping.inputs["Vector"])
        if not any(link.from_node == mapping and link.to_node == image_node for link in links):
            links.new(mapping.outputs["Vector"], image_node.inputs["Vector"])
        if bsdf and not any(link.from_node == image_node and link.to_node == bsdf for link in links):
            links.new(image_node.outputs["Color"], bsdf.inputs["Base Color"])


def setup_preview_camera() -> None:
    for obj in list(bpy.data.objects):
        if obj.name.startswith("Kiln_Preview_Camera"):
            bpy.data.objects.remove(obj, do_unlink=True)

    cam_data = bpy.data.cameras.new("Kiln_Preview_Camera")
    cam = bpy.data.objects.new("Kiln_Preview_Camera", cam_data)
    bpy.context.scene.collection.objects.link(cam)
    cam.location = (1.75, -2.45, 1.45)
    direction = Vector((0.0, -0.05, 0.48)) - Vector(cam.location)
    cam.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()
    cam_data.lens = 55
    bpy.context.scene.camera = cam

    light = bpy.data.objects.get("Kiln_Preview_Light")
    if not light:
        light_data = bpy.data.lights.new("Kiln_Preview_Light", "AREA")
        light = bpy.data.objects.new("Kiln_Preview_Light", light_data)
        bpy.context.scene.collection.objects.link(light)
    light.location = (0.0, -1.6, 1.7)
    light.data.energy = 350
    light.data.size = 2.2


def export_glb() -> None:
    for obj in bpy.context.scene.objects:
        obj.select_set(obj.type == "MESH" and (obj.name == "Kiln" or obj.name.startswith("Kiln_Flame")))
    bpy.ops.export_scene.gltf(
        filepath=str(GLB_OUT),
        export_format="GLB",
        use_selection=True,
        export_animations=True,
        export_frame_range=True,
        export_frame_step=1,
        export_nla_strips=True,
        export_materials="EXPORT",
        export_yup=True,
    )


def render_preview() -> None:
    scene = bpy.context.scene
    scene.frame_set(13)
    scene.render.engine = "BLENDER_EEVEE"
    if hasattr(scene, "eevee"):
        scene.eevee.taa_render_samples = 32
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.view_settings.view_transform = "Standard"
    scene.render.film_transparent = True
    scene.render.filepath = str(PREVIEW_OUT)
    bpy.ops.render.render(write_still=True)


def main() -> None:
    body = bpy.data.objects.get("Kiln")
    if body is None or body.type != "MESH":
        raise RuntimeError("Expected a combined mesh object named Kiln")

    delete_old_flames()

    red = material("Kiln_Flame_Red", (1.0, 0.07, 0.015, 1.0), 0.6)
    orange = material("Kiln_Flame_Orange", (1.0, 0.42, 0.04, 1.0), 0.8)
    yellow = material("Kiln_Flame_Yellow", (1.0, 0.86, 0.18, 1.0), 1.0)

    # The kiln mouth faces negative Y. The body mesh already has a red glow
    # plane inside the mouth, so these flames sit just in front of it.
    specs = [
        ("Kiln_Flame_Red_A", 0.105, 0.122, 0.00, -0.382, 0.098, 0.0, red, 0),
        ("Kiln_Flame_Orange_A", 0.068, 0.170, -0.035, -0.382, 0.104, math.radians(10), orange, 2),
        ("Kiln_Flame_Orange_B", 0.071, 0.148, 0.04, -0.382, 0.104, math.radians(-12), orange, 4),
        ("Kiln_Flame_Yellow_A", 0.043, 0.130, 0.00, -0.382, 0.108, math.radians(4), yellow, 6),
    ]

    flame = make_flame_cluster("Kiln_Flame", specs, body)
    keyframe_flame(flame, 0, flame.location.copy(), Vector((1.0, 1.0, 1.0)))
    flames = [flame]
    assign_shared_nla(flames)
    restore_stone_uvs(body)
    ensure_stone_texture(body)

    scene = bpy.context.scene
    scene.frame_start = 1
    scene.frame_end = 49
    scene.render.fps = 24

    setup_preview_camera()
    bpy.ops.wm.save_as_mainfile(filepath=str(BLEND_OUT))
    export_glb()
    render_preview()

    print(f"Added {len(flames)} animated flame meshes")
    print(f"Saved blend: {BLEND_OUT}")
    print(f"Exported GLB: {GLB_OUT}")
    print(f"Preview: {PREVIEW_OUT}")


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        raise
