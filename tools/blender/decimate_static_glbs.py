#!/usr/bin/env python3
"""Decimate static GLB meshes in place.

Run with Blender:
  blender --background --python tools/blender/decimate_static_glbs.py -- file.glb ...
"""

from __future__ import annotations

import sys

import bpy


def decimate(path: str, ratio: float = 0.35) -> None:
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    bpy.ops.import_scene.gltf(filepath=path)

    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            continue
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        mod = obj.modifiers.new("EvilQuest_runtime_decimate", "DECIMATE")
        mod.ratio = ratio
        mod.use_collapse_triangulate = True
        bpy.ops.object.modifier_apply(modifier=mod.name)
        obj.select_set(False)

    bpy.ops.export_scene.gltf(filepath=path, export_format="GLB")
    print(f"decimated {path}")


def main() -> None:
    if "--" not in sys.argv:
        raise SystemExit("Pass GLB paths after --")
    for path in sys.argv[sys.argv.index("--") + 1:]:
        decimate(path)


if __name__ == "__main__":
    main()
