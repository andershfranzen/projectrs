import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';

export const DEFAULT_QUANTIZE_FRAMES = 8;

/**
 * Per-animation frame count override. Defaults to DEFAULT_QUANTIZE_FRAMES.
 * Use a smaller count for animations whose canonical pose count is fewer
 * than the default — otherwise step-interpolation snaps between off-pose
 * samples and looks jittery.
 */
export const ANIM_QUANTIZE_FRAMES: Record<string, number> = {
  walk: 5, // 5 canonical poses at frames 0, 6, 13, 19, 26
};

export const ANIM_DURATIONS: Record<string, number> = {
  idle: 3.6,
  walk: 1.2,
  run: 1.2,
  attack: 1.2,
  attack_slash: 1.2,
  attack_punch: 1.2,
  bow_attack: 1.2,
  chop: 1.2,
  mine: 1.8,
  skill: 1.8,
  death: 1.8,
  npc_idle: 2.4,
  npc_walk: 1.2,
  npc_attack: 1.2,
  npc_death: 1.8,
};

const ANIM_SAMPLE_CURVES: Record<string, number[]> = {
  idle:         [0, 0.14, 0.28, 0.43, 0.57, 0.71, 0.86, 1.0],
  walk:         [0, 0.231, 0.500, 0.731, 1.0], // exact ratios for our 5 canonical poses
  run:          [0, 0.14, 0.28, 0.43, 0.57, 0.71, 0.86, 1.0],
  attack:       [0, 0.10, 0.25, 0.45, 0.60, 0.75, 0.88, 1.0],
  attack_slash: [0, 0.10, 0.25, 0.45, 0.60, 0.75, 0.88, 1.0],
  attack_punch: [0, 0.10, 0.30, 0.50, 0.65, 0.78, 0.90, 1.0],
  bow_attack:   [0, 0.12, 0.28, 0.42, 0.55, 0.70, 0.85, 1.0],
  chop:         [0, 0.15, 0.35, 0.50, 0.60, 0.72, 0.85, 1.0],
  mine:         [0, 0.20, 0.42, 0.55, 0.65, 0.77, 0.88, 1.0],
  death:        [0, 0.08, 0.20, 0.35, 0.55, 0.75, 0.90, 1.0],
  npc_idle:     [0, 0.14, 0.28, 0.43, 0.57, 0.71, 0.86, 1.0],
  npc_walk:     [0, 0.14, 0.28, 0.43, 0.57, 0.71, 0.86, 1.0],
  npc_attack:   [0, 0.10, 0.25, 0.45, 0.60, 0.75, 0.88, 1.0],
  npc_death:    [0, 0.08, 0.20, 0.35, 0.55, 0.75, 0.90, 1.0],
};


function lerpValue(a: any, b: any, t: number): any {
  if (typeof a === 'number') return a + (b - a) * t;
  if (a instanceof Quaternion) return Quaternion.Slerp(a, b, t);
  if (a instanceof Vector3) return Vector3.Lerp(a, b, t);
  if (a.clone) return a.clone();
  return a;
}

function sampleAnimationAt(keys: any[], frame: number): any {
  if (keys.length === 0) return undefined;
  if (frame <= keys[0].frame) {
    const v = keys[0].value;
    return v?.clone ? v.clone() : v;
  }
  if (frame >= keys[keys.length - 1].frame) {
    const v = keys[keys.length - 1].value;
    return v?.clone ? v.clone() : v;
  }
  for (let i = 0; i < keys.length - 1; i++) {
    if (frame >= keys[i].frame && frame <= keys[i + 1].frame) {
      const range = keys[i + 1].frame - keys[i].frame;
      const t = range > 0 ? (frame - keys[i].frame) / range : 0;
      return lerpValue(keys[i].value, keys[i + 1].value, t);
    }
  }
  const v = keys[keys.length - 1].value;
  return v?.clone ? v.clone() : v;
}

/**
 * If true, each pose is held flat until just before the next pose, producing
 * a staircase / RS2-style stepped motion. Achieved by inserting a duplicate
 * key at frame N - epsilon carrying the previous value; Babylon then lerps
 * across the tiny epsilon range, which reads as a snap.
 */
const STEP_INTERPOLATE = false;
const STEP_EPSILON = 0.05;

/**
 * Animations that loop continuously (walk, idle, run, npc_*). The convention
 * for loop-friendly source GLBs is to author a duplicate final frame equal to
 * the first frame, so the cycle's last quantized pose lands on pose 0 and the
 * loop wrap is invisible. To let authors skip that manual duplicate, we
 * REPLACE the last sampled value with the first sampled value for these
 * animations — produces identical playback to a source with the duplicate,
 * giving N-1 distinct motion segments per cycle + invisible wrap.
 *
 * (Earlier attempt: appending an extra wrap key at frame N. That EXTENDED the
 * cycle by one segment, creating an interpolated transition between the last
 * canonical pose and pose 0. That synthetic segment doesn't represent natural
 * stride motion → foot-slide at the loop point.)
 */
const LOOPING_ANIMS = new Set([
  'idle', 'walk', 'run',
  'npc_idle', 'npc_walk',
]);

/**
 * Animations to leave untouched — keep their authored keyframes, FPS, and
 * duration as exported from Blender. Use for hand-authored anims whose pose
 * count exceeds DEFAULT_QUANTIZE_FRAMES or whose timing carries meaning the
 * fixed-percentage sample curves can't preserve (e.g. RS2-style multi-loop
 * skilling anims with intro + N swing repeats).
 */
const SKIP_QUANTIZE: Set<string> = new Set([
  'mine',
]);

export function quantizeAnimationGroup(
  group: AnimationGroup,
  animName: string,
  frameCount?: number,
): void {
  if (SKIP_QUANTIZE.has(animName)) return;
  const frames = frameCount ?? ANIM_QUANTIZE_FRAMES[animName] ?? DEFAULT_QUANTIZE_FRAMES;
  const targetDuration = ANIM_DURATIONS[animName] ?? 1.2;
  const targetFps = frames / targetDuration;
  const sampleCurve = ANIM_SAMPLE_CURVES[animName];

  for (const ta of group.targetedAnimations) {
    const anim = ta.animation;
    const keys = anim.getKeys();
    if (keys.length < 2) continue;

    const srcFrom = keys[0].frame;
    const srcTo = keys[keys.length - 1].frame;
    const srcRange = srcTo - srcFrom;
    if (srcRange <= 0) continue;

    const sampledValues: any[] = [];
    for (let i = 0; i < frames; i++) {
      const t = sampleCurve
        ? (sampleCurve[i] ?? i / (frames - 1))
        : i / (frames - 1);
      const srcFrame = srcFrom + t * srcRange;
      sampledValues.push(sampleAnimationAt(keys, srcFrame));
    }
    // For looping animations, force the last sample to equal the first so the
    // playback range's end pose matches its start pose — the wrap is then
    // visually invisible. Replicates the source-side "duplicate final frame"
    // technique automatically so authors don't have to add one in Blender.
    if (LOOPING_ANIMS.has(animName)) {
      const v0 = sampledValues[0];
      sampledValues[frames - 1] = v0?.clone ? v0.clone() : v0;
    }

    const newKeys: any[] = [];
    for (let i = 0; i < frames; i++) {
      if (STEP_INTERPOLATE && i > 0) {
        const prev = sampledValues[i - 1];
        newKeys.push({ frame: i - STEP_EPSILON, value: prev?.clone ? prev.clone() : prev });
      }
      newKeys.push({ frame: i, value: sampledValues[i] });
    }

    anim.setKeys(newKeys);
    anim.framePerSecond = targetFps;
  }

  group.normalize(0, frames - 1);
}

// RS2 rotation: 2048 angle units = full circle, 32 units per client tick (20ms),
// 50 ticks/sec. In radians: 32/2048 * 2π * 50 ≈ 4.91 rad/sec.
// Snap threshold: 32/2048 * 2π ≈ 0.098 rad (~5.6°).
const RS2_TURN_RATE = (32 / 2048) * Math.PI * 2 * 50;
const RS2_TURN_SNAP = (32 / 2048) * Math.PI * 2;

export function rs2Rotation(current: number, target: number, dt: number): number {
  let diff = target - current;
  while (diff > Math.PI) diff -= Math.PI * 2;
  while (diff < -Math.PI) diff += Math.PI * 2;

  if (Math.abs(diff) < RS2_TURN_SNAP) return target;

  const step = RS2_TURN_RATE * dt;
  const next = current + Math.sign(diff) * Math.min(step, Math.abs(diff));
  let normalized = next;
  while (normalized > Math.PI) normalized -= Math.PI * 2;
  while (normalized < -Math.PI) normalized += Math.PI * 2;
  return normalized;
}
