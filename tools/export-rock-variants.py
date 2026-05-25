#!/usr/bin/env python3
"""Export edited RPG rock Blender sources as ore-coloured GLB variants.

Run with:
  blender --background --python tools/export-rock-variants.py

The material colours are copied from the current in-game rock GLBs, then
roughness is forced to 1.0 for the exported variants.
"""

from __future__ import annotations

import os
from mathutils import Vector

import bpy


PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
OUT_DIR = os.path.join(PROJECT_ROOT, 'client', 'public', 'assets', 'models')
TARGET_MAX_DIMENSION = 0.95

SOURCE_VARIANTS = [
    ('2', os.environ.get('RPG_ROCK2_BLEND', '/home/nick/Downloads/rpgRock2.blend')),
    ('3', os.environ.get('RPG_ROCK3_BLEND', '/home/nick/Downloads/rpgRock3.blend')),
]

REFERENCE_ROCKS = {
    'CopperRock': 'client/public/assets/models/CopperRock.glb',
    'TinRock': 'client/public/assets/models/TinRock.glb',
    'IronRock': 'client/public/assets/models/IronRock.glb',
    'CoalRock': 'client/public/assets/models/CoalRock.glb',
    'SilverRock': 'client/public/assets/models/SilverRock.glb',
    'MithrilRock': 'client/public/assets/models/MithrilRock.glb',
}

CLAY_ROCK_MATERIALS = [
    {
        'name': 'clay_body',
        'diffuse': (0.384, 0.255, 0.039, 1.0),
        'base': (0.384, 0.255, 0.039, 1.0),
        'metallic': 0.0,
        'roughness': 1.0,
        'alpha': 1.0,
    },
    {
        'name': 'clay_middle',
        'diffuse': (0.592, 0.357, 0.031, 1.0),
        'base': (0.592, 0.357, 0.031, 1.0),
        'metallic': 0.0,
        'roughness': 1.0,
        'alpha': 1.0,
    },
    {
        'name': 'clay_bottom',
        'diffuse': (0.310, 0.129, 0.000, 1.0),
        'base': (0.310, 0.129, 0.000, 1.0),
        'metallic': 0.0,
        'roughness': 1.0,
        'alpha': 1.0,
    },
]

DEPLETED_ROCK_MATERIALS = [
    {
        'name': 'depleted_body',
        'diffuse': (0.068, 0.068, 0.068, 1.0),
        'base': (0.068, 0.068, 0.068, 1.0),
        'metallic': 0.0,
        'roughness': 1.0,
        'alpha': 1.0,
    },
    {
        'name': 'depleted_mix',
        'diffuse': (0.068, 0.068, 0.068, 1.0),
        'base': (0.068, 0.068, 0.068, 1.0),
        'metallic': 0.0,
        'roughness': 1.0,
        'alpha': 1.0,
    },
    {
        'name': 'depleted_bottom',
        'diffuse': (0.044, 0.044, 0.044, 1.0),
        'base': (0.044, 0.044, 0.044, 1.0),
        'metallic': 0.0,
        'roughness': 1.0,
        'alpha': 1.0,
    },
    {
        'name': 'depleted_highlight',
        'diffuse': (0.068, 0.068, 0.068, 1.0),
        'base': (0.068, 0.068, 0.068, 1.0),
        'metallic': 0.0,
        'roughness': 1.0,
        'alpha': 1.0,
    },
]


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
        raise RuntimeError('No mesh objects found')
    return max(meshes, key=lambda obj: len(obj.data.polygons))


def world_bounds(obj: bpy.types.Object) -> tuple[float, float, float, float, float, float]:
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return bounds_for_points(points)


def bounds_for_points(points: list[Vector]) -> tuple[float, float, float, float, float, float]:
    return (
        min(point.x for point in points),
        max(point.x for point in points),
        min(point.y for point in points),
        max(point.y for point in points),
        min(point.z for point in points),
        max(point.z for point in points),
    )


def scene_mesh_bounds() -> tuple[float, float, float, float, float, float]:
    points: list[Vector] = []
    for obj in bpy.context.scene.objects:
        if obj.type == 'MESH':
            points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        raise RuntimeError('No mesh bounds found')
    return bounds_for_points(points)


def read_material(mat: bpy.types.Material) -> dict[str, object]:
    bsdf = mat.node_tree.nodes.get('Principled BSDF') if mat.use_nodes and mat.node_tree else None

    def input_value(name: str, fallback):
        if bsdf and name in bsdf.inputs:
            return bsdf.inputs[name].default_value
        return fallback

    return {
        'name': mat.name,
        'diffuse': tuple(mat.diffuse_color),
        'base': tuple(input_value('Base Color', mat.diffuse_color)),
        'metallic': float(input_value('Metallic', 0.0)),
        'roughness': 1.0,
        'alpha': float(input_value('Alpha', mat.diffuse_color[3] if len(mat.diffuse_color) > 3 else 1.0)),
    }


def make_material(definition: dict[str, object]) -> bpy.types.Material:
    mat = bpy.data.materials.new(str(definition['name']))
    mat.diffuse_color = definition['diffuse']
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get('Principled BSDF')
    if bsdf:
        if 'Base Color' in bsdf.inputs:
            bsdf.inputs['Base Color'].default_value = definition['base']
        if 'Metallic' in bsdf.inputs:
            bsdf.inputs['Metallic'].default_value = definition['metallic']
        if 'Roughness' in bsdf.inputs:
            bsdf.inputs['Roughness'].default_value = 1.0
        if 'Alpha' in bsdf.inputs:
            bsdf.inputs['Alpha'].default_value = definition['alpha']
    return mat


def load_reference_materials() -> tuple[dict[str, list[dict[str, object]]], float]:
    refs: dict[str, list[dict[str, object]]] = {}
    target_footprint = 1.0

    for asset_id, rel_path in REFERENCE_ROCKS.items():
        clear_scene()
        bpy.ops.import_scene.gltf(filepath=os.path.join(PROJECT_ROOT, rel_path))
        obj = first_mesh_object()
        refs[asset_id] = [read_material(mat) for mat in obj.data.materials]
        bounds = world_bounds(obj)
        footprint = max(bounds[1] - bounds[0], bounds[3] - bounds[2])
        if asset_id == 'CopperRock':
            target_footprint = footprint
        print(f'Read {asset_id} material setup: {[m["name"] for m in refs[asset_id]]}')

    refs['ClayRock'] = CLAY_ROCK_MATERIALS
    return refs, target_footprint


def assign_face_materials(obj: bpy.types.Object, material_defs: list[dict[str, object]]) -> dict[int, int]:
    mesh = obj.data
    mesh.materials.clear()
    for mat in list(bpy.data.materials):
        bpy.data.materials.remove(mat)

    for definition in material_defs:
        mesh.materials.append(make_material(definition))

    for poly in mesh.polygons:
        poly.material_index = 0

    face_count = len(mesh.polygons)
    if face_count == 0:
        return {}

    centers = [obj.matrix_world @ poly.center for poly in mesh.polygons]
    normals = [(obj.matrix_world.to_3x3() @ poly.normal).normalized() for poly in mesh.polygons]
    z_min = min(center.z for center in centers)
    z_max = max(center.z for center in centers)
    z_range = max(z_max - z_min, 0.00001)

    names = [str(definition['name']).lower() for definition in material_defs]
    bottom_idx = next((i for i, name in enumerate(names) if 'bottom' in name), None)
    middle_idx = next((i for i, name in enumerate(names) if 'mix' in name or 'middle' in name), None)
    highlight_idx = next((i for i, name in enumerate(names) if 'highlight' in name), None)
    used: set[int] = set()

    def normalized_z(index: int) -> float:
        return (centers[index].z - z_min) / z_range

    if bottom_idx is not None:
        count = max(1, round(face_count * 18 / 136))
        for index in sorted(range(face_count), key=lambda i: (centers[i].z, normals[i].z))[:count]:
            mesh.polygons[index].material_index = bottom_idx
            used.add(index)

    if highlight_idx is not None:
        count = max(1, round(face_count * 20 / 136))
        candidates = [i for i in range(face_count) if i not in used]

        def highlight_score(index: int) -> float:
            return normalized_z(index) + max(normals[index].z, 0.0) * 0.65 - abs(centers[index].x) * 0.03

        for index in sorted(candidates, key=highlight_score, reverse=True)[:count]:
            mesh.polygons[index].material_index = highlight_idx
            used.add(index)

    if middle_idx is not None:
        count = max(1, round(face_count * 12 / 136))
        candidates = [i for i in range(face_count) if i not in used]

        def middle_score(index: int) -> float:
            return abs(normalized_z(index) - 0.48) + abs(normals[index].z) * 0.3 + abs(centers[index].y) * 0.025

        for index in sorted(candidates, key=middle_score)[:count]:
            mesh.polygons[index].material_index = middle_idx
            used.add(index)

    return {
        index: sum(1 for poly in mesh.polygons if poly.material_index == index)
        for index in range(len(mesh.materials))
    }


def prepare_source_mesh(source_path: str, target_footprint: float) -> bpy.types.Object:
    if not os.path.exists(source_path):
        raise FileNotFoundError(f'Rock source blend does not exist: {source_path}')

    bpy.ops.wm.open_mainfile(filepath=source_path)
    obj = first_mesh_object()

    for other in list(bpy.context.scene.objects):
        if other != obj:
            bpy.data.objects.remove(other, do_unlink=True)

    bounds = world_bounds(obj)
    footprint = max(bounds[1] - bounds[0], bounds[3] - bounds[2])
    if footprint <= 0:
        raise RuntimeError(f'Invalid source rock bounds: {source_path}')

    scale = target_footprint / footprint
    obj.scale = (obj.scale.x * scale, obj.scale.y * scale, obj.scale.z * scale)
    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    obj.data.update()
    print(f'Prepared {source_path}: scale={scale:.6f}, faces={len(obj.data.polygons)}')
    return obj


def export_variants() -> None:
    material_defs_by_asset, target_footprint = load_reference_materials()
    os.makedirs(OUT_DIR, exist_ok=True)
    exported_paths: list[str] = []

    for suffix, source_path in SOURCE_VARIANTS:
        obj = prepare_source_mesh(source_path, target_footprint)
        for base_asset_id, material_defs in material_defs_by_asset.items():
            asset_id = f'{base_asset_id}{suffix}'
            obj.name = asset_id
            obj.data.name = f'{asset_id}Mesh'
            counts = assign_face_materials(obj, material_defs)

            bpy.ops.object.select_all(action='DESELECT')
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            output_path = os.path.join(OUT_DIR, f'{asset_id}.glb')
            bpy.ops.export_scene.gltf(
                filepath=output_path,
                export_format='GLB',
                use_selection=True,
                export_materials='EXPORT',
                export_apply=True,
            )
            exported_paths.append(output_path)
            print(f'Exported {output_path}: material face counts={counts}')

        asset_id = f'DepletedRock{suffix}'
        obj.name = asset_id
        obj.data.name = f'{asset_id}Mesh'
        counts = assign_face_materials(obj, DEPLETED_ROCK_MATERIALS)

        bpy.ops.object.select_all(action='DESELECT')
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        output_path = os.path.join(OUT_DIR, f'{asset_id}.glb')
        bpy.ops.export_scene.gltf(
            filepath=output_path,
            export_format='GLB',
            use_selection=True,
            export_materials='EXPORT',
            export_apply=True,
        )
        exported_paths.append(output_path)
        print(f'Exported {output_path}: material face counts={counts}')

    for output_path in exported_paths:
        normalize_exported_glb(output_path)


def normalize_exported_glb(output_path: str) -> None:
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=output_path)
    bounds = scene_mesh_bounds()
    dims = (
        bounds[1] - bounds[0],
        bounds[3] - bounds[2],
        bounds[5] - bounds[4],
    )
    max_dim = max(dims)
    if max_dim <= 0:
        raise RuntimeError(f'Invalid exported bounds for {output_path}')

    scale = TARGET_MAX_DIMENSION / max_dim
    bpy.ops.object.select_all(action='DESELECT')
    first_selected: bpy.types.Object | None = None
    for obj in bpy.context.scene.objects:
        if obj.type != 'MESH':
            continue
        obj.scale = (obj.scale.x * scale, obj.scale.y * scale, obj.scale.z * scale)
        obj.select_set(True)
        if first_selected is None:
            first_selected = obj
    if first_selected is None:
        raise RuntimeError(f'No mesh object selected for normalization: {output_path}')
    bpy.context.view_layer.objects.active = first_selected
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format='GLB',
        use_selection=True,
        export_materials='EXPORT',
        export_apply=True,
    )
    normalized_dims = tuple(round(dim * scale, 3) for dim in dims)
    print(f'Normalized {os.path.basename(output_path)} to max dimension {TARGET_MAX_DIMENSION}: {normalized_dims}')


if __name__ == '__main__':
    export_variants()
