# Bot Flag False-Positive Review

Source of truth reviewed: `server/src/BotStats.ts`, `server/src/network/GameSocket.ts`, `tools/bot-review.ts`.

## Main Takeaways

- Treat flags as **review signals**, not ban reasons. `reservedActionCapability`, `adminOpcodeAbuse`, and `reservedMapDataPath` are the clearest "explain this before trusting the client" integrity signals.
- The live `BotStats` scorer is mostly conservative: diagnostic/context flags do not score unless they are also evidence flags. `tools/bot-review.ts` has an older fallback path that can still score some diagnostic/context flags if stored risk is missing.
- Timing flags are the highest false-positive risk because browsers, OS scheduling, local testing, low-latency play, and server-side tick mechanics can look robotic.
- Absence-of-telemetry flags are useful for finding raw clients, but false-positive on unsupported browsers, blocked scripts, page lifecycle throttling, stale bundles, or network/send failures.

## Implemented Fixes

- Split **scored evidence** from **standalone hard evidence**. Weak integrity/activity signals still appear in review, but no longer uncap risk by themselves.
- Standalone hard evidence is now limited to strong timing evidence, `browserlessActiveGameplay`, `reservedActionCapability`, `adminOpcodeAbuse`, and `reservedMapDataPath`.
- `protocolPackets`, `rateLimitPackets`, `automationInvalidPackets`, `deviceRotating`, `mapDataScrape`, `mapDataOutOfScope`, `fastReaction`, `xpVelocity:<skill>`, and lifetime invalid-packet signals are still review evidence, but capped unless paired with hard evidence.
- `tools/bot-review.ts` now uses the same hard-evidence list for its fallback cap, instead of treating diagnostic/context flags as hard.
- Reserved action-capability honeypots now include duplicate traps for real visible actions. One is flagged for official clients to ignore; one is unflagged but placed before the real token, so the official client's last-write behavior overwrites it while bots that pick the first plausible token poison their own command proof.
- Admin-facing `automationInvalidPackets` copy now says `Invalid input telemetry`, not `Malformed client telemetry`.

## Flag Audit

| Flag | Current category | False-positive paths | Recommendation |
| --- | --- | --- | --- |
| `tickAligned` | diagnostic | Server actions resolve on ticks, so everyone can converge here. | Keep diagnostic only; never score. |
| `pingRegular` | diagnostic | Stable browser timer, quiet local network, desktop foreground tab. | Keep diagnostic; do not use as hard evidence. |
| `pingSeqReset` | diagnostic | Reconnects, page reloads, socket replacement, heartbeat race. | Keep diagnostic only. Also remove fallback scoring in `tools/bot-review.ts`. |
| `activityHeartbeatCoupled` | diagnostic | Activity happens near heartbeat by chance; simple client implementation sends both from nearby callbacks. | Keep diagnostic/context only. |
| `activityRegular` | diagnostic | Repeated keyboard/mouse habits, game loops, accessibility tools, OS event batching. | Keep diagnostic only; fallback CLI should not treat as hard. |
| `activitySeqReset` | diagnostic | Reloads/reconnects reset the client sequence counter. | Keep diagnostic only. Remove fallback scoring. |
| `legacyActivityTelemetry` | diagnostic | Old deployed bundle, cached client, partial rollout. | Keep as rollout/debug signal, not bot evidence. |
| `noClientActivityTelemetry` | diagnostic | Browser event hooks not installed yet, script blocker, focus/iframe oddity, stale client. | Keep diagnostic; pair with gameplay/input-ticket failure before action. |
| `noCursorTelemetry` | diagnostic | Touch devices, keyboard-only play, pointermove throttling, browser privacy tooling. | Keep diagnostic; current mobile suppression is good. |
| `cursorStatic` | diagnostic | Trackpad/touchscreen, keyboard-heavy play, windowed game with parked cursor, accessibility devices. | Keep diagnostic; never standalone. |
| `gameplayCommandCadenceRegular` | evidence | Human grinding with metronomic tick feedback, macros, or very short repetitive tasks; server receive timing can compress bursts. | Evidence, but require sustained sample and corroboration before manual action. |
| `sameCommandCadenceRegular` | evidence | Repeated legitimate action on a resource/NPC with rhythm. | Evidence only when paired with loop/context; avoid standalone bans. |
| `gameplayCommandSequencePattern` | context | Normal training cycles can repeat command order. | Keep context-only. |
| `gameplayCommandIntervalPattern` | evidence | Repeated human routine, content with fixed timers, network batching. | Evidence, but review command details and duration. |
| `rapidGameplayCommandCadence` | evidence | Double-clicks, burst clicks, high-skill players, touch events firing multiple commands. | Good bot signal only for sustained run; current desktop/mobile split helps. |
| `mechanicalJitter` | evidence | Human rhythm over one narrow task, low sample diversity, server/network regularization. | Evidence, but inspect task and sample count. |
| `moderateMechanicalJitter` | evidence | Same as above, plus it is gated by route/order/cursor context that can be legitimate grinding. | Do not let this stand alone in moderation decisions. |
| `browserlessActiveGameplay` | evidence | Client failed to send telemetry, stale bundle, script blocked, telemetry hooks broke. | Strong raw-client signal, but first check client version/logs and session environment. |
| `inputlessCommandBurst` | context | Input ticket lost due send ordering, reconnect, first commands after load, keyboard path. | Keep context; avoid fallback hard evidence. |
| `commandsWithoutRecentInput` | evidence | Legit input telemetry dropped/throttled, background/foreground transition, network queue. | Evidence, but require repeated sessions or pair with browserless/command cadence. |
| `commandsWithoutRecentActivity` | evidence | Same as above, activity-only telemetry path broke while commands still work. | Evidence; strong only with zero telemetry or raw-client indicators. |
| `inputlessCommandRatio` | context | A few missing tickets in a small command sample. | Keep context; do not hard-score in fallback tooling. |
| `activitylessCommandRatio` | context | Activity path broken, but input tickets still present; browser quirk. | Keep context; do not hard-score in fallback tooling. |
| `pointerNoApproachShape` | context | Click without prior move, gaming mouse, touch misclassified as mouse, already-hovered target. | Keep context-only. |
| `inputTicketTargetFanout` | context | Dense UI/viewport cell, NPC stack, repeated clicks near one screen area. | Keep context-only. |
| `protocolPackets` | evidence | Stale client/protocol mismatch, deployment race, corrupted frames, local tests. | Evidence for client integrity, not botting; avoid action from short zero-minute sessions. |
| `rateLimitPackets` | evidence | Lag flush, stuck key/mouse, reconnect backlog, accidental spam. | Evidence for abuse only when sustained and not per-action throttle noise. |
| `automationInvalidPackets` | evidence | Old/broken client telemetry, extension interference, version skew. | Rename admin label to "Invalid input telemetry"; weak standalone bot signal. |
| `reservedActionCapability` | evidence | Legit client should not send it; false positives mostly test/dev/protocol bug. | Strong integrity evidence. Verify not local/test/stale deployment. |
| `honeypotActionCapability` | legacy evidence | Historical audit-log name for the same class as `reservedActionCapability`. | Treat as `reservedActionCapability`; current code normalizes the legacy name. |
| `adminOpcodeAbuse` | evidence | False positive only if role/session state is wrong or test client used. | Strong security evidence. |
| `lifetimeHardInvalidPackets` | evidence | Accumulates old protocol/deploy issues across sessions. | Keep but decay/reset after protocol migrations or deploy incidents. |
| `mapDataScrape` | evidence | Initial streaming/preload burst, browser cache disabled, local profiler, editor/dev tooling. | Evidence only outside known preload/dev paths; local audit showed this can hit dev accounts. |
| `mapDataOutOfScope` | evidence | Streaming window bug, map transition race, auth/session mismatch. | Stronger than scrape, but inspect map/session state before action. |
| `reservedMapDataPath` | evidence | Broken client URL construction, stale route, manual testing. | Strong integrity signal; still verify route/deploy context. |
| `deviceRotating` | evidence | Privacy tools, cleared storage, multiple browsers/devices, shared computer. | Useful account-cycling context, not bot behavior. Pair with IP/trade/activity evidence. |
| `noChat` | context | Many legitimate players never chat while grinding. | Keep context-only. |
| `pathRepetitive` | context | Legit skilling/combat loops repeatedly target one tile. | Keep context-only. |
| `noMoveRedirects` | context | Careful players click only final destinations; short/simple routes. | Keep context-only. |
| `maxPathCommandRatio` | context | Clicking far destinations is normal traversal behavior. | Keep context-only. |
| `pathTruncationPattern` | context | Client/server pathing mismatch, wall/door bug, map collision issue. | Treat as bug lead first, bot context second. |
| `postDeathRouteLoop` | context | Human returns to corpse/training spot after death. | Keep context; only suspicious with automation timing. |
| `routeActionLoop` | context | Core MMORPG gameplay is loops. | Keep context-only; never proof. |
| `lifetimePathConcentration` | context | Long-term main training spot or shop route. | Keep context-only. |
| `lifetimeRouteActionLoop` | context | Same as above over lifetime. | Keep context-only. |
| `noIdleBreaks` | context | Dedicated long play session, AFK threshold too high/low, active event tracking misses microbreaks. | Keep context-only. |
| `marathonNoIdleBreaks` | context | Marathon human sessions exist; idle break detection may miss real breaks. | Review-only lifestyle signal. |
| `marathonSession` | context | Legit marathon play. | Review-only, not bot evidence. |
| `lifetimeLowSocialHighActivity` | context | Solo grinders and quiet players. | Keep context-only. |
| `lifetimeExtremeLowSocialHighActivity` | context | Same, stronger but still lifestyle. | Keep context-only unless paired with hard automation. |
| `fastReaction` | evidence | Server event ordering, multi-combat chaos, already-clicked target, target dies just before next queued swing. | Evidence only after inspecting combat scenario; median threshold is aggressive. |
| `xpVelocity:<skill>` | evidence | XP grants/quests, admin/test changes, short baseline windows, skill key mismatch, content balancing mistakes. | Require session/activity minimums plus per-content audit before action. |
| `lifetimeHardEvidence` | scored risk signal | Repeated false positives compound, especially after deploy/protocol bugs. | Add decay/reset tooling; do not let old incidents permanently convict. |

## Tooling False-Positive Surface

`tools/bot-review.ts` has a fallback scorer used when stored `bot_stats.risk_score` is zero. The fallback still shows old audit-log context, but it now uses the same narrow standalone hard-evidence list as `BotStats` before uncapping risk.

Remaining caution: the fallback can still add low-risk points from old audit rows. That is useful for review ordering, but should not be treated as a ban reason without inspecting the underlying sessions.

## Suggested Category Changes

- Keep hard/integrity: `reservedActionCapability`, `adminOpcodeAbuse`, `reservedMapDataPath`.
- Keep evidence but require corroboration/manual inspection: timing flags, browserless/input-missing flags, protocol/rate-limit/telemetry invalid flags, map scraping/out-of-scope, `deviceRotating`, `fastReaction`, `xpVelocity`.
- Keep context only: path/route/lifestyle/social flags and input-shape fanout.
- Keep diagnostic only: tick, ping, activity timing/sequence, absent cursor/activity telemetry, static cursor.

## Verification

Current flag list was derived from every `flags.push(...)` in `server/src/BotStats.ts`. `xpVelocity:<skill>` is counted as one flag family because the emitted suffix is data-dependent. `honeypotActionCapability` is included separately because historical audit rows may still display it.

Focused verification: `bun test server/src/BotStats.test.ts server/test/bot-guardrails.test.ts server/test/action-capabilities.test.ts server/src/entity/Player.security.test.ts client/src/managers/GameManager.input.test.ts client/src/managers/NetworkManager.security.test.ts`; `bunx tsc --noEmit -p tsconfig.json --pretty false`.
