import importlib.util
import os
import traceback

import bpy
from bpy.props import BoolProperty, EnumProperty, FloatProperty, IntProperty, StringProperty


def _ensure_scene_props():
    print("Preparing Blender MCP scene properties", flush=True)
    props = {
        "blendermcp_port": IntProperty(name="Port", default=9876, min=1024, max=65535),
        "blendermcp_server_running": BoolProperty(name="Server Running", default=False),
        "blendermcp_use_polyhaven": BoolProperty(name="Use Poly Haven", default=False),
        "blendermcp_use_hyper3d": BoolProperty(name="Use Hyper3D Rodin", default=False),
        "blendermcp_hyper3d_mode": EnumProperty(
            name="Rodin Mode",
            items=[
                ("MAIN_SITE", "hyper3d.ai", "hyper3d.ai"),
                ("FAL_AI", "fal.ai", "fal.ai"),
            ],
            default="MAIN_SITE",
        ),
        "blendermcp_hyper3d_api_key": StringProperty(name="Hyper3D API Key", subtype="PASSWORD", default=""),
        "blendermcp_use_hunyuan3d": BoolProperty(name="Use Hunyuan 3D", default=False),
        "blendermcp_hunyuan3d_mode": EnumProperty(
            name="Hunyuan3D Mode",
            items=[
                ("LOCAL_API", "local api", "local api"),
                ("OFFICIAL_API", "official api", "official api"),
            ],
            default="LOCAL_API",
        ),
        "blendermcp_hunyuan3d_secret_id": StringProperty(name="Hunyuan 3D SecretId", default=""),
        "blendermcp_hunyuan3d_secret_key": StringProperty(
            name="Hunyuan 3D SecretKey",
            subtype="PASSWORD",
            default="",
        ),
        "blendermcp_hunyuan3d_api_url": StringProperty(name="API URL", default="http://localhost:8081"),
        "blendermcp_hunyuan3d_octree_resolution": IntProperty(
            name="Octree Resolution",
            default=256,
            min=128,
            max=512,
        ),
        "blendermcp_hunyuan3d_num_inference_steps": IntProperty(
            name="Number of Inference Steps",
            default=20,
            min=20,
            max=50,
        ),
        "blendermcp_hunyuan3d_guidance_scale": FloatProperty(
            name="Guidance Scale",
            default=5.5,
            min=1.0,
            max=10.0,
        ),
        "blendermcp_hunyuan3d_texture": BoolProperty(name="Generate Texture", default=False),
        "blendermcp_use_sketchfab": BoolProperty(name="Use Sketchfab", default=False),
        "blendermcp_sketchfab_api_key": StringProperty(name="Sketchfab API Key", subtype="PASSWORD", default=""),
    }

    for name, prop in props.items():
        if not hasattr(bpy.types.Scene, name):
            setattr(bpy.types.Scene, name, prop)


def _start_server():
    addon_path = os.environ.get("BLENDER_MCP_ADDON", os.path.expanduser("~/Downloads/blender-mcp-main/addon.py"))
    port = int(os.environ.get("BLENDER_MCP_PORT", "9876"))

    try:
        print(f"Starting Blender MCP bootstrap from {addon_path}", flush=True)
        if not os.path.exists(addon_path):
            print(f"Blender MCP addon not found: {addon_path}")
            return None

        print("Loading Blender MCP addon module", flush=True)
        spec = importlib.util.spec_from_file_location("blendermcp_addon", addon_path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        print("Loaded Blender MCP addon module", flush=True)

        _ensure_scene_props()
        print("Prepared Blender MCP scene properties", flush=True)
        bpy.context.scene.blendermcp_port = port

        old_server = getattr(bpy.types, "blendermcp_server", None)
        if old_server:
            print("Stopping previous Blender MCP server", flush=True)
            old_server.stop()

        print("Creating Blender MCP server", flush=True)
        server = module.BlenderMCPServer(port=port)
        bpy.types.blendermcp_server = server
        bpy.types.blendermcp_module = module
        print("Starting Blender MCP server thread", flush=True)
        server.start()
        bpy.context.scene.blendermcp_server_running = True
        print(f"Started Blender MCP server on port {port}")
    except Exception:
        traceback.print_exc()

    return None


delay = float(os.environ.get("BLENDER_MCP_DELAY", "2.0"))
print(f"Scheduling Blender MCP bootstrap in {delay} seconds", flush=True)
bpy.app.timers.register(_start_server, first_interval=delay)
