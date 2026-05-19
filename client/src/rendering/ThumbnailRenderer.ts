import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import type { Skeleton } from '@babylonjs/core/Bones/skeleton';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { CHARACTER_IDLE_ANIM, CHARACTER_MODEL_PATH } from '@projectrs/shared';
import '@babylonjs/loaders/glTF';
import { clearCachedThumb, getCachedThumb, putCachedThumb } from './ThumbnailCache';
import { remapSkinningToSkeleton } from './skinnedArmor';

/** Final output canvas size (px). */
const THUMB_SIZE = 128;
/** Internal render size — larger than THUMB_SIZE so cropping/resizing keeps detail
 *  even when the visible content is a fraction of the GLB's bounding box. */
const THUMB_INTERNAL_SIZE = 256;
/** Fraction of the output reserved as padding around the visible item.
 *  Tight — slots are already small (~34 px); generous padding makes items
 *  read as tiny. Bump if items start hitting the edges. */
const THUMB_PADDING = 0.02;
/** Alpha threshold below which a pixel is considered transparent. Trims AA halos. */
const TRIM_ALPHA_MIN = 12;
// Bump to invalidate every cached thumbnail across clients. v10: cache keys now
// preserve editor slider precision so saved thumbnail poses don't collide.
const THUMB_VERSION = 10;
const RENDER_TIMEOUT_MS = 8000;

// ArcRotateCamera defaults applied when options.camera doesn't specify an axis.
// α=-π/4, β=π/2.6 puts the camera at the upper-front-right, looking down-toward
// origin — generic 3/4 view that works for most equipment.
const DEFAULT_ALPHA = -Math.PI / 4;
const DEFAULT_BETA = Math.PI / 2.6;
const DEFAULT_DISTANCE_MULT = 0.75;

let _engine: Engine | null = null;
let _scene: Scene | null = null;
let _camera: ArcRotateCamera | null = null;
let _canvas: HTMLCanvasElement | null = null;

function ensureEngine(): void {
  if (_engine) return;
  _canvas = document.createElement('canvas');
  _canvas.width = THUMB_INTERNAL_SIZE;
  _canvas.height = THUMB_INTERNAL_SIZE;
  _engine = new Engine(_canvas, true, { preserveDrawingBuffer: true, antialias: true });
  _scene = new Scene(_engine);
  _scene.clearColor = new Color4(0, 0, 0, 0);

  const ambient = new HemisphericLight('thumb-ambient', new Vector3(0, 1, 0), _scene);
  ambient.intensity = 0.9;
  ambient.diffuse = new Color3(0.55, 0.55, 0.55);
  ambient.groundColor = new Color3(0.35, 0.33, 0.30);
  ambient.specular = new Color3(0, 0, 0);

  const sun = new DirectionalLight('thumb-sun', new Vector3(-0.5, -1, -0.3), _scene);
  sun.intensity = 1.1;
  sun.diffuse = new Color3(1.0, 0.84, 0.54);

  const fill = new DirectionalLight('thumb-fill', new Vector3(0.3, -0.6, 0.5), _scene);
  fill.intensity = 0.65;
  fill.diffuse = new Color3(0.67, 0.73, 0.80);

  _camera = new ArcRotateCamera('thumb-cam', -Math.PI / 4, Math.PI / 2.6, 10, Vector3.Zero(), _scene);
  _camera.minZ = 0.01;
  _camera.maxZ = 1000;
  _camera.fov = 0.8;
}

/** Donor skeleton used to drive skinned armor (body, legs, head pieces) GLBs
 *  that have no skeleton of their own at render time. Loaded once on first
 *  request, shared across all subsequent skinned-armor renders, never disposed
 *  for the life of the page. */
interface DonorSkeleton {
  skeleton: Skeleton;
  armatureNode: TransformNode;
}

let _donorPromise: Promise<DonorSkeleton | null> | null = null;
let _idleDonorPromise: Promise<DonorSkeleton | null> | null = null;

async function applyIdlePoseToDonor(donor: DonorSkeleton): Promise<void> {
  const lastSlash = CHARACTER_IDLE_ANIM.lastIndexOf('/');
  const dir = CHARACTER_IDLE_ANIM.substring(0, lastSlash + 1);
  const file = CHARACTER_IDLE_ANIM.substring(lastSlash + 1);
  const result = await SceneLoader.ImportMeshAsync('', dir, file, _scene!);

  try {
    const group = result.animationGroups[0];
    if (!group) return;
    for (const ag of result.animationGroups || []) ag.stop();

    const donorNodes = new Map<string, TransformNode>();
    const donorRest = new Map<string, Quaternion>();
    for (const bone of donor.skeleton.bones) {
      const tn = bone.getTransformNode();
      if (!tn) continue;
      donorNodes.set(bone.name, tn);
      donorNodes.set(tn.name, tn);
      const rest = tn.rotationQuaternion?.clone() ?? Quaternion.Identity();
      donorRest.set(bone.name, rest);
      donorRest.set(tn.name, rest);
    }

    const sourceRest = new Map<string, Quaternion>();
    for (const tn of result.transformNodes) {
      if (tn.rotationQuaternion) sourceRest.set(tn.name, tn.rotationQuaternion.clone());
    }

    for (const ta of group.targetedAnimations) {
      const sourceTarget = ta.target as TransformNode;
      if (!sourceTarget?.name) continue;
      const prop = ta.animation.targetProperty;
      if (prop !== 'rotationQuaternion' && !prop.startsWith('rotationQuaternion')) continue;

      const stripped = sourceTarget.name.replace(/\.\d+$/, '');
      const target = donorNodes.get(sourceTarget.name) ?? donorNodes.get(stripped);
      if (!target) continue;

      const firstKey = ta.animation.getKeys()[0];
      const keyRotation = firstKey?.value;
      if (!keyRotation || keyRotation.w === undefined) continue;

      const srcRest = sourceRest.get(sourceTarget.name) ?? sourceRest.get(stripped);
      const dstRest = donorRest.get(target.name) ?? Quaternion.Identity();
      const corrected = srcRest
        ? dstRest.multiply(Quaternion.Inverse(srcRest).multiply(keyRotation))
        : keyRotation;
      target.rotationQuaternion = corrected.clone();
    }

    donor.skeleton.prepare();
    _scene?.render();
  } finally {
    disposeLoadResult(result);
  }
}

async function loadDonorSkeleton(applyIdle: boolean): Promise<DonorSkeleton | null> {
  ensureEngine();
  try {
    const lastSlash = CHARACTER_MODEL_PATH.lastIndexOf('/');
    const dir = CHARACTER_MODEL_PATH.substring(0, lastSlash + 1);
    const file = CHARACTER_MODEL_PATH.substring(lastSlash + 1);
    const result = await SceneLoader.ImportMeshAsync('', dir, file, _scene!);
    // Stop bundled animations so bones settle in bind pose.
    for (const ag of result.animationGroups || []) ag.stop();
    // Hide donor visually but KEEP it in the active-mesh list — the skeleton
    // is only evaluated when at least one mesh referencing it is active.
    // setEnabled(false) takes it out of evaluation entirely, leaving the
    // armor's skinning math with stale (zero) bone matrices and rendering
    // it invisible. `visibility=0` makes draws fully transparent but the
    // mesh stays active.
    for (const mesh of result.meshes) {
      mesh.visibility = 0;
      mesh.isPickable = false;
    }

    const skeleton = result.skeletons[0];
    if (!skeleton) return null;

    let armatureNode: TransformNode | null = null;
    for (const tn of result.transformNodes) {
      if (/^Armature(\.\d+)?$/.test(tn.name)) { armatureNode = tn; break; }
    }
    if (!armatureNode) return null;

    const donor = { skeleton, armatureNode };
    if (applyIdle) await applyIdlePoseToDonor(donor);
    return donor;
  } catch (e) {
    console.warn('[ThumbnailRenderer] donor skeleton load failed:', e);
    return null;
  }
}

function ensureDonor(): Promise<DonorSkeleton | null> {
  if (!_donorPromise) _donorPromise = loadDonorSkeleton(false);
  return _donorPromise;
}

function ensureIdleDonor(): Promise<DonorSkeleton | null> {
  if (!_idleDonorPromise) _idleDonorPromise = loadDonorSkeleton(true);
  return _idleDonorPromise;
}

/** Rebind an armor GLB's skinning to the donor skeleton so the bind pose
 *  drives the mesh instead of collapsing. The 5-bone / 30% match threshold
 *  skips small non-armor rigs (weapon GLBs with their own tiny skeleton),
 *  which would otherwise get force-pinned to the donor root. */
function bindToDonor(result: { meshes: any[]; skeletons: Skeleton[] }, donor: DonorSkeleton): void {
  const armorSkeleton = result.skeletons[0];
  if (!armorSkeleton) return;
  const r = remapSkinningToSkeleton(result.meshes, armorSkeleton, donor.skeleton, donor.armatureNode, {
    minMatchedBones: 5,
    minMatchRatio: 0.3,
    forceMaterialRecompile: true,
    refreshBoundsWithSkeleton: true,
    disposeSourceSkeleton: true,
  });
  if (!r.applied) return;
  // disposeLoadResult shouldn't re-dispose the skeleton we just freed.
  const idx = result.skeletons.indexOf(armorSkeleton);
  if (idx >= 0) result.skeletons.splice(idx, 1);
}

/** Camera tweaks merged over the defaults. Per-slot profiles + per-item
 *  overrides ride in here so a badly-oriented GLB can be salvaged without
 *  re-exporting from Blender. */
export interface ThumbnailCamera {
  /** ArcRotate alpha (radians around Y). Default −π/4 (upper-front-right). */
  alpha?: number;
  /** ArcRotate beta (radians from +Y). Default π/2.6 (tilted slightly down). */
  beta?: number;
  /** Multiplier on the auto-computed bbox-fit distance. <1 zooms in, >1 out. */
  distanceMult?: number;
}

export interface ThumbnailOptions {
  /** Optional RGB tint applied to materials matching `tintMaterialMatch` (default
   *  `'Material.002'`, the metal slot on the Tools axe/pickaxe GLBs). Mirrors
   *  the runtime tint applied in `CharacterEntity.attachStaticGear`. */
  tint?: [number, number, number];
  /** Substring matched against material name to decide what gets tinted. */
  tintMaterialMatch?: string;
  /** Tint every untextured material. Use for GLBs whose exported material slots
   *  do not consistently isolate the metal surface. */
  tintAllMaterials?: boolean;
  /** Match an untextured material by its authored base color instead of its
   *  exporter-generated material name. Useful when related GLBs have unstable
   *  material names but share the same source palette color. */
  tintBaseColorMatch?: [number, number, number];
  /** Per-channel tolerance for `tintBaseColorMatch`. Defaults to 0.015. */
  tintBaseColorTolerance?: number;
  /** Override one or more camera axes for this render. */
  camera?: ThumbnailCamera;
  /** Rotate the loaded model before bbox calc + render.
   *  Use to fix items that exported facing the wrong way or should lie flat. */
  rotationX?: number;
  rotationY?: number;
  rotationZ?: number;
  /** Final post-trim icon scale. 1 fills the normal padded thumbnail box;
   *  smaller values leave more empty space without lowering render quality. */
  iconScale?: number;
  /** Pose used by the donor skeleton for skinned armor thumbnails. Defaults
   *  to bind pose so old fitted thumbnails keep their existing cache entry. */
  skinnedPose?: 'idle';
}

interface QueueEntry {
  path: string;
  options: ThumbnailOptions;
  cacheKey?: string;
  resolve: (url: string | null) => void;
}

const queue: QueueEntry[] = [];
let processing = false;
// `null` is cached so a broken/missing GLB doesn't trigger a retry storm on
// every slot re-render. Reload clears it.
const memCache = new Map<string, string | null>();

function buildCacheKey(path: string, options: ThumbnailOptions): string {
  const parts: string[] = [path];
  const n = (value: number): string => value.toFixed(5);
  if (options.tint) {
    const [r, g, b] = options.tint;
    const materialKey = options.tintAllMaterials ? '*' : (options.tintMaterialMatch ?? 'Material.002');
    parts.push(`tint:${n(r)},${n(g)},${n(b)}|m:${materialKey}`);
    if (options.tintBaseColorMatch) {
      const [mr, mg, mb] = options.tintBaseColorMatch;
      parts.push(`base:${n(mr)},${n(mg)},${n(mb)}|tol:${n(options.tintBaseColorTolerance ?? 0.015)}`);
    }
  }
  if (options.camera) {
    const c = options.camera;
    const a = c.alpha ?? DEFAULT_ALPHA;
    const b = c.beta ?? DEFAULT_BETA;
    const d = c.distanceMult ?? DEFAULT_DISTANCE_MULT;
    parts.push(`cam:${n(a)},${n(b)},${n(d)}`);
  }
  if (options.rotationX) parts.push(`rotx:${n(options.rotationX)}`);
  if (options.rotationY) parts.push(`roty:${n(options.rotationY)}`);
  if (options.rotationZ) parts.push(`rotz:${n(options.rotationZ)}`);
  if (typeof options.iconScale === 'number' && Number.isFinite(options.iconScale) && options.iconScale !== 1) {
    parts.push(`scale:${n(options.iconScale)}`);
  }
  if (options.skinnedPose) parts.push(`pose:${options.skinnedPose}`);
  return parts.join('|');
}

function enqueue(path: string, options: ThumbnailOptions, cacheKey?: string): Promise<string | null> {
  return new Promise((resolve) => {
    queue.push({ path, options, cacheKey, resolve });
    if (!processing) processQueue();
  });
}

// Wait for browser-idle (or up to `timeoutMs`) between renders so a burst of
// GLB parses doesn't compete with login bootstrap or click handling.
function idleYield(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (typeof ric === 'function') ric(() => resolve(), { timeout: timeoutMs });
    else setTimeout(resolve, Math.min(timeoutMs, 16));
  });
}

// Spend the first ~1.5 s after the queue activates waiting for true idle —
// covers the login GLB + animation burst (~600 ms of long-tasks). After the
// initial settle, smaller per-item yields keep clicks/animation responsive
// without delaying thumbs noticeably.
const QUEUE_FIRST_SETTLE_MS = 1500;
let firstSettleDone = false;

async function processQueue(): Promise<void> {
  processing = true;
  if (!firstSettleDone) {
    firstSettleDone = true;
    await idleYield(QUEUE_FIRST_SETTLE_MS);
  }
  while (queue.length > 0) {
    const { path, options, cacheKey, resolve } = queue.shift()!;
    const startMs = performance.now();
    try {
      const url = await withTimeout(renderOne(path, options), RENDER_TIMEOUT_MS);
      if (url && cacheKey) putCachedThumb(cacheKey, url, THUMB_VERSION);
      resolve(url);
    } catch (err) {
      console.warn('[ThumbnailRenderer] render failed for', path, err);
      resolve(null);
    }
    // Adaptive yield: heavy renders earn a longer pause before the next item
    // so a chain of 200 ms parses doesn't keep the main thread locked.
    const elapsed = performance.now() - startMs;
    if (queue.length > 0) await idleYield(elapsed > 50 ? 100 : 16);
  }
  processing = false;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('thumbnail render timeout')), ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Trim transparent edges off a rendered PNG and resize so the opaque content
 *  fills `outSize` with `THUMB_PADDING` margin. This is what gives items a
 *  uniform on-thumbnail size regardless of GLB bbox quirks (skinned-armor
 *  skeletons, off-center pivots, stray vertices). Returns null if the render
 *  is fully transparent — callers should fall back to sprite/icon rather
 *  than caching an empty image. */
function trimAndResize(sourceUrl: string, outSize: number, iconScale = 1): Promise<string | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const W = img.width, H = img.height;
      const measure = document.createElement('canvas');
      measure.width = W;
      measure.height = H;
      const mctx = measure.getContext('2d');
      if (!mctx) { resolve(sourceUrl); return; }
      mctx.drawImage(img, 0, 0);
      const data = mctx.getImageData(0, 0, W, H).data;

      let minX = W, minY = H, maxX = -1, maxY = -1;
      for (let y = 0; y < H; y++) {
        const rowBase = y * W * 4;
        for (let x = 0; x < W; x++) {
          if (data[rowBase + x * 4 + 3] > TRIM_ALPHA_MIN) {
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
          }
        }
      }
      if (maxX < 0) { resolve(null); return; }

      const cropW = maxX - minX + 1;
      const cropH = maxY - minY + 1;
      const safeIconScale = Number.isFinite(iconScale) ? Math.max(0.05, Math.min(2, iconScale)) : 1;
      const innerSize = outSize * (1 - 2 * THUMB_PADDING) * safeIconScale;
      const scale = innerSize / Math.max(cropW, cropH);
      const outW = cropW * scale;
      const outH = cropH * scale;
      const dx = (outSize - outW) / 2;
      const dy = (outSize - outH) / 2;

      const out = document.createElement('canvas');
      out.width = outSize;
      out.height = outSize;
      const octx = out.getContext('2d');
      if (!octx) { resolve(sourceUrl); return; }
      octx.imageSmoothingEnabled = true;
      octx.imageSmoothingQuality = 'high';
      octx.drawImage(img, minX, minY, cropW, cropH, dx, dy, outW, outH);
      resolve(out.toDataURL('image/png'));
    };
    img.onerror = () => resolve(sourceUrl);
    img.src = sourceUrl;
  });
}

function disposeLoadResult(result: { meshes: any[]; animationGroups: any[]; skeletons: any[]; transformNodes: any[] }): void {
  const materialsSeen = new Set<any>();
  for (const ag of result.animationGroups || []) { try { ag.dispose(); } catch {} }
  for (const skel of result.skeletons || []) { try { skel.dispose(); } catch {} }
  for (const mesh of result.meshes || []) {
    if (mesh.material) materialsSeen.add(mesh.material);
    try { mesh.dispose(false, false); } catch {}
  }
  for (const tn of result.transformNodes || []) { try { tn.dispose(false, false); } catch {} }
  for (const mat of materialsSeen) {
    try {
      const textures = mat.getActiveTextures ? mat.getActiveTextures() : [];
      for (const tex of textures) { try { tex.dispose(); } catch {} }
      mat.dispose();
    } catch {}
  }
}

async function renderOne(path: string, options: ThumbnailOptions): Promise<string | null> {
  ensureEngine();

  const lastSlash = path.lastIndexOf('/');
  const dir = path.substring(0, lastSlash + 1);
  const file = path.substring(lastSlash + 1);

  const result = await SceneLoader.ImportMeshAsync('', dir, file, _scene!);

  try {
    for (const ag of result.animationGroups || []) ag.stop();

    // Skinned armor ships with its own armature but renders as a collapsed
    // blob without a posing skeleton. Rebind to a shared donor (main
    // character GLB) so its bind pose drives the mesh. Donor loads once and
    // is reused for all subsequent skinned-armor renders.
    if (result.skeletons.length > 0) {
      const donor = options.skinnedPose === 'idle' ? await ensureIdleDonor() : await ensureDonor();
      if (donor) bindToDonor(result, donor);
    }

    if (options.rotationX || options.rotationY || options.rotationZ) {
      // Rotate the loader root so bbox + render reflect the new orientation.
      // Null out any baked quaternion so .rotation.y actually takes effect
      // (rotationQuaternion overrides euler when set).
      const root = result.meshes.find((m) => m.name === '__root__') ?? result.meshes.find((m) => !m.parent);
      if (root) {
        if (root.rotationQuaternion) root.rotationQuaternion = null;
        root.rotation.x += options.rotationX ?? 0;
        root.rotation.y += options.rotationY ?? 0;
        root.rotation.z += options.rotationZ ?? 0;
      }
    }

    if (options.tint) {
      const match = options.tintMaterialMatch ?? 'Material.002';
      const [r, g, b] = options.tint;
      const tintColor = new Color3(r, g, b);
      const baseMatch = options.tintBaseColorMatch;
      const baseTolerance = options.tintBaseColorTolerance ?? 0.015;
      for (const mesh of result.meshes) {
        const mat = mesh.material as any;
        if (!mat) continue;
        let shouldTint = options.tintAllMaterials;
        if (!shouldTint && baseMatch) {
          const base = mat.albedoColor ?? mat.diffuseColor;
          shouldTint = !!base
            && Math.abs(base.r - baseMatch[0]) <= baseTolerance
            && Math.abs(base.g - baseMatch[1]) <= baseTolerance
            && Math.abs(base.b - baseMatch[2]) <= baseTolerance;
        }
        if (!shouldTint && mat.name && mat.name.includes(match)) shouldTint = true;
        if (!shouldTint) continue;
        const hasTexture = (mat.albedoTexture && mat.albedoTexture !== null) || (mat.diffuseTexture && mat.diffuseTexture !== null);
        if (hasTexture) continue;
        if ('albedoColor' in mat) mat.albedoColor = tintColor;
        if ('diffuseColor' in mat) mat.diffuseColor = tintColor;
      }
    }

    let minX = Infinity, maxX = -Infinity;
    let minY = Infinity, maxY = -Infinity;
    let minZ = Infinity, maxZ = -Infinity;
    for (const mesh of result.meshes) {
      if (!mesh.getTotalVertices || mesh.getTotalVertices() === 0) continue;
      if (mesh.material) (mesh.material as any).backFaceCulling = false;
      mesh.computeWorldMatrix(true);
      const bb = mesh.getBoundingInfo().boundingBox;
      if (bb.minimumWorld.x < minX) minX = bb.minimumWorld.x;
      if (bb.maximumWorld.x > maxX) maxX = bb.maximumWorld.x;
      if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
      if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
      if (bb.minimumWorld.z < minZ) minZ = bb.minimumWorld.z;
      if (bb.maximumWorld.z > maxZ) maxZ = bb.maximumWorld.z;
    }

    if (!Number.isFinite(minX)) return null;

    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    const cz = (minZ + maxZ) / 2;
    const sizeMax = Math.max(maxX - minX, maxY - minY, maxZ - minZ) || 1;
    const cam = options.camera ?? {};
    _camera!.alpha = cam.alpha ?? DEFAULT_ALPHA;
    _camera!.beta = cam.beta ?? DEFAULT_BETA;
    _camera!.setTarget(new Vector3(cx, cy, cz));
    _camera!.radius = (sizeMax / Math.tan(_camera!.fov / 2)) * (cam.distanceMult ?? DEFAULT_DISTANCE_MULT);

    await _scene!.whenReadyAsync();
    _scene!.render();
    _scene!.render();
    const rawUrl = _canvas!.toDataURL('image/png');
    return await trimAndResize(rawUrl, THUMB_SIZE, options.iconScale ?? 1);
  } finally {
    disposeLoadResult(result);
  }
}

export async function getThumbnail(path: string, options: ThumbnailOptions = {}): Promise<string | null> {
  if (!path) return null;
  const cacheKey = buildCacheKey(path, options);

  const hot = memCache.get(cacheKey);
  if (hot !== undefined) return hot;

  const idb = await getCachedThumb(cacheKey, THUMB_VERSION);
  if (idb) {
    memCache.set(cacheKey, idb);
    return idb;
  }

  const rendered = await enqueue(path, options, cacheKey);
  memCache.set(cacheKey, rendered);
  return rendered;
}

export async function renderThumbnailPreview(path: string, options: ThumbnailOptions = {}): Promise<string | null> {
  if (!path) return null;
  return enqueue(path, options);
}

export async function invalidateThumbnail(path: string, options: ThumbnailOptions = {}): Promise<void> {
  if (!path) return;
  const cacheKey = buildCacheKey(path, options);
  memCache.delete(cacheKey);
  await clearCachedThumb(cacheKey);
}
