#!/usr/bin/env python3
"""Create a yew tree variant from the maple tree GLB.

Run with:
  blender --background --python tools/export-yew-tree.py

The trunk is kept from the maple source. Only the textured leaf material and
the vertices assigned to that material are changed, then a .blend source and
runtime GLB are written.
"""

from __future__ import annotations

import colorsys
import os
from pathlib import Path

import bpy
from mathutils import Vector


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SOURCE_GLB = PROJECT_ROOT / 'client/public/assets/models/maple tree.glb'
SOURCE_LEAF_TEXTURE = PROJECT_ROOT / 'client/public/assets/leaf-textures/maple_summer_green2.png'
LEAF_TEXTURE_DIR = PROJECT_ROOT / 'client/public/assets/leaf-textures'
SOURCE_BLEND = PROJECT_ROOT / 'assets-sources/trees/yew_tree.blend'
OUT_GLB = PROJECT_ROOT / 'client/public/assets/models/yew tree.glb'
DEFAULT_TEXTURE_VARIANT = os.environ.get('YEW_TEXTURE_VARIANT', 'ancient').lower()
EXPORT_ALL_TEXTURE_VARIANTS = os.environ.get('YEW_EXPORT_ALL_TEXTURES') == '1'

TEXTURE_VARIANTS = {
    'classic': {
        'filename': 'yew_dark_green.png',
        'hue': 0.31,
        'hue_source': 0.28,
        'hue_spread': 0.10,
        'saturation_mul': 0.82,
        'saturation_offset': 0.0,
        'saturation_min': 0.42,
        'saturation_max': 0.78,
        'value_mul': 0.46,
        'value_offset': 0.0,
        'value_min': 0.11,
        'value_max': 0.46,
    },
    'shadow': {
        'filename': 'yew_shadow_green.png',
        'hue': 0.34,
        'hue_source': 0.28,
        'hue_spread': 0.06,
        'saturation_mul': 0.95,
        'saturation_offset': 0.03,
        'saturation_min': 0.46,
        'saturation_max': 0.90,
        'value_mul': 0.33,
        'value_offset': 0.0,
        'value_min': 0.07,
        'value_max': 0.33,
    },
    'blue': {
        'filename': 'yew_blue_green.png',
        'hue': 0.40,
        'hue_source': 0.28,
        'hue_spread': 0.08,
        'saturation_mul': 0.74,
        'saturation_offset': -0.03,
        'saturation_min': 0.35,
        'saturation_max': 0.68,
        'value_mul': 0.44,
        'value_offset': 0.01,
        'value_min': 0.10,
        'value_max': 0.45,
    },
    'moss': {
        'filename': 'yew_moss_green.png',
        'hue': 0.25,
        'hue_source': 0.28,
        'hue_spread': 0.12,
        'saturation_mul': 0.72,
        'saturation_offset': -0.01,
        'saturation_min': 0.35,
        'saturation_max': 0.68,
        'value_mul': 0.52,
        'value_offset': 0.02,
        'value_min': 0.14,
        'value_max': 0.52,
    },
    'ancient': {
        'filename': 'yew_ancient_green.png',
        'hue': 0.30,
        'hue_source': 0.28,
        'hue_spread': 0.05,
        'saturation_mul': 0.55,
        'saturation_offset': -0.02,
        'saturation_min': 0.28,
        'saturation_max': 0.55,
        'value_mul': 0.36,
        'value_offset': 0.01,
        'value_min': 0.09,
        'value_max': 0.38,
    },
}


def clear_scene() -> None:
    bpy.ops.object.select_all(action='SELECT')
    bpy.ops.object.delete()
    for collection in (
        bpy.data.meshes,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.textures,
        bpy.data.node_groups,
    ):
        for item in list(collection):
            collection.remove(item)


def first_mesh_object() -> bpy.types.Object:
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == 'MESH']
    if not meshes:
        raise RuntimeError('No mesh objects found after importing maple tree')
    return max(meshes, key=lambda obj: len(obj.data.polygons))


def clamp(value: float, minimum: float, maximum: float) -> float:
    return max(minimum, min(maximum, value))


def make_yew_texture(variant_name: str) -> Path:
    variant = TEXTURE_VARIANTS[variant_name]
    src = bpy.data.images.load(str(SOURCE_LEAF_TEXTURE), check_existing=True)
    width, height = src.size
    src_pixels = list(src.pixels)
    out_pixels = [0.0] * len(src_pixels)

    for offset in range(0, len(src_pixels), 4):
        r, g, b, a = src_pixels[offset:offset + 4]
        if a == 0:
            out_pixels[offset:offset + 4] = [r, g, b, a]
            continue
        h, s, v = colorsys.rgb_to_hsv(r, g, b)
        # Push maple leaves toward an evergreen range while preserving the
        # original alpha/silhouette.
        h = variant['hue'] + (h - variant['hue_source']) * variant['hue_spread']
        s = clamp(
            s * variant['saturation_mul'] + variant['saturation_offset'],
            variant['saturation_min'],
            variant['saturation_max'],
        )
        v = clamp(
            v * variant['value_mul'] + variant['value_offset'],
            variant['value_min'],
            variant['value_max'],
        )
        nr, ng, nb = colorsys.hsv_to_rgb(h, s, v)
        out_pixels[offset:offset + 4] = [nr, ng, nb, a]

    out_path = LEAF_TEXTURE_DIR / str(variant['filename'])
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out = bpy.data.images.new(Path(str(variant['filename'])).stem, width=width, height=height, alpha=True)
    out.pixels[:] = out_pixels
    out.filepath_raw = str(out_path)
    out.file_format = 'PNG'
    out.save()
    return out_path


def make_yew_textures(variant_names: list[str]) -> dict[str, Path]:
    return {variant_name: make_yew_texture(variant_name) for variant_name in variant_names}


def material_has_texture(mat: bpy.types.Material) -> bool:
    if not mat.use_nodes or not mat.node_tree:
        return False
    return any(node.type == 'TEX_IMAGE' for node in mat.node_tree.nodes)


def replace_leaf_material(obj: bpy.types.Object, texture_path: Path, variant_name: str) -> int:
    mesh = obj.data
    leaf_index = -1
    for index, mat in enumerate(mesh.materials):
        if mat and material_has_texture(mat):
            leaf_index = index
            break
    if leaf_index < 0:
        raise RuntimeError('Could not find textured leaf material on maple tree')

    img = bpy.data.images.load(str(texture_path), check_existing=True)
    mat = mesh.materials[leaf_index]
    mat.name = f'yew_{variant_name}_leaves'
    mat.diffuse_color = (0.06, 0.18, 0.055, 0.999)
    mat.blend_method = 'BLEND'
    if hasattr(mat, 'surface_render_method'):
        mat.surface_render_method = 'BLENDED'
    mat.use_nodes = True
    mat.show_transparent_back = True

    nodes = mat.node_tree.nodes
    bsdf = nodes.get('Principled BSDF')
    tex_nodes = [node for node in nodes if node.type == 'TEX_IMAGE']
    tex = tex_nodes[0] if tex_nodes else nodes.new(type='ShaderNodeTexImage')
    for stale_tex in tex_nodes[1:]:
        nodes.remove(stale_tex)
    tex.image = img
    tex.extension = 'EXTEND'
    tex.interpolation = 'Closest'

    if bsdf:
        for socket_name in ('Base Color', 'Alpha'):
            socket = bsdf.inputs.get(socket_name)
            if not socket:
                continue
            for link in list(socket.links):
                mat.node_tree.links.remove(link)
        mat.node_tree.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
        if 'Alpha' in bsdf.inputs:
            bsdf.inputs['Alpha'].default_value = 0.999
        if 'Roughness' in bsdf.inputs:
            bsdf.inputs['Roughness'].default_value = 1.0
        if 'Metallic' in bsdf.inputs:
            bsdf.inputs['Metallic'].default_value = 0.0

    return leaf_index


def reshape_leaf_vertices(obj: bpy.types.Object, leaf_index: int) -> None:
    mesh = obj.data
    leaf_vertex_indices = {
        vertex_index
        for poly in mesh.polygons
        if poly.material_index == leaf_index
        for vertex_index in poly.vertices
    }
    if not leaf_vertex_indices:
        raise RuntimeError('Leaf material has no vertices assigned')

    coords = [mesh.vertices[index].co.copy() for index in leaf_vertex_indices]
    min_x = min(v.x for v in coords)
    max_x = max(v.x for v in coords)
    min_y = min(v.y for v in coords)
    max_y = max(v.y for v in coords)
    min_z = min(v.z for v in coords)
    max_z = max(v.z for v in coords)
    center = Vector(((min_x + max_x) * 0.5, (min_y + max_y) * 0.5, (min_z + max_z) * 0.5))
    height = max_z - min_z

    for index in leaf_vertex_indices:
        vertex = mesh.vertices[index]
        relative = vertex.co - center
        vertical_t = 0.0 if height <= 0 else (vertex.co.z - min_z) / height

        # Yew leaves should read as a compact evergreen crown. Keep the same
        # silhouette family, but make it denser, a little narrower at the top,
        # and slightly fuller around the lower/middle canopy.
        horizontal_scale = 0.94 - max(0.0, vertical_t - 0.55) * 0.18
        if 0.15 < vertical_t < 0.58:
            horizontal_scale += 0.07

        relative.x *= horizontal_scale
        relative.y *= horizontal_scale
        relative.z *= 1.04
        vertex.co = center + relative

    mesh.update()


def setup_origin_and_names(obj: bpy.types.Object) -> None:
    obj.name = 'yewtree'
    obj.data.name = 'yewtree'
    for mat in obj.data.materials:
        if mat and mat.name == 'color_0':
            mat.name = 'yew_bark'
            mat.diffuse_color = (0.22, 0.13, 0.065, 1.0)

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)


def export() -> None:
    clear_scene()
    if DEFAULT_TEXTURE_VARIANT not in TEXTURE_VARIANTS:
        known = ', '.join(sorted(TEXTURE_VARIANTS))
        raise RuntimeError(f'Unknown YEW_TEXTURE_VARIANT={DEFAULT_TEXTURE_VARIANT!r}; expected one of: {known}')
    variant_names = sorted(TEXTURE_VARIANTS) if EXPORT_ALL_TEXTURE_VARIANTS else [DEFAULT_TEXTURE_VARIANT]
    textures = make_yew_textures(variant_names)

    bpy.ops.import_scene.gltf(filepath=str(SOURCE_GLB))
    obj = first_mesh_object()
    leaf_index = replace_leaf_material(obj, textures[DEFAULT_TEXTURE_VARIANT], DEFAULT_TEXTURE_VARIANT)
    reshape_leaf_vertices(obj, leaf_index)
    setup_origin_and_names(obj)

    SOURCE_BLEND.parent.mkdir(parents=True, exist_ok=True)
    OUT_GLB.parent.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.save_as_mainfile(filepath=str(SOURCE_BLEND))
    bpy.ops.export_scene.gltf(
        filepath=str(OUT_GLB),
        export_format='GLB',
        export_yup=True,
        export_apply=False,
        export_materials='EXPORT',
        export_image_format='AUTO',
    )

    print(f'Wrote {SOURCE_BLEND.relative_to(PROJECT_ROOT)}')
    for variant_name, texture_path in textures.items():
        print(f'Wrote {variant_name}: {texture_path.relative_to(PROJECT_ROOT)}')
    print(f'Wrote {OUT_GLB.relative_to(PROJECT_ROOT)}')


if __name__ == '__main__':
    export()
