#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${BLENDER_BIN:-}" ]]; then
  if [[ -x /opt/blender-current/blender ]]; then
    BLENDER_BIN=/opt/blender-current/blender
  elif [[ -x /usr/bin/blender ]]; then
    BLENDER_BIN=/usr/bin/blender
  else
    BLENDER_BIN=/snap/bin/blender
  fi
fi
ADDON_PATH="${BLENDER_MCP_ADDON:-$HOME/Downloads/blender-mcp-main/addon.py}"
MCP_PORT="${BLENDER_MCP_PORT:-9876}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ "${BLENDER_FORCE_X11:-1}" != "0" ]]; then
  export WAYLAND_DISPLAY=
  export XDG_SESSION_TYPE=x11
  export GDK_BACKEND=x11
  export QT_QPA_PLATFORM=xcb
  export SDL_VIDEODRIVER=x11
fi

args=()
if [[ "${BLENDER_FACTORY_STARTUP:-1}" != "0" ]]; then
  args+=(--factory-startup)
fi
args+=(--window-geometry 80 80 1200 850)
if [[ $# -gt 0 ]]; then
  args+=("$@")
fi

export BLENDER_MCP_ADDON="$ADDON_PATH"
export BLENDER_MCP_PORT="$MCP_PORT"

exec "$BLENDER_BIN" "${args[@]}" --python "$SCRIPT_DIR/start_mcp.py"
