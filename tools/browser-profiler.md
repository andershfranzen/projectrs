# EvilQuest Browser Profiler

Use this to compare local vs live, or Chrome vs Brave, with the same in-game scene/FPS snapshot that `/perf` sends.

## Live Chrome

```bash
PROFILE_AUTORUN=1 PROFILE_SECONDS=20 bun tools/browser-profiler.mjs https://evilquest.net/play
```

## Local Chrome

```bash
PROFILE_AUTORUN=1 PROFILE_SECONDS=20 bun tools/browser-profiler.mjs http://localhost:4000/play
```

## Windows Brave

Run from PowerShell after logging into the game once in that browser profile:

```powershell
$env:BROWSER_BIN = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
$env:PROFILE_AUTORUN = "1"
$env:PROFILE_SECONDS = "20"
bun tools/browser-profiler.mjs https://evilquest.net/play
```

If Brave is already using the default DevTools port, add a different one:

```powershell
$env:CDP_PORT = "9223"
```

## Output

Each run writes a timestamped folder under `tools/profiler-runs/`:

- `summary.json` - CPU hot spots, browser timing summaries, and the EvilQuest snapshot inline.
- `evilquest-snapshot.json` - measured FPS, renderer, WebGL flags, canvas size, mesh/vertex counts, map/player position.
- `cpu-profile.json` - raw Chrome DevTools CPU profile.
- `browser-stats.json` - long tasks, slow callbacks, resources, fetches, WebSockets.
- `console.json` - browser console and exception logs.

For the Brave issue, compare `evilquest-snapshot.json` between Chrome and Brave. The highest-signal fields are:

- `snapshot.measuredFps`
- `snapshot.diagnosticFlags`
- `snapshot.webgl.unmaskedRenderer`
- `snapshot.canvas`
- `snapshot.activeMeshes`, `snapshot.totalVertices`, `snapshot.totalIndices`

## Optional Auth Injection

The profiler can reuse an existing login session without manual browser setup:

```bash
PROFILE_AUTH_TOKEN=<token> \
PROFILE_AUTH_USERNAME=<username> \
PROFILE_WS_SECRET=<eq_ws_session_value> \
PROFILE_DEVICE_ID=<eq_device_id_value> \
PROFILE_AUTORUN=1 \
bun tools/browser-profiler.mjs http://localhost:4000/play
```

On local dev, these values live in the `sessions` table. On live, use this only from a trusted admin shell/profile.
