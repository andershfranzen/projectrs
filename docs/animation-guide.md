# Animation Guide — OSRS-Style Animations for EvilQuest

This document covers how to create animations that match the snappy, puppet-like feel of Old School RuneScape. Our system uses a Mixamo-rigged character with a quantization pipeline that resamples any source animation down to a fixed number of keyframes played at a target duration.

You don't need to worry about frame rates or Babylon.js internals — just create good poses in Blender and export a GLB. The code handles the rest.

---

## How the System Works

The animation pipeline:
1. You create an animation in Blender with **N keyframes** (any frame rate)
2. Export as `.glb` (armature only, no mesh)
3. Drop it in `client/public/Character models/animations/`
4. At runtime, the **AnimationQuantizer** resamples your animation into a fixed number of frames and plays it at the configured duration

Current timing targets:

| Animation | Frames | Duration | Notes |
|-----------|--------|----------|-------|
| idle | 8 | 3.6s | Very subtle, barely-moving loop |
| walk | 6 | 0.8s | Brisk toy-soldier gait |
| run | 6 | 0.7s | Faster walk variant |
| attack | 5 | 0.5s | Generic melee |
| attack_slash | 5 | 0.5s | Sword/axe swing |
| attack_punch | 4 | 0.4s | Unarmed/fist |
| bow_attack | 5 | 0.6s | Ranged draw + release |
| chop | 5 | 0.8s | Woodcutting loop |
| mine | 5 | 1.0s | Mining loop |
| death | 6 | 1.2s | One-shot collapse |

The game tick is **600ms**. Attack animations must complete within a single tick (under 600ms) so the player sees immediate feedback.

---

## The 4 Rules of OSRS Animation Style

1. **Few poses with huge deltas** — 4-5 keyframes per action, with big rotation jumps between them
2. **No ease-in/ease-out** — Linear or Constant interpolation only
3. **Exaggerated anticipation** — The windup pose is massive, the swing is instant
4. **Rigid body parts** — Each limb moves as a solid piece. No subtle wrist rolls, no independent spine segments

---

## Blender Setup

### Opening the Character

1. Import `client/public/Character models/main character.glb` (File > Import > glTF)
2. Select the Armature > switch to **Pose Mode**
3. Open the **Dope Sheet** > switch to **Action Editor**
4. Create a new Action (click the **New** button, name it to match the animation: `attack_slash`, `walk`, etc.)

### Frame Range

Set your timeline range based on the animation type:
- Attack animations: **frames 1-5**
- Walk cycle: **frames 1-6**
- Idle: **frames 1-8**
- Mining/chopping: **frames 1-5**
- Death: **frames 1-6**

The exact frame count in Blender doesn't have to match the quantizer's target — the quantizer resamples to the target count. But keeping them close avoids information loss.

### Interpolation (Critical)

After posing your first two keyframes:
1. Select all keyframes in the Dope Sheet (`A`)
2. Press `T` > choose **Linear**

This removes Bezier ease-in/ease-out and gives you the snappy, puppet-like transitions that define the OSRS look.

For an even more faithful OSRS feel, try **Constant** interpolation — this gives true frame-by-frame stepping where the character teleports between poses with zero in-between. The quantizer handles both correctly. Experiment and see which you prefer.

---

## Animation Breakdowns

### Attack Slash (5 poses)

| Frame | Pose | Key Bones |
|-------|------|-----------|
| 1 | **Idle ready** — weapon at side, neutral stance | All at rest pose |
| 2 | **Windup** — torso rotates ~45 degrees away from swing, sword arm pulled behind head. Exaggerate hard. | Spine +45deg, RightUpperArm -80deg, RightForeArm -40deg |
| 3 | **Swing mid** — arm whipping forward, torso unwinding, weapon horizontal | Spine -20deg, RightUpperArm +60deg, RightForeArm -10deg |
| 4 | **Impact** — arm fully extended, weapon pointing forward/down, torso overrotated past center | Spine -30deg, RightUpperArm +90deg, RightForeArm +20deg |
| 5 | **Settle** — returning toward rest, slight lean remains (follow-through) | Relaxing back |

Tips:
- The 2 > 3 transition should be the BIGGEST delta. That's the "snap."
- Rotate the whole torso, not just the arm. Spine rotation sells melee attacks.
- Hips stay mostly still (grounded feel).
- At 0.5s total, each frame is ~100ms. Windup holds for 100ms, then the swing happens in 200ms (frames 3-4).

### Attack Punch (4 poses)

| Frame | Pose |
|-------|------|
| 1 | Neutral stance |
| 2 | Arm coiled back, fist at shoulder height, torso wound up |
| 3 | Full extension — arm straight out, fist forward, torso turned INTO the punch |
| 4 | Recoil — arm half-back, slight bounce |

Even more exaggerated than slash — you only have 4 frames at 0.4s total.

### Walk Cycle (6 poses, looping)

| Frame | Pose |
|-------|------|
| 1 | **Contact** — left leg forward (heel strike), right arm forward. Wide stride. |
| 2 | **Down** — weight dropping onto left foot, slight crouch |
| 3 | **Pass** — right leg swings through, both legs nearly vertical |
| 4 | **Contact (mirror)** — right leg forward, left arm forward |
| 5 | **Down (mirror)** — weight on right foot |
| 6 | **Pass (mirror)** — left leg swings through |

OSRS walk feel:
- Stride is **wider than realistic** — legs spread far at contact poses
- Arms swing **more than natural** — like a toy soldier marching
- Visible **vertical bob** — hips drop 2-3cm on the "down" frames
- Head stays level (barely moves while hips bob)
- At 0.8s per loop with ~3 tiles/sec movement, each step covers ~1.2 tiles

### Idle (8 poses, looping)

Extremely subtle — barely perceptible breathing:
- Spine bends forward ~2-3 degrees then back over 8 frames (sine wave)
- Shoulders rise slightly on "inhale" frames (2-4), drop on "exhale" (6-8)
- Head tilts 1-2 degrees side to side
- Arms stay basically still

At 3.6s this loops very slowly. OSRS characters are near-static when idle. Don't over-animate this.

### Mining / Woodcutting (5 poses, looping)

| Frame | Pose |
|-------|------|
| 1 | **Raised** — tool above head, arms up, slight lean back |
| 2 | **Downswing** — arms at ~45 degrees, body moving forward |
| 3 | **Impact** — tool hits target, arms fully extended DOWN, spine bent 20-30 degrees forward |
| 4 | **Bounce** — tool bounces back slightly, spine begins to straighten |
| 5 | **Recovery** — returning toward raised position |

The impact frame (3) needs a hard spine crunch. In OSRS, the character really FOLDS into the rock/tree on impact.

### Death (6 poses, one-shot)

| Frame | Pose |
|-------|------|
| 1 | Standing (last combat pose or idle) |
| 2 | Stagger — knees buckle, torso lurches forward |
| 3 | Collapse — legs give out, falling to knees |
| 4 | Tipping — torso falling forward/sideways |
| 5 | Ground — lying flat or crumpled |
| 6 | Settled — final resting pose (held until respawn) |

---

## What Kills the OSRS Feel

Avoid these:

- **Subtle wrist rotations** — OSRS hands are rigid blocks. Don't add finger or wrist detail.
- **Bezier/smooth curves** — Use Linear or Constant interpolation ONLY.
- **Realistic timing** — Real sword swings take 300ms. OSRS exaggerates the windup to make 5 frames readable at speed.
- **Independent spine segments** — Only rotate Spine and Spine1. Keep the torso as one rigid piece. Don't use Spine2 independently.
- **Shoulder shrug on attacks** — Keep shoulders pinned. Let the elbow and forearm do the work.
- **Head movement during attacks** — Head stays facing forward, doesn't track.
- **Foot sliding on walk** — Match stride length to movement speed.
- **Too many in-between poses** — If you're tempted to add frame 2.5 to smooth a transition, DON'T. The abruptness IS the style.
- **Fingers and toes** — Don't animate them. They're invisible at game zoom level and waste authoring time.

---

## Export Settings

When your animation is ready:

1. Select **only the Armature** (not the mesh)
2. File > Export > glTF 2.0 (`.glb`)
3. Configure:
   - Format: **glTF Binary (.glb)**
   - Include: **Selected Objects** only
   - Transform: **+Y Up** (default)
   - Animation: **Checked**
   - Animation > Always Sample: **Checked**
   - Animation > Sampling Rate: **1** (every frame)
   - Mesh: **Unchecked** (we only need animation data)
   - Shape Keys: **Unchecked**
4. Save to `client/public/Character models/animations/<name>.glb`
   - Use the exact name the system expects: `idle.glb`, `walk.glb`, `attack.glb`, `attack_slash.glb`, `attack_punch.glb`, `chop.glb`, `mine.glb`, etc.

---

## Iteration Workflow

1. Pose your keyframes in Blender
2. Export GLB (armature only, animations sampled at rate 1)
3. Drop the file in `client/public/Character models/animations/`
4. Refresh the browser — the quantizer resamples and plays at the configured duration
5. Evaluate in-game at actual game zoom level, not in Blender's viewport

**Timing feels wrong?** Adjust `ANIM_DURATIONS` in `client/src/rendering/AnimationQuantizer.ts` — don't change your Blender frame count.

**Poses don't read clearly?** Make the rotation deltas BIGGER. If it looks absurdly exaggerated in Blender's viewport at 24fps, it'll probably look perfect in-game at 5 frames over 0.5 seconds at game camera distance.

**Animation looks floaty?** Switch interpolation from Linear to Constant in Blender, or reduce your frame count by one.

---

## Skeleton Reference

The character uses a Mixamo-prefixed skeleton. Key bones you'll animate most:

**Upper body (attacks, skills):**
- `mixamorig:Spine` — main torso rotation (most important for melee attacks)
- `mixamorig:Spine1` — upper chest
- `mixamorig:RightUpperArm` / `mixamorig:LeftUpperArm` — shoulders
- `mixamorig:RightForeArm` / `mixamorig:LeftForeArm` — elbows
- `mixamorig:RightHand` / `mixamorig:LeftHand` — wrists (keep these mostly static)

**Lower body (walk, run):**
- `mixamorig:Hips` — root motion, vertical bob
- `mixamorig:RightUpLeg` / `mixamorig:LeftUpLeg` — thigh swing
- `mixamorig:RightLeg` / `mixamorig:LeftLeg` — knee bend
- `mixamorig:RightFoot` / `mixamorig:LeftFoot` — ankle flex

**Ignore these** (don't keyframe):
- All finger bones (RightHand* / LeftHand*)
- Toe bones
- Spine2 (keep it locked to Spine1)
- Neck (minimal use — maybe slight tilt on idle only)

In practice, a good OSRS-style attack animates only **6-8 bones**: Spine, Spine1, both UpperArms, both ForeArms, and maybe Hips for grounding. Walk uses Hips + all 4 leg bones + both UpperArms for the arm swing.

---

## Why This Works

OSRS's animation feel comes from these technical properties:
- **No blending** — our system snap-switches between animations, identical to OSRS
- **Client tick ≠ game tick** — animations render at 60fps but switch on 600ms boundaries
- **Very few keyframes with large deltas** — exaggerated motion reads clearly at small character scale
- **Tight coupling to game tick** — attacks complete within one 600ms tick, so feedback is immediate
- **Rigid body parts** — each bone moves its children as a solid unit

The "weight" and "snappiness" of OSRS combat comes from timing, not complexity. A 5-frame sword swing at 0.5s feels better than a 30-frame mocap swing at 1.2s because the input-to-visual feedback loop is tighter than one game tick.
