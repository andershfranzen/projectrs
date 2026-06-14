# Walk Stutter Diagnostics

Date: 2026-06-12

This note preserves the current debugging state for the city-route walking/camera spikes.

## User-visible symptom

- Walking in normal/less dense areas improved after walk/camera changes.
- Spikes still happen on the city route.
- It looks like a periodic lag/catch-up while walking, but it is not clearly just camera lag anymore.
- With later diagnostics, the spikes became less consistent but still happened.

## What was tried

1. Walk animation sampling was changed in `client/src/rendering/AnimationQuantizer.ts`.
   - `walk` quantization changed from 5 frames to 9 frames.
   - Walk sample curve changed from 5 canonical ratios to 9 evenly spaced samples.
   - User result: walking looked better.

2. Camera follow was changed in `client/src/rendering/Camera.ts`.
   - Original smoothed target follow was replaced by direct camera target snapping.
   - `GameManager` now calls `this.camera.followTarget(this._tempVec, dt)`.
   - User result: better, but spikes remained.
   - Interpretation: camera smoothing was not the only/root cause.

3. Placed-object visual diagnostic was added in `client/src/rendering/ChunkManager.ts`.
   - `DIAGNOSTIC_HIDE_PLACED_OBJECT_VISUALS = true`.
   - All placed object visuals are forced disabled.
   - Same-runtime-chunk object visibility refresh was bypassed by setting `objectChanged = false`.
   - User result: spikes still happened in the city.
   - Interpretation: active placed-object visuals and the 4-tile object visibility bucket are probably not the primary cause.

4. Minimap diagnostic was added in `client/src/managers/GameManager.ts`.
   - `DIAGNOSTIC_DISABLE_MINIMAP_UPDATES = true`.
   - `updateMinimap()` returns immediately.
   - User result: spikes still happened, maybe less consistently.
   - Interpretation: minimap is not the primary cause, though it may have contributed some cost.

5. Frame-spike profiler was started but not fully finished before shutdown.
   - Added constants:
     - `DIAGNOSTIC_FRAME_PROFILER = true`
     - `DIAGNOSTIC_FRAME_SPIKE_MS = 32`
     - `DIAGNOSTIC_FRAME_LOG_COOLDOWN_MS = 250`
   - Added `FrameProfileSlice`.
   - Added fields:
     - `frameProfileSlices`
     - `frameProfileOverlay`
     - `lastFrameProfileLogAt`
   - Render loop now measures total frame time, `update()`, and `scene.render()`.
   - Added methods:
     - `profileFrameSlice`
     - `ensureFrameProfileOverlay`
     - `reportFrameProfile`
   - Important: detailed per-section `profileFrameSlice(...)` wrappers have not been added to `update()` yet, so current profiler mostly reports `update`, `scene.render`, and outside-frame time.
   - Typecheck has not been run after this partial profiler edit.

## Current local code state

Changed files from this diagnostic session:

- `client/src/rendering/AnimationQuantizer.ts`
- `client/src/rendering/Camera.ts`
- `client/src/rendering/ChunkManager.ts`
- `client/src/managers/GameManager.ts`
- `WALK_STUTTER_DIAGNOSTICS.md`

Unrelated pre-existing dirty files seen in `git status`:

- `client/public/assets/models/rice.glb`
- `client/src/rendering/ItemIcon.test.ts`
- `server/data/items.json`
- `client/public/assets/models/HumanHeart.glb`
- `client/public/assets/models/RiceCooked.glb`
- `client/public/assets/models/RicePlant.glb`
- `client/public/assets/models/RiceRaw.glb`

Do not revert or overwrite those unrelated files.

## 2026-06-13 continuation

- Pulled `origin/main` after stashing local WIP; branch is now up to date at `e958ea6`.
- Reapplied the stash and resolved the only conflict in `client/src/managers/GameManager.ts`.
  - The new upstream 60 FPS render limiter is preserved.
  - The frame-spike profiler now measures only rendered frames and reports the real rendered-frame gap.
- `profileFrameSlice(...)` wrappers are now present inside `private update(dt: number): void`.
- `bun run typecheck:app` passes.
- `bun run build:client` passes.
- Dev servers were started:
  - server: `http://localhost:4000`
  - client: `http://localhost:5173/play`
- Later comparison runs showed the new 60 FPS render limiter did not belong on live:
  - Removed the limiter from the main game loop and character creator preview.
  - Deleted `client/src/util/frameLimiter.ts` and `client/src/util/frameLimiter.test.ts`.

The stash entry `stash@{0}` is still present as a safety copy because `git stash pop` hit a conflict.

## Current diagnostic flags still active

- `client/src/rendering/ChunkManager.ts`
  - `DIAGNOSTIC_HIDE_PLACED_OBJECT_VISUALS = false`
  - `DIAGNOSTIC_DISABLE_PLACED_OBJECT_CHUNK_LOADING = false`
  - Placed-object visuals and object chunk loading are restored.

- `client/src/managers/GameManager.ts`
  - `DIAGNOSTIC_DISABLE_MINIMAP_UPDATES = false`
  - Minimap updates are restored.
  - Frame-spike monitoring is split:
    - Live-safe telemetry is enabled for >50ms frame gaps and posts to `/api/client-log` at most once every 10 seconds per client.
    - The visible overlay, detailed per-slice profiling, console `[frame-spike]` logs, and WebGL GPU timer query are opt-in with `?framestats=1` or `localStorage.evilquest_frame_spike_profiler=1`.
    - GPU timing can also be forced with `?gputimer=1` or `localStorage.evilquest_frame_spike_gpu_timer=1`.

- `client/src/rendering/Camera.ts`
  - camera target snaps directly to the local player

## Verification already done before the partial profiler edit

- `bun run typecheck:app` passed after the walk/camera changes.
- `bun run typecheck:app` passed after camera snap.
- `bun run typecheck:app` passed after object-visual diagnostics.
- `bun run typecheck:app` passed after minimap disable.

Verified after the frame-spike profiler additions:

- `bun run typecheck:app`
- `bun run build:client`

Additional 2026-06-13 finding:

- A clean route after the limiter was removed still produced movement-time spikes.
- Shape of the route spikes:
  - `updateMs` usually ~0.1-0.3ms
  - `renderMs` usually ~4-6ms
  - `outsideMeasuredFrameMs` usually ~45-55ms, sometimes higher
  - `longTasks` empty
  - `chunkChanged` false
- Early GPU-timer samples during startup/reconnect showed very low GPU frame time (~0.2-0.3ms), but a clean route pass with GPU timing still needs to be captured.
- Conclusion: remove/keep removed the 60 FPS limiter for live, but the remaining city-route stutter is still an RAF/compositor/scheduler gap outside measured JS. Next clean capture should use the new `gpuFrameMs` field to confirm whether GPU render time stays low during the route itself.

GPU-timed clean route result:

- A clean route pass after GPU timing went live produced 10 spike records.
- Averages:
  - `rafGapMs`: 65.7ms
  - `updateMs`: 0.26ms
  - `renderMs`: 4.34ms
  - `outsideMeasuredFrameMs`: 61.1ms
  - `gpuFrameMs`: 0.40ms
- `longTasks` stayed empty and `chunkChanged` stayed false.
- This rules out game update, Babylon render time, chunk streaming, and GPU draw time as the direct source of the route spikes in this capture.
- Next useful comparison: walk the same route on the built client served by the Bun server (`http://localhost:4000/play`) instead of Vite (`http://localhost:5173/play`) to rule out Vite/HMR/dev-client scheduling effects.

Built-client comparison result:

- Walking the route on `http://localhost:4000/play` still produced the same spike shape.
- Latest built-client pass produced 11 spike records.
- Averages:
  - `rafGapMs`: 66.4ms
  - `updateMs`: 0.27ms
  - `renderMs`: 4.71ms
  - `outsideMeasuredFrameMs`: 61.4ms
  - `gpuFrameMs`: 0.45ms
- `longTasks` stayed empty and `chunkChanged` stayed false.
- This rules out Vite/HMR/dev-client scheduling effects. The remaining route stutter is outside game JS, Babylon render, GPU draw time, chunk streaming, and Vite.

Firefox comparison result:

- Walking the same route in Firefox on `http://localhost:4000/play` produced 10 spike records.
- Averages:
  - `rafGapMs`: 43.5ms
  - `updateMs`: 0.0ms reported by the profiler in this run
  - `renderMs`: 7.6ms including one 32.0ms render outlier
  - `renderMs` excluding the outlier: 4.9ms
  - `outsideMeasuredFrameMs`: 35.9ms
- `longTasks` stayed empty.
- GPU timing was unavailable in Firefox (`gpu=n/a`), but the normal render frames were still around 3-6ms.
- This makes the issue look browser/compositor/scheduler-level rather than Chrome-only or game-loop-only. Firefox has shorter reported gaps than Chrome in this pass, but the same broad pattern remains: most spike time is outside the measured game update/render slices.

Clean Chrome X11 comparison result:

- Launched a separate Chrome profile at `/tmp/evilquest-clean-chrome-x11-profile`.
- Flags included:
  - `--ozone-platform=x11`
  - `--disable-extensions`
  - `--disable-sync`
  - `--no-first-run`
- The route produced 3 spike records total.
- One was a startup/reconnect spike at the starting tile:
  - `rafGapMs`: 269.2ms
  - `updateMs`: 8.6ms, mostly `chunk update`
  - `renderMs`: 5.4ms
  - `outsideMeasuredFrameMs`: 255.2ms
  - `gpuFrameMs`: 0.4ms
- Excluding that startup/reconnect spike, the route produced only 2 movement-time spikes:
  - average `rafGapMs`: 52.3ms
  - average `updateMs`: 0.2ms
  - average `renderMs`: 4.8ms
  - average `outsideMeasuredFrameMs`: 47.3ms
  - average `gpuFrameMs`: 0.2ms
- This is materially better than the normal Chrome built-client run (11 spikes) and Firefox run (10 spikes), but it changes two variables at once: clean profile/extensions disabled and Wayland -> X11.
- Next comparison should isolate those variables if we keep investigating:
  - clean Chrome Wayland, or
  - normal-profile-equivalent Chrome X11.

Clean Chrome Wayland comparison result:

- Launched a separate Chrome profile at `/tmp/evilquest-clean-chrome-wayland-profile`.
- Flags included:
  - `--ozone-platform=wayland`
  - `--disable-extensions`
  - `--disable-sync`
  - `--no-first-run`
- The route produced 4 spike records after reconnect.
- One was a startup/reconnect spike at the starting tile:
  - `rafGapMs`: 107.7ms
  - `updateMs`: 7.3ms, mostly `chunk update`
  - `renderMs`: 5.4ms
  - `outsideMeasuredFrameMs`: 95.0ms
  - `gpuFrameMs`: 3.4ms
- Two additional spikes happened while still standing at the starting tile:
  - `rafGapMs`: 32.0ms and 49.4ms
  - `renderMs`: 3.3ms and 3.7ms
  - `outsideMeasuredFrameMs`: 28.3ms and 45.3ms
  - `gpuFrameMs`: 0.1ms and 0.1ms
- Only one movement-time route spike was captured:
  - `rafGapMs`: 51.2ms
  - `updateMs`: 0.1ms
  - `renderMs`: 4.6ms
  - `outsideMeasuredFrameMs`: 46.5ms
  - `gpuFrameMs`: 0.2ms
- Clean Chrome Wayland is also materially better than the normal Chrome built-client run (11 spikes) and Firefox run (10 spikes).
- Because clean Wayland and clean X11 both improved, X11 itself is probably not the main factor. The stronger lead is normal Chrome profile/session state, especially extensions or background profile services.

Normal Chrome without AdNauseam launch flag:

- Closed the normal Chrome parent process that had:
  - `--load-extension=/home/nick/.local/share/adnauseam/adnauseam.chromium`
- Relaunched the normal profile directly with:
  - `/opt/google/chrome/chrome --new-window http://localhost:4000/play`
- Verified the AdNauseam unpacked-extension path was no longer present in Chrome process args.
- Chrome still had normal profile extension/background processes, so this isolated the explicit AdNauseam launch flag but did not create a clean profile.
- The run had a reconnect in the middle, so split results by segment:

First segment after relaunch:

- 6 spike records total.
- 3 standing/startup spikes at or near the starting tile:
  - included one 53.0ms browser Long Task and one chunk-update-heavy startup frame.
- 3 movement-time spikes:
  - `rafGapMs`: 146.9ms, 54.3ms, 150.9ms
  - `updateMs`: 0.1ms, 0.2ms, 0.3ms
  - `renderMs`: 3.8ms, 4.4ms, 5.1ms
  - `outsideMeasuredFrameMs`: 143.0ms, 49.7ms, 145.5ms
  - `gpuFrameMs`: 0.3ms for all three

Second segment after reconnect:

- 5 spike records total.
- 1 startup/reconnect spike:
  - `rafGapMs`: 134.6ms
  - `updateMs`: 5.9ms, mostly `chunk update`
  - `renderMs`: 5.7ms
  - `outsideMeasuredFrameMs`: 122.9ms
  - `gpuFrameMs`: 0.4ms
- 4 movement-time spikes:
  - `rafGapMs`: 37.8ms, 43.0ms, 32.1ms, 32.3ms
  - `updateMs`: 0.1-0.2ms
  - `renderMs`: 4.0-4.6ms
  - `outsideMeasuredFrameMs`: 27.4-38.4ms
  - `gpuFrameMs`: 0.5ms

Interpretation:

- Removing AdNauseam's explicit launch flag did not reproduce the clean-profile result.
- The first no-AdNauseam segment still had large movement-time compositor/RAF gaps with very low update/render/GPU cost.
- The second segment was closer to clean-profile behavior but still had more movement spikes than clean Wayland.
- The remaining lead is broader normal-profile state: other extensions, profile services, cached/session state, or Chrome profile background work. AdNauseam may contribute, but it is not proven as the only cause from this pass.

Automated browser route runner:

- Added an opt-in client hook at `?autowalk=1`:
  - `window.__evilQuestAutoWalk.ready()`
  - `window.__evilQuestAutoWalk.state()`
  - `window.__evilQuestAutoWalk.walkTo(x, z)`
  - `window.__evilQuestAutoWalk.walkRoute(route, opts)`
- Added `tools/route-stutter-browser-test.ts`.
  - Creates a disposable test account.
  - Places it at `{ x: 78.5, z: 20.5 }` on `kcmap`.
  - Opens the built client at `http://localhost:4000/play?autowalk=1&framestats=1`.
  - Walks the route:
    - `{ x: 78.5, z: 50.5 }`
    - `{ x: 77.5, z: 32.5 }`
    - `{ x: 78.5, z: 20.5 }`
  - Collects `[frame-spike]` console payloads and writes JSON reports under `tmp/route-stutter-browser-tests/`.
  - Default matrix now uses only isolated disposable profiles:
    - `chrome-stable-wayland-clean`
    - `chrome-stable-x11-clean`
    - `chrome-stable-wayland-adnauseam-clean`
  - Optional runs can be selected with `EQ_BROWSER_RUNS=...`, including:
    - `brave-local-wayland-clean`
    - `brave-local-x11-clean`
    - `snap-chromium-wayland-clean`
    - `playwright-firefox-clean`
    - `playwright-webkit-clean`
    - copied normal-profile runs, which are intentionally opt-in.

Automated run results:

- `tmp/route-stutter-browser-tests/report-2026-06-13T16-25-00-720Z.json`
  - `chrome-stable-wayland-clean`: 0 spikes
  - `chrome-stable-x11-clean`: 0 spikes
  - `chrome-stable-wayland-adnauseam-clean`: 0 spikes
- `tmp/route-stutter-browser-tests/report-2026-06-13T16-25-54-375Z.json`
  - `snap-chromium-wayland-clean`: 0 spikes
- `tmp/route-stutter-browser-tests/report-2026-06-13T16-31-21-249Z.json`
  - `brave-local-wayland-clean`: 0 spikes
  - Brave was unpacked locally from the official Brave apt package into `tmp/browsers/brave/`.
- After restoring placed-object visuals/loading and minimap updates, rebuilding the client, and making the profiler opt-in:
  - `tmp/route-stutter-browser-tests/report-2026-06-13T16-40-30-520Z.json`
  - `brave-local-x11-clean`: 0 spikes
  - `tmp/route-stutter-browser-tests/report-2026-06-13T16-42-14-663Z.json`
  - `chrome-stable-wayland-clean`: 0 spikes
  - A combined Chrome Wayland + Brave Wayland rebuilt-client pass also had `chrome-stable-wayland-clean`: 0 spikes before the Brave Wayland child exited and left the wrapper waiting, so no combined report was written.
- Earlier successful isolated runs:
  - `report-2026-06-13T16-05-34-116Z.json`: `playwright-firefox-clean`: 0 spikes
  - `report-2026-06-13T16-10-25-365Z.json`: clean Chrome Wayland/X11: 0 spikes
  - `report-2026-06-13T16-15-27-378Z.json`: clean Chrome Wayland + AdNauseam: 0 spikes
- `playwright-webkit-clean` is currently blocked by missing host libraries:
  - `libicu74`
  - `libxml2`
  - `libmanette-0.2-0`
  - `libwoff1`
- A later Firefox rerun had the browser child disappear while the Bun/Playwright wrapper kept waiting. The old stuck wrapper process and disposable Firefox profile were removed; Firefox remains opt-in.
- A copied normal-profile run without AdNauseam returned 0 spikes in console, but the following copied-profile + AdNauseam run hung before the combined report was written. Treat that result as useful but not persisted.

Automated-run interpretation:

- The route stutter is not reproducible with controlled autowalk in isolated Chrome Wayland, Chrome X11, Brave Wayland, Snap Chromium Wayland, or the earlier isolated Firefox run.
- Loading AdNauseam alone into a clean Chrome profile is not sufficient to reproduce the stutter.
- The strongest remaining lead is the live normal Chrome session/profile state:
  - existing extension/background renderer processes,
  - restored tabs/profile services,
  - compositor/session state,
  - or a manual-interaction-only behavior not exercised by the autowalk hook.
- Caveat: autowalk uses the same ground-click path internally, but it does not reproduce all human input/pointer behavior or the full live Chrome tab/session environment.

Live-player diagnostics posture:

- Keep the one-shot `client_low_fps_snapshot` path. It captures renderer/browser/canvas/scene-budget details when a player has sustained low FPS after login warmup.
- Keep throttled `client_frame_spike` telemetry. It captures noticeable >50ms frame gaps without showing players the debug overlay.
- Use `/api/admin/client-diagnostics` or the admin panel client diagnostics tab to inspect live reports by event, user, or search query.
- For targeted local/admin reproduction, open `/play?framestats=1` to re-enable the visible overlay, detailed per-update slices, console `[frame-spike]` payloads, and GPU timing.

Frame pace implementation:

- Added a persisted Settings -> Graphics -> Frame Pace control:
  - `Smooth`: render every display frame.
  - `Battery`: keep update/input/camera on every RAF, but pace only `scene.render()`.
- Battery mode estimates the display refresh from RAF intervals, then chooses a clean display divisor capped around 60 rendered FPS:
  - ~120 Hz -> ~60 FPS
  - ~144 Hz -> ~48 FPS
  - ~165 Hz -> ~55 FPS
  - ~240 Hz -> ~60 FPS
  - low-refresh displays stay native if a divisor would drop below ~45 FPS.
- This avoids the failed limiter behavior because it does not skip game update, local movement prediction, camera follow, input, or HTML overlay updates.
- `client_frame_spike` and perf snapshots now include `framePace.mode`, estimated display Hz, target render FPS, render count, and skipped render count.
- The route harness supports `EQ_FRAME_PACE=smooth|battery`.

Frame pace verification:

- `tmp/route-stutter-browser-tests/report-2026-06-13T17-24-30-797Z.json`
  - Chrome Wayland, `EQ_FRAME_PACE=smooth`: 0 spikes
- `tmp/route-stutter-browser-tests/report-2026-06-13T17-28-14-200Z.json`
  - Chrome Wayland, `EQ_FRAME_PACE=battery`: 0 spikes
  - Final diagnostics:
    - `framePaceMode`: `battery`
    - `estimatedDisplayHz`: 238.1
    - `targetRenderFps`: 59.5
    - `renderCount`: 2747
    - `skippedRenderCount`: 7835

## Next exact steps

1. Stop doing same-browser/same-settings manual repeats unless a code, browser, profile, or session variable changes.
2. Focus the next manual pass on the live normal Chrome profile/session:
   - Chrome task manager during the route to look for extension/profile renderer CPU spikes.
   - Normal Chrome with extensions disabled from `chrome://extensions`.
   - A fresh normal-profile restart with restored tabs closed, if the task manager points at tab/session work.
3. Capture browser-level traces if Chrome task manager does not separate the issue:
   - Chrome Performance trace with screenshots/compositor categories.
   - Firefox profiler capture around the route.
4. Before shipping:
   - Keep the 60 FPS limiter removed.
   - Remove or gate the diagnostic profiler.
   - Re-enable placed-object visuals/loading and minimap updates.
   - Keep the profiler findings in this note for future performance work.

## Likely next targets if profiler points there

- City texture planes and structural meshes:
  - `ChunkManager.setTexturePlaneChunkEnabled`
  - `texturePlanesByChunk`
  - `texturePlaneRevealEntriesByChunk`

- Roof/indoor logic:
  - `GameManager.updateIndoorDetection`
  - `GameManager.recomputeHiddenRoofs`
  - `GameManager.refreshHoverRoofForStoredPointer`
  - `ChunkManager.getCeilingHeight`
  - `ChunkManager.isUnderRoof`
  - `ChunkManager.getRoofNodesNear`
  - `ChunkManager.getNodesAboveHeight`

- Terrain chunk building/visibility:
  - `ChunkManager.updatePlayerPosition`
  - `ChunkManager.buildQueuedGameChunks`
  - `ChunkManager.setChunkMeshesEnabled`
  - `ChunkManager.evictTerrainChunkCache`

## Important conclusion so far

The city-route spike is probably not caused by camera smoothing alone, visible placed-object meshes, same-chunk placed-object visibility bucket flips, minimap updates, Vite, game update cost, Babylon render cost, or GPU draw time. It also does not reproduce in controlled isolated-browser autowalk runs across Chrome, Brave, Chromium, and Firefox. The next useful move is profiling the live normal Chrome session/profile, not more blind game-render toggles.
