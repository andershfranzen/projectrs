# EvilQuest Browser Profiler

Use this to compare local vs live, or Chrome vs Brave, with the same in-game scene/FPS snapshot that `/perf` sends.
By default CPU sampling starts after the game is logged in and ready, so the
profile reflects steady-state gameplay rather than login/loading work.

## Live Chrome

```bash
PROFILE_AUTORUN=1 PROFILE_SECONDS=20 bun tools/browser-profiler.mjs https://evilquest.net/play
```

## Local Chrome

```bash
PROFILE_AUTORUN=1 PROFILE_SECONDS=20 bun tools/browser-profiler.mjs http://localhost:4000/play
```

## Windows Brave

Run from PowerShell. By default the profiler uses an isolated temp profile, not
your normal Brave profile. Either run it once without autorun and log in there,
or set `CHROME_PROFILE_DIR` to a dedicated profile directory you want to reuse.

For the current Brave profile/tab that already reproduces the low FPS, the
shortest workflow is:

```powershell
.\tools\profile-windows-brave.ps1
```

If PowerShell blocks local scripts, run it as
`powershell -ExecutionPolicy Bypass -File .\tools\profile-windows-brave.ps1`.

Close Brave fully first, let the script start Brave with a DevTools port, log in
to EvilQuest, wait until the bad FPS is visible, then type `capture` in the
profiler terminal. After it writes the run, type `quit` to return to
PowerShell. The run is written under `tools/profiler-runs/`.

To also create a zip of the newest profiler run after you type `quit`:

```powershell
.\tools\profile-windows-brave.ps1 -ZipLatest
```

The helper runs `diagnose-profiler-run.mjs` on the newly-created capture before
it zips anything. That writes `diagnosis.txt` and `diagnosis.json` into the run
folder, so the zip includes the likely-cause summary alongside the raw profiler
files.

```powershell
$env:BROWSER_BIN = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
$env:CHROME_PROFILE_DIR = "$env:TEMP\evilquest-profiler-brave"
$env:PROFILE_AUTORUN = "1"
$env:PROFILE_SECONDS = "20"
bun tools/browser-profiler.mjs https://evilquest.net/play
```

For a first Brave run where you need to log in manually, leave autorun unset:

```powershell
$env:BROWSER_BIN = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe"
$env:CHROME_PROFILE_DIR = "$env:TEMP\evilquest-profiler-brave"
$env:PROFILE_SECONDS = "20"
bun tools/browser-profiler.mjs https://evilquest.net/play
```

Log in inside the opened Brave tab, wait until the game is running, then type
`capture` in the profiler terminal. `capture` records the current tab without a
reload. Use `go` when you want a clean reload before recording.

To profile the exact Brave profile/tab that already reproduces the low FPS,
close Brave fully, start Brave with a DevTools port, open the game, log in,
then attach to that tab instead of creating an isolated profile:

```powershell
Start-Process "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe" "--remote-debugging-port=9223 --enable-precise-memory-info https://evilquest.net/play"

$env:CDP_PORT = "9223"
$env:PROFILE_ATTACH_EXISTING_CDP = "1"
$env:PROFILE_SECONDS = "20"
bun tools/browser-profiler.mjs https://evilquest.net/play
```

In attach mode, `capture` records the current tab without reload, and autorun
also captures without reload unless `PROFILE_RELOAD_BEFORE_CAPTURE=1` is set.
The profiler does not close browsers it did not launch.

If Brave is already using the default DevTools port, add a different one:

```powershell
$env:CDP_PORT = "9223"
```

Outside attach mode, the profiler creates a fresh tab through Chrome DevTools
for every run, so extension tabs, startup tabs, and restored sessions should not
steal the capture.

## Output

Each run writes a timestamped folder under `tools/profiler-runs/`:

- `summary.json` - CPU hot spots, browser timing summaries, resource summaries, and the EvilQuest snapshot inline.
- `page-diagnostics.json` - browser, viewport, build/resource fingerprint, storage-presence, and WebGL renderer info even if login/game readiness fails.
- `browser-diagnostics.json` - Chrome/Brave process diagnostics from DevTools, including GPU devices and feature status.
- `evilquest-snapshot.json` - measured FPS, renderer, WebGL flags, canvas size, mesh/vertex counts, map/player position.
- `cpu-profile.json` - raw Chrome DevTools CPU profile.
- `browser-stats.json` - long tasks, slow callbacks, resources, fetches, WebSockets.
- `console.json` - browser console and exception logs.

Older deployed client bundles may not include the in-client snapshot API yet.
For those builds, the profiler falls back to `window.gm.engine` and
`window.gm.scene` and writes `snapshot.snapshotSource: "profiler-fallback"`.
That fallback still captures the high-signal live-vs-local fields: measured
FPS, renderer, canvas scale, mesh/vertex/index counts, terrain detail counts,
and scene-budget buckets.

The command also prints the same high-signal snapshot fields to the terminal:
FPS, renderer, flags, canvas/DPR, frame pacing, active/pickable mesh counts,
terrain detail counts, and the top scene-budget buckets.

To include page load, asset loading, and login startup in the CPU profile, set:

```bash
PROFILE_CAPTURE_STARTUP=1
```

For the Brave issue, compare `evilquest-snapshot.json` between Chrome and Brave. The highest-signal fields are:

- `snapshot.measuredFps`
- `snapshot.framePacing` (median/p95/max frame interval; separates a stable ~30 Hz cap from irregular stalls)
- `snapshot.diagnosticFlags`
- `snapshot.webgl.unmaskedRenderer`
- `snapshot.browser.connection`, `snapshot.browser.media`, `snapshot.browser.screen`
- `snapshot.canvas`
- `snapshot.activeMeshes`, `snapshot.totalVertices`, `snapshot.totalIndices`
- `snapshot.sceneBudget.summary.activePickableMeshes`
- `snapshot.chunkMeshes.terrainDetail.grassBladeBatchMaxRebuildMs`
- `snapshot.chunkMeshes.terrainDetail.grassBladeBatchRebuilds`
- `snapshot.sceneBudget.activeByName`
- `snapshot.sceneBudget.activePickableByName`

You can diff two profiler run directories directly:

```bash
bun tools/compare-profiler-runs.mjs tools/profiler-runs/<chrome-run> tools/profiler-runs/<brave-run>
```

The comparison includes page diagnostics, client build/resource fingerprints,
the in-game snapshot when available, browser-process GPU diagnostics, resource
timing, fetch timing, long tasks, slow callbacks, and CPU self-time. That makes
it useful for separating live/local network and asset-loading differences from
renderer/GPU backend differences.

With no arguments it compares the latest two run directories:

```bash
bun tools/compare-profiler-runs.mjs
```

To diagnose one run by itself, pass the run directory. With no arguments it
diagnoses the latest run:

```bash
bun tools/diagnose-profiler-run.mjs tools/profiler-runs/<run>
bun tools/diagnose-profiler-run.mjs --write
```

`--write` adds `diagnosis.txt` and `diagnosis.json` to the run directory. The
single-run diagnosis is meant for the Windows Brave case where the first
question is whether the bad tab is using SwiftShader/software rendering, a
stable 30 Hz cadence, a masked renderer, a high-DPR canvas, low-battery/browser
efficiency conditions, or an incomplete login-screen capture.

If a live run reports `hasGameManager: false` and the body text is the login
screen, it did not capture steady-state gameplay. Reuse a logged-in
`CHROME_PROFILE_DIR`, run once without autorun and log in there, or inject auth
with the variables below. In that case, `page-diagnostics.json` can still show
whether the browser is using SwiftShader/software WebGL, but it does not prove
in-game FPS. `compare-profiler-runs.mjs` can compare these partial runs
directly, so keep the folder even when the snapshot is skipped.

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
