import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { Animation } from '@babylonjs/core/Animations/animation';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import { Quaternion } from '@babylonjs/core/Maths/math.vector';
import '@babylonjs/loaders/glTF';
import { isWalkVariant, quantizeAnimationGroup } from './AnimationQuantizer';

export interface HumanoidAnimationDef {
  name: string;
  path: string;
  animName?: string;
}

export interface HumanoidRigContext {
  nodesByName: ReadonlyMap<string, TransformNode>;
  restRotations: ReadonlyMap<string, Quaternion>;
  signature: string;
}

export interface HumanoidAnimationTemplateTrack {
  targetName: string;
  animation: Animation;
}

export interface HumanoidAnimationTemplate {
  name: string;
  from: number;
  to: number;
  tracks: HumanoidAnimationTemplateTrack[];
}

/**
 * Per-animation, per-bone rotation offsets applied during retargeting.
 * Outer key = animation name from additionalAnimations[].name ('idle', 'walk', ...).
 * Use '*' to apply to every animation.
 * Inner values are Euler offsets (radians) post-multiplied onto every keyframe.
 * ~0.087 rad = 5 degrees.
 */
export const BONE_ROTATION_OFFSETS: Record<string, Record<string, { x: number; y: number; z: number }>> = {};

const CACHE_BUST_TOKEN: string = (import.meta as any).env?.DEV ? `?v=${Date.now()}` : '';
const TRANSLATION_BONE_WHITELIST = new Set([
  'mixamorig:Hips',
  'mixamorig:Spine',
  'mixamorig:Spine1',
  'mixamorig:Spine2',
]);

const sceneTemplateCaches = new WeakMap<Scene, Map<string, Promise<HumanoidAnimationTemplate | null>>>();
const warnedTemplateFailures = new Set<string>();

type ImportedMeshResult = Awaited<ReturnType<typeof SceneLoader.ImportMeshAsync>>;

function devCacheBust(file: string): string {
  return CACHE_BUST_TOKEN ? `${file}${CACHE_BUST_TOKEN}` : file;
}

async function importMeshWithSlowWarning(
  scene: Scene,
  dir: string,
  file: string,
  slowWarnMs: number = 20_000,
): Promise<ImportedMeshResult> {
  let timer: number | null = null;
  try {
    const url = `${dir}${file}`;
    timer = window.setTimeout(() => {
      console.warn(`[loading] GLB import still running after ${slowWarnMs}ms: ${url}`);
    }, slowWarnMs);
    return await SceneLoader.ImportMeshAsync('', dir, file, scene);
  } finally {
    if (timer !== null) window.clearTimeout(timer);
  }
}

function disposeImportedMeshResult(result: ImportedMeshResult): void {
  for (const group of result.animationGroups) group.dispose();
  for (const skeleton of result.skeletons) skeleton.dispose();
  for (const mesh of result.meshes) mesh.dispose();
  for (const node of result.transformNodes) {
    if (!node.isDisposed()) node.dispose();
  }
}

function warnOnce(key: string, message: string): void {
  if (warnedTemplateFailures.has(key)) return;
  warnedTemplateFailures.add(key);
  console.warn(message);
}

function roundedQuat(q: Quaternion): string {
  const s = 10_000;
  return `${Math.round(q.x * s)},${Math.round(q.y * s)},${Math.round(q.z * s)},${Math.round(q.w * s)}`;
}

function canonicalBoneName(name: string): string {
  return name.replace(/\.\d+$/, '');
}

function hashString(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function buildHumanoidRigSignature(restRotations: ReadonlyMap<string, Quaternion>): string {
  const canonicalRestRotations = new Map<string, Quaternion>();
  for (const [name, q] of restRotations) {
    const canonicalName = canonicalBoneName(name);
    if (!canonicalRestRotations.has(canonicalName)) {
      canonicalRestRotations.set(canonicalName, q);
    }
  }

  const entries = Array.from(canonicalRestRotations.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, q]) => `${name}:${roundedQuat(q)}`)
    .join('|');
  return `mixamo57:${hashString(entries)}`;
}

function addNodeAlias(nodesByName: Map<string, TransformNode>, name: string, node: TransformNode): void {
  if (!nodesByName.has(name)) nodesByName.set(name, node);
  const canonicalName = canonicalBoneName(name);
  if (!nodesByName.has(canonicalName)) nodesByName.set(canonicalName, node);
}

function addRestAlias(restRotations: Map<string, Quaternion>, name: string, rest: Quaternion): void {
  if (!restRotations.has(name)) restRotations.set(name, rest);
  const canonicalName = canonicalBoneName(name);
  if (!restRotations.has(canonicalName)) restRotations.set(canonicalName, rest);
}

export function buildHumanoidRigContext(skeleton: Skeleton | null, root: TransformNode | null): HumanoidRigContext {
  const nodesByName = new Map<string, TransformNode>();
  const restRotations = new Map<string, Quaternion>();

  if (skeleton) {
    for (const bone of skeleton.bones) {
      const tn = bone.getTransformNode();
      if (!tn) continue;

      addNodeAlias(nodesByName, bone.name, tn);
      addNodeAlias(nodesByName, tn.name, tn);
      const rest = tn.rotationQuaternion?.clone() ?? Quaternion.Identity();
      addRestAlias(restRotations, bone.name, rest);
      addRestAlias(restRotations, tn.name, rest);
    }
  }

  if (root) {
    for (const node of root.getDescendants(false)) {
      if (node instanceof TransformNode) {
        addNodeAlias(nodesByName, node.name, node);
      }
    }
  }

  return {
    nodesByName,
    restRotations,
    signature: buildHumanoidRigSignature(restRotations),
  };
}

interface ResolvedRigTarget {
  targetName: string;
}

function resolveRigTarget(sourceName: string, rig: HumanoidRigContext): ResolvedRigTarget | null {
  const stripped = canonicalBoneName(sourceName);
  if (rig.nodesByName.has(stripped)) return { targetName: stripped };
  return rig.nodesByName.has(sourceName) ? { targetName: sourceName } : null;
}

function resolveAnimationGroup(
  groups: AnimationGroup[],
  anim: HumanoidAnimationDef,
  warnKey: string,
): AnimationGroup | null {
  if (anim.animName) {
    const named = groups.find((g) => g.name === anim.animName);
    if (named) return named;
    if (groups.length === 1) return groups[0];

    warnOnce(
      `${warnKey}:missing-group`,
      `[HumanoidAnimationTemplateCache] '${anim.name}': animName '${anim.animName}' not found in '${anim.path}'. Available: ${groups.map((g) => g.name).join(', ')}`,
    );
    return null;
  }
  return groups[0] ?? null;
}

function shouldKeepTargetedAnimation(ta: AnimationGroup['targetedAnimations'][number]): boolean {
  const target = ta.target as TransformNode;
  if (!target?.name) return false;
  const targetName = canonicalBoneName(target.name);

  const prop = ta.animation.targetProperty;
  const isRotation = prop === 'rotationQuaternion' || prop.startsWith('rotationQuaternion');
  const isTranslation = prop === 'position' || prop.startsWith('position');
  if (!isRotation && !isTranslation) return false;
  if (!isTranslation) return true;

  if (!TRANSLATION_BONE_WHITELIST.has(targetName)) return false;

  const keys = ta.animation.getKeys();
  let maxMag = 0;
  for (const k of keys) {
    const v = k.value as any;
    if (!v || typeof v.x !== 'number') continue;
    const m = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
    if (m > maxMag) maxMag = m;
  }
  return maxMag <= 1.0;
}

function stripUnsafeHipsTranslation(ta: AnimationGroup['targetedAnimations'][number], animName: string): void {
  const target = ta.target as TransformNode;
  if (canonicalBoneName(target.name) !== 'mixamorig:Hips') return;

  const prop = ta.animation.targetProperty;
  if (prop !== 'position' && !prop.startsWith('position')) return;

  const isInPlaceCycle = isWalkVariant(animName);
  for (const k of ta.animation.getKeys()) {
    const v = k.value as any;
    if (v && typeof v.y === 'number') v.y = 0;
    if (isInPlaceCycle && v) {
      if (typeof v.x === 'number') v.x = 0;
      if (typeof v.z === 'number') v.z = 0;
    }
  }
}

function applyRestCorrection(
  ta: AnimationGroup['targetedAnimations'][number],
  sourceName: string,
  targetName: string,
  sourceRestRotations: ReadonlyMap<string, Quaternion>,
  targetRestRotations: ReadonlyMap<string, Quaternion>,
): void {
  const srcRest = sourceRestRotations.get(sourceName);
  const targetRest = targetRestRotations.get(targetName);
  if (!srcRest || !targetRest) return;

  const dot = Math.abs(Quaternion.Dot(srcRest, targetRest));
  if (dot >= 0.999) return;

  const srcRestInv = Quaternion.Inverse(srcRest);
  for (const key of ta.animation.getKeys()) {
    if (key.value && key.value.w !== undefined) {
      key.value = targetRest.multiply(srcRestInv.multiply(key.value));
    }
  }
}

function applyBoneRotationOffset(
  ta: AnimationGroup['targetedAnimations'][number],
  animName: string,
  targetName: string,
): void {
  const offset = BONE_ROTATION_OFFSETS[animName]?.[targetName]
    ?? BONE_ROTATION_OFFSETS['*']?.[targetName];
  if (!offset || (offset.x === 0 && offset.y === 0 && offset.z === 0)) return;

  const offsetQuat = Quaternion.FromEulerAngles(offset.x, offset.y, offset.z);
  for (const key of ta.animation.getKeys()) {
    if (key.value && key.value.w !== undefined) {
      key.value = key.value.multiply(offsetQuat);
    }
  }
}

function buildCacheKey(anim: HumanoidAnimationDef, rig: HumanoidRigContext): string {
  return `${anim.name}|${anim.path}|${anim.animName ?? ''}|${rig.signature}`;
}

async function createTemplate(
  scene: Scene,
  anim: HumanoidAnimationDef,
  rig: HumanoidRigContext,
  cacheKey: string,
): Promise<HumanoidAnimationTemplate | null> {
  let imported: ImportedMeshResult | null = null;
  let quantizeGroup: AnimationGroup | null = null;

  try {
    const lastSlash = anim.path.lastIndexOf('/');
    const dir = anim.path.substring(0, lastSlash + 1);
    const file = devCacheBust(anim.path.substring(lastSlash + 1));
    imported = await importMeshWithSlowWarning(scene, dir, file);
    if (scene.isDisposed) return null;

    const sourceRestRotations = new Map<string, Quaternion>();
    for (const tn of imported.transformNodes) {
      if (tn.rotationQuaternion) {
        sourceRestRotations.set(tn.name, tn.rotationQuaternion.clone());
      }
    }

    for (const group of imported.animationGroups) group.stop();

    const sourceGroup = resolveAnimationGroup(imported.animationGroups, anim, cacheKey);
    if (!sourceGroup) return null;

    const tracks: HumanoidAnimationTemplateTrack[] = [];
    quantizeGroup = new AnimationGroup(`__humanoid_template_${anim.name}`, scene);

    for (const ta of sourceGroup.targetedAnimations) {
      const sourceTarget = ta.target as TransformNode;
      if (!sourceTarget?.name) continue;
      if (!shouldKeepTargetedAnimation(ta)) continue;

      const target = resolveRigTarget(sourceTarget.name, rig);
      if (!target) {
        continue;
      }

      const targetName = target.targetName;
      stripUnsafeHipsTranslation(ta, anim.name);
      applyRestCorrection(ta, sourceTarget.name, targetName, sourceRestRotations, rig.restRotations);
      applyBoneRotationOffset(ta, anim.name, targetName);

      const targetRest = rig.restRotations.get(targetName)?.clone()
        ?? Quaternion.Identity();
      quantizeGroup.addTargetedAnimation(ta.animation, { name: targetName, rotationQuaternion: targetRest });
      tracks.push({ targetName, animation: ta.animation });
    }

    if (tracks.length === 0) {
      warnOnce(
        `${cacheKey}:empty`,
        `[HumanoidAnimationTemplateCache] Retargeting failed for '${anim.name}' - 0 tracks matched`,
      );
      return null;
    }

    quantizeAnimationGroup(quantizeGroup, anim.name);
    const template: HumanoidAnimationTemplate = {
      name: anim.name,
      from: quantizeGroup.from,
      to: quantizeGroup.to,
      tracks,
    };
    return template;
  } catch {
    warnOnce(cacheKey, `[HumanoidAnimationTemplateCache] Failed to load animation file ${anim.path}`);
    return null;
  } finally {
    if (quantizeGroup) quantizeGroup.dispose();
    if (imported) disposeImportedMeshResult(imported);
  }
}

export function getHumanoidAnimationTemplate(
  scene: Scene,
  anim: HumanoidAnimationDef,
  rig: HumanoidRigContext,
): Promise<HumanoidAnimationTemplate | null> {
  let sceneCache = sceneTemplateCaches.get(scene);
  if (!sceneCache) {
    sceneCache = new Map();
    sceneTemplateCaches.set(scene, sceneCache);
  }

  const key = buildCacheKey(anim, rig);
  let promise = sceneCache.get(key);
  if (!promise) {
    promise = createTemplate(scene, anim, rig, key).then((template) => {
      if (template === null && sceneCache?.get(key) === promise) {
        sceneCache.delete(key);
      }
      return template;
    }, (err) => {
      if (sceneCache?.get(key) === promise) {
        sceneCache.delete(key);
      }
      throw err;
    });
    sceneCache.set(key, promise);
  }
  return promise;
}

export function bindHumanoidAnimationTemplate(
  scene: Scene,
  template: HumanoidAnimationTemplate,
  nodesByName: ReadonlyMap<string, TransformNode>,
): AnimationGroup | null {
  const group = new AnimationGroup(template.name, scene);

  for (const track of template.tracks) {
    const target = nodesByName.get(track.targetName);
    if (!target) continue;
    group.addTargetedAnimation(track.animation, target);
  }

  if (group.targetedAnimations.length === 0) {
    group.dispose();
    return null;
  }

  group.from = template.from;
  group.to = template.to;
  group.stop();
  return group;
}
