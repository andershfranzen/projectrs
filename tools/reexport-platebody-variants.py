import argparse
import os
import sys

import bpy


def hex_to_rgba(hex_color):
    hex_color = hex_color.strip().lstrip("#")
    return (*[int(hex_color[i : i + 2], 16) / 255.0 for i in (0, 2, 4)], 1.0)


def set_material_color(material, hex_color):
    rgba = hex_to_rgba(hex_color)
    material.diffuse_color = rgba
    material.use_nodes = True
    bsdf = material.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = rgba
        bsdf.inputs["Roughness"].default_value = 1.0
        bsdf.inputs["Metallic"].default_value = 0.0


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete()
    for collection in (
        bpy.data.meshes,
        bpy.data.armatures,
        bpy.data.materials,
        bpy.data.images,
        bpy.data.actions,
    ):
        for item in list(collection):
            collection.remove(item)


def export_variant(source, output, main_hex, dark_hex):
    clear_scene()
    bpy.ops.import_scene.gltf(filepath=source)

    materials = list(bpy.data.materials)
    by_name = {mat.name: mat for mat in materials}
    if "Material.003" in by_name:
        set_material_color(by_name["Material.003"], main_hex)
    elif materials:
        set_material_color(materials[0], main_hex)

    if "Material.004" in by_name:
        set_material_color(by_name["Material.004"], dark_hex)
    elif len(materials) > 1:
        set_material_color(materials[1], dark_hex)

    os.makedirs(os.path.dirname(output), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        export_skins=True,
        export_animations=False,
        use_selection=False,
    )


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True)
    parser.add_argument("--out-dir", required=True)
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    args = parser.parse_args(argv)

    variants = {
        "BronzePlatebody.glb": ("#160400", "#050100"),
        "IronPlatebody.glb": ("#0D0C0C", "#040404"),
        "SteelPlatebody.glb": ("#8592A3", "#232932"),
        "BlackBronzePlatebody.glb": ("#020202", "#000000"),
    }

    for filename, (main_hex, dark_hex) in variants.items():
        export_variant(args.source, os.path.join(args.out_dir, filename), main_hex, dark_hex)


if __name__ == "__main__":
    main()
