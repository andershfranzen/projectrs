import { Scene } from '@babylonjs/core/scene';
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader';
import { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import type { Mesh } from '@babylonjs/core/Meshes/mesh';
import { Skeleton } from '@babylonjs/core/Bones/skeleton';
import { Bone } from '@babylonjs/core/Bones/bone';
import { AnimationGroup } from '@babylonjs/core/Animations/animationGroup';
import { Animation } from '@babylonjs/core/Animations/animation';
import { Vector3, Quaternion } from '@babylonjs/core/Maths/math.vector';
import { Viewport } from '@babylonjs/core/Maths/math.viewport';
import { Matrix } from '@babylonjs/core/Maths/math.vector';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { MorphTarget } from '@babylonjs/core/Morph/morphTarget';
import { MorphTargetManager } from '@babylonjs/core/Morph/morphTargetManager';
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { type PlayerAppearance, type AppearanceColorSlot, APPEARANCE_MATERIAL_MAP, getPalette, BELT_NO_BELT, SHIRT_COLORS, HAIR_STYLE_COUNT } from '@projectrs/shared';
import '@babylonjs/loaders/glTF';
import { quantizeAnimationGroup, rs2Rotation, RS2_TURN_SNAP, wrapAnglePi, WALK_VARIANT_NAMES, isWalkVariant, type WalkVariantName } from './AnimationQuantizer';
import { remapSkinningToSkeleton } from './skinnedArmor';

const HAIR_MATERIAL_NAMES = new Set(['hair_1']);
const FACE_DETAIL_MATS = new Set([
  'Eye Pupil', 'Eye White', 'Eyebrow', 'Mouth', 'Lip',
  'Eyewhite2', 'Eye colour',
]);

function keepCloseCameraDetailVisible(mesh: AbstractMesh): void {
  // These meshes are tiny and skinned to the head. Their imported bounds can
  // sit just outside the camera frustum at close zoom / low camera angles even
  // while the visible vertices should still render, which looks like sudden
  // baldness or missing eyes. Always selecting only these detail meshes is
  // cheaper than disabling culling for the whole character.
  mesh.alwaysSelectAsActiveMesh = true;
  mesh.cullingStrategy = AbstractMesh.CULLINGSTRATEGY_OPTIMISTIC_INCLUSION_THEN_BSPHERE_ONLY;
}

/**
 * Smooth a mesh's vertex normals by averaging across vertices that share a
 * world-space position. Unlike `forceSharedVertices()`, this preserves the
 * original vertex layout — UVs, bone weights, and morph indices stay intact —
 * which is critical for skinned characters.
 *
 * Source character GLB has many meshes authored with split (per-face) normals,
 * making facet edges visible on arms and clothing. This averages them so
 * adjacent triangles share a smooth normal, fixing the blocky look without
 * touching geometry.
 */
function smoothNormalsByPosition(mesh: AbstractMesh): void {
  const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
  const normals = mesh.getVerticesData(VertexBuffer.NormalKind);
  if (!positions || !normals) return;

  const vCount = positions.length / 3;
  const groups = new Map<string, number[]>();
  for (let i = 0; i < vCount; i++) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    // Quantize to 4 decimals so float jitter doesn't fragment groups
    const key = `${Math.round(x * 10000)},${Math.round(y * 10000)},${Math.round(z * 10000)}`;
    let arr = groups.get(key);
    if (!arr) groups.set(key, arr = []);
    arr.push(i);
  }

  const newNormals = new Float32Array(normals);
  for (const indices of groups.values()) {
    if (indices.length < 2) continue;
    let nx = 0, ny = 0, nz = 0;
    for (const idx of indices) {
      nx += normals[idx * 3];
      ny += normals[idx * 3 + 1];
      nz += normals[idx * 3 + 2];
    }
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    for (const idx of indices) {
      newNormals[idx * 3] = nx;
      newNormals[idx * 3 + 1] = ny;
      newNormals[idx * 3 + 2] = nz;
    }
  }

  mesh.setVerticesData(VertexBuffer.NormalKind, newNormals);
}

// Head items that show hair around/below the brim — wide-brimmed/open hats don't
// fully enclose the skull, so suppressing hair under them looks bald, not helmeted.
const HAIR_VISIBLE_HEAD_ITEMS = new Set<number>([202, 220]); // Kettle Hat, Kettle Hat (F)

/**
 * Per-animation, per-bone rotation offsets applied during retargeting.
 * Outer key = animation name from additionalAnimations[].name ('idle', 'walk', …).
 * Use '*' to apply to every animation.
 * Inner values are Euler offsets (radians) post-multiplied onto every keyframe.
 * ~0.087 rad = 5°.
 */
const BONE_ROTATION_OFFSETS: Record<string, Record<string, { x: number; y: number; z: number }>> = {};

/**
 * In dev mode, append a cache-busting query param to GLB filenames so the
 * browser refetches them after each page load. Lets you overwrite a GLB on
 * disk and see the change with a hard refresh — without it, the browser HTTP
 * cache + Babylon's loader cache combine to serve the stale version.
 *
 * Per-page-load timestamp (not per-call) so multiple loads of the same anim
 * within one session share the same cache entry.
 */
const CACHE_BUST_TOKEN: string = import.meta.env.DEV ? `?v=${Date.now()}` : '';
function devCacheBust(file: string): string {
  return CACHE_BUST_TOKEN ? `${file}${CACHE_BUST_TOKEN}` : file;
}


/**
 * Per-animation playback speed multiplier. 1.0 = play at authored rate.
 * Use to compensate for cycle lengths that don't match in-game movement
 * (e.g. a 1.0s walk cycle at 3 tiles/sec stride = skating; 1.5x makes
 * it ~1 tile per step). Tune in code, no GLB re-export needed.
 */
const ANIM_SPEED_RATIO: Record<string, number> = {
  walk: 1.1,
};


/**
 * Animation state priority (higher = takes precedence).
 * The state machine always plays the highest-priority active state.
 */
export enum AnimState {
  Idle = 0,
  Walk = 1,
  Skill = 2,   // chopping, mining, fishing, etc.
  Attack = 3,
  Death = 4,
}

/** Gear attachment: a cloned mesh parented to a skeleton bone. */
interface GearAttachment {
  itemId: number;
  node: TransformNode;
}

/** Cached gear template ready to be cloned and attached. */
export interface GearTemplate {
  template: TransformNode;
  /** Which bone name to attach to (e.g. 'hand_R', 'head') */
  boneName: string;
  /** Local offset relative to the bone */
  localPosition: Vector3;
  /** Local rotation in euler radians */
  localRotation: Vector3;
  /** Uniform scale */
  scale: number;
}

/**
 * Configuration for loading gear templates.
 * Maps itemId → GLB file + attachment info.
 */
export interface GearDef {
  itemId: number;
  file: string;
  boneName: string;
  localPosition?: { x: number; y: number; z: number };
  localRotation?: { x: number; y: number; z: number };
  scale?: number;
  /** If true, keep the model's origin as-is (centered grip). Default: shift bottom to Y=0 (swords). */
  centerOrigin?: boolean;
  /** Optional tint for the "metal" material. The tool GLBs name their metal material
   *  `Material.002` (the handle is `Material.001`, which is left untouched). */
  metalColor?: [number, number, number];
}

/**
 * Additional animation to load from a separate GLB file.
 * The GLB only needs the armature + animation — the mesh is ignored.
 */
export interface AdditionalAnimation {
  /** Name to register the animation under (e.g. 'idle', 'attack_slash') */
  name: string;
  /** Path to the GLB file containing the animation */
  path: string;
  /** If the GLB contains multiple animations, pick this one by name. If omitted, uses the first. */
  animName?: string;
}

export interface CharacterEntityOptions {
  name: string;
  /** Path to the character .glb file (e.g. '/models/character.glb') */
  modelPath: string;
  /** Desired height of the character in world units (auto-scales the model) */
  targetHeight?: number;
  /** Label shown above head */
  label?: string;
  labelColor?: string;
  /**
   * Additional animations to load from separate GLB files.
   * Use this when you can't (or don't want to) merge animations in Blender.
   * Each GLB should contain the same armature with a single animation.
   */
  additionalAnimations?: AdditionalAnimation[];

  /**
   * Babylon layer-mask applied to every mesh of the character (body, hair,
   * gear, etc.). Use to isolate this character from cameras whose layerMask
   * doesn't share a bit with this value — e.g. the CharacterCreator preview
   * sets a unique mask so its character is invisible to the world camera.
   * Default = no override (Babylon's default 0x0FFFFFFF).
   */
  layerMask?: number;
}

/**
 * A 3D skeletal character entity.
 * Loads a GLB with embedded animations, supports gear attachment via bones,
 * and provides the same public interface as SpriteEntity for drop-in use.
 */
export class CharacterEntity {
  private scene: Scene;
  private root: TransformNode | null = null;
  private meshes: AbstractMesh[] = [];
  private skeleton: Skeleton | null = null;
  private _position: Vector3 = Vector3.Zero();
  private _rotationY: number = 0;
  private targetRotationY: number = 0;
  private modelScale: number = 1;
  private yOffset: number = 0; // half model height, for health bar positioning
  private childYOffset: number = 0; // -minY applied to root children so feet are at y=0
  private layerMask: number | undefined = undefined;

  // Animations — keyed by name as exported from Blender NLA strips
  private animGroups: Map<string, AnimationGroup> = new Map();
  private currentState: AnimState = AnimState.Idle;
  private currentAnimName: string = '';
  private queuedState: AnimState = AnimState.Idle;
  private queuedAnimName: string = '';

  // 7-slot RS2 movement set. Slot fields hold the animGroups key for each
  // movement direction; missing slots fall back to walkanim so a partial
  // set still plays (moonwalking sideways/back until the strafes exist).
  private readyanim: string = 'idle';
  private turnanim: string = 'turn';
  private walkanim: string = 'walk';
  private walkanim_b: string = 'walk_b';
  private walkanim_l: string = 'walk_l';
  private walkanim_r: string = 'walk_r';
  // Cached at ready() — strafe picker hot-path skips Map.has() per frame.
  private hasWalkB: boolean = false;
  private hasWalkL: boolean = false;
  private hasWalkR: boolean = false;

  // Travel direction tracked separately from body yaw (targetRotationY).
  // When face is unlocked the two coincide; when locked they diverge and
  // the (travel - body) delta drives the strafe-seq picker.
  private travelYaw: number = 0;
  private hasTravelDir: boolean = false;
  private faceLocked: boolean = false;

  // Wall-clock ms when the current walk cycle began. Lets
  // swapWalkSeqPreservingPhase resume a strafe variant at the same cycle
  // phase as the outgoing seq so the legs don't pop. All walk variants
  // must share cycle length (enforced via canonName in AnimationQuantizer).
  private walkCycleStartMs: number = 0;

  // Strafe quadrant thresholds. |delta| ≤ FORWARD → walk; ≥ BACK → walk_b;
  // otherwise walk_l/_r by sign of delta.
  private static readonly STRAFE_FORWARD_THRESHOLD = Math.PI / 4;   // 45°
  private static readonly STRAFE_BACK_THRESHOLD = Math.PI * 3 / 4;  // 135°

  // Layered attack: when a swing fires while walking, attack_<v>_upper plays
  // on top of <walk variant>_lower so the legs keep cycling. If walk stops
  // mid-swing we swap to attack_<v>_lower at the attack's current frame.
  // activeWalkBase records the variant driving the legs. Stored (not derived
  // from currentAnimName) because currentAnimName gets clobbered to
  // `${attack}_upper` during the layered window.
  private attackIsLayered: boolean = false;
  private activeAttackBase: string = '';
  private activeWalkBase: WalkVariantName = 'walk';
  // Cached `${activeWalkBase}_lower` name + group reference — avoid
  // re-allocating the template string and re-querying the Map on every
  // frame of startWalking's layered hot path.
  private activeWalkLowerName: string = 'walk_lower';
  private activeWalkLowerGroup: AnimationGroup | null = null;
  private attackStartMs: number = 0;

  // One-shot animations (attack/death) call back when done
  private oneShotCallback: (() => void) | null = null;

  // Gear — per equipment slot
  private gearAttachments: Map<string, GearAttachment> = new Map(); // slot name → attachment
  private boneRestRotations: Map<string, Quaternion> = new Map();
  private armatureNode: TransformNode | null = null;
  private skinnedArmorMeshes: Map<string, AbstractMesh[]> = new Map();
  private skinnedArmorItemIds: Map<string, number> = new Map();

  // Head meshes — collected during load for hide/show under full helmets
  private headMeshes: AbstractMesh[] = [];

  // Body torso meshes — hidden when body armor is equipped to avoid clipping.
  // The character GLB exports torso/belt as separate primitives keyed by
  // material name; we identify them here and toggle their visibility together.
  /** The single pickable mesh on the character. Skinned mesh bounding
   *  boxes don't follow the animated skeleton — leaving them pickable
   *  causes phantom hitboxes (notably ~1 m above the head, from M_hair_1's
   *  rest-pose AABB). applyPickability() disables picks on every other
   *  descendant and routes all clicks through this cylinder.
   *
   *  Setup: isPickable=true, isVisible=true (Babylon's picker skips
   *  isVisible=false), visibility=0 (transparent), layerMask=0 (no camera
   *  renders it — picker doesn't honour layerMask, so it still hits). */
  private pickProxy: Mesh | null = null;

  private bodyMeshes: AbstractMesh[] = [];
  /** Per body-mesh: original index buffer + a filtered version with chest /
   *  waist triangles removed. Chain mode swaps to the filtered buffer so
   *  only the sleeves/shoulders/collar of the shirt render (the chest
   *  area would otherwise z-fight with the chainbody GLB on top of it). */
  private bodyMeshIndices: Map<AbstractMesh, { full: Uint32Array; noChest: Uint32Array }> = new Map();
  /** Pants + socks mesh primitives — hidden when plate legs are equipped
   *  so the character's bare legs don't poke through the armor. */
  private legMeshes: AbstractMesh[] = [];

  // The "Skin" primitive — single mesh covering face, arms, hands, legs.
  // We pre-compute two index buffers: the original (full skin) and a
  // filtered one that omits arm-region triangles. setBodyVisible toggles
  // between them so body armor hides just the arms while hands/face/legs
  // stay visible.
  private skinMesh: AbstractMesh | null = null;
  private skinIndicesFull: Uint32Array | null = null;
  private skinIndicesNoArms: Uint32Array | null = null;
  private skinIndicesNoLegs: Uint32Array | null = null;
  private skinIndicesNoArmsNoLegs: Uint32Array | null = null;
  private bodyHidden: boolean = false;
  /** When true (plate body), arm triangles are also hidden on the skin mesh.
   *  When false (chain body), arms/shoulders/lower-neck stay visible even
   *  though the bare-chest mesh primitives are off. */
  private bodyHidesArms: boolean = false;
  private legsHidden: boolean = false;


  // Modular mesh parts — keyed by mesh name for show/hide
  private modularMeshes: Map<string, AbstractMesh> = new Map();

  // Last applied appearance — used to restore correct hair/face after helmet unequip
  private lastAppearance: PlayerAppearance | null = null;

  // Health bar (HTML overlay — same pattern as SpriteEntity)
  private healthBarEl: HTMLDivElement | null = null;
  private healthBarFillEl: HTMLDivElement | null = null;
  private healthBarTextEl: HTMLDivElement | null = null;
  private maxHealth: number = 10;
  private currentHealth: number = 10;
  private healthBarVisible: boolean = false;

  // Chat bubble
  private chatBubbleEl: HTMLDivElement | null = null;
  private chatBubbleTimer: ReturnType<typeof setTimeout> | null = null;

  // Persistent label (e.g. player name) — HTML overlay, projected like the
  // health bar and chat bubble. Optional; only created when options.label set.
  private labelEl: HTMLDivElement | null = null;
  private labelText: string = '';
  private labelColor: string = '#ffffff';

  // Feet-to-root offset. The 57-bone Mixamo rig has its skeleton origin at
  // hip height, so a naïve `root.position.y = groundY` places the *hips* on
  // the ground and the *feet* sink ~0.8 units below it. Hardcoded constant
  // because the runtime measurement was unreliable (idle animation hadn't
  // advanced enough at load time, gave 0 instead of the real ~0.8). If a
  // future rig has a different hip-to-foot distance, override this in the
  // entity options.
  private feetOffsetY: number = 0.85;

  // Ready state
  private _ready: boolean = false;
  private _readyPromise: Promise<void>;
  /** Whether scene.pick raycasts can hit this character's meshes. False on
   *  the local player so clicks pass through to whatever's behind them.
   *  See setPickable() — re-applied after every gear attach. */
  private _pickable: boolean = true;
  private _resolveReady!: () => void;

  constructor(scene: Scene, options: CharacterEntityOptions) {
    this.scene = scene;
    this.layerMask = options.layerMask;
    this._readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    if (options.label) {
      this.labelColor = options.labelColor ?? '#ffffff';
      this.setLabel(options.label);
    }
    this.load(options);
  }

  // ---------------------------------------------------------------------------
  // Loading
  // ---------------------------------------------------------------------------

  private async load(options: CharacterEntityOptions): Promise<void> {
    try {
      // Split path into directory + filename for SceneLoader
      const lastSlash = options.modelPath.lastIndexOf('/');
      const dir = options.modelPath.substring(0, lastSlash + 1);
      const file = devCacheBust(options.modelPath.substring(lastSlash + 1));

      const result = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);

      // Apply nearest-neighbor filtering to character textures
      for (const mesh of result.meshes) {
        const mat = mesh.material;
        if (mat && 'diffuseTexture' in mat && (mat as any).diffuseTexture) {
          (mat as any).diffuseTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
        }
        if (mat && 'albedoTexture' in mat && (mat as any).albedoTexture) {
          (mat as any).albedoTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
        }
      }

      // Root transform node (GLB __root__)
      this.root = new TransformNode(options.name, this.scene);
      for (const mesh of result.meshes) {
        if (!mesh.parent || mesh.parent.name === '__root__') {
          mesh.parent = this.root;
        }
      }
      // Dispose the __root__ created by the loader if it exists
      const loaderRoot = result.meshes.find(m => m.name === '__root__');
      if (loaderRoot && loaderRoot !== this.root) {
        // Re-parent its children first
        for (const child of loaderRoot.getChildren()) {
          (child as TransformNode).parent = this.root;
        }
      }

      // Find the Armature TransformNode — skinned armor meshes are parented here.
      // Match 'Armature' or any 'Armature.NNN' suffix that Blender's GLB exporter
      // uses when the armature was renamed (e.g. our character has 'Armature.001').
      for (const child of this.root.getChildren()) {
        if (child instanceof TransformNode && /^Armature(\.\d+)?$/.test(child.name)) {
          this.armatureNode = child;
          break;
        }
      }

      this.meshes = result.meshes.filter(m => m.getTotalVertices() > 0);
      this.skeleton = result.skeletons.length > 0 ? result.skeletons[0] : null;

      if (this.skeleton) {
        for (const bone of this.skeleton.bones) {
          const tn = bone.getTransformNode();
          if (tn?.rotationQuaternion) {
            this.boneRestRotations.set(bone.name, tn.rotationQuaternion.clone());
          }
        }
      }

      // Index modular hair meshes by name for show/hide (must happen before bounds calc).
      // Each hair mesh is skinned to the head bone; nudging mesh.position translates the
      // rendered hair without disturbing the underlying skin weights or skeleton,
      // and mesh.scaling expands it around the mesh pivot. Tune all three constants to taste.
      const HAIR_FORWARD_OFFSET = 0.005; // +Z = forward; was 0.01, pulled back a touch
      const HAIR_VERTICAL_OFFSET = -0.005; // -Y = down; raised slightly (was -0.01) to fix tiny scalp clipping
      const HAIR_SCALE = 1.015;
      for (const mesh of this.meshes) {
        if (mesh.name.startsWith('M_hair_')) {
          this.modularMeshes.set(mesh.name, mesh);
          keepCloseCameraDetailVisible(mesh);
          mesh.position.z += HAIR_FORWARD_OFFSET;
          mesh.position.y += HAIR_VERTICAL_OFFSET;
          mesh.scaling.scaleInPlace(HAIR_SCALE);
          mesh.setEnabled(false);
        }
      }

      // Bake a "tucked under brim" morph target on each hair mesh — vertices in
      // the upper half get pulled down to brim level and squeezed toward the
      // local centre, so wide-brim hats (kettle hat etc.) sit flush on the head
      // with the hair compressed underneath instead of poking through.
      this.buildHelmetHairMorphs();

      // Compute model bounds for scaling — only use enabled base body meshes
      let minY = Infinity, maxY = -Infinity;
      for (const mesh of this.meshes) {
        if (!mesh.isEnabled()) continue;
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo().boundingBox;
        if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
        if (bb.maximumWorld.y > maxY) maxY = bb.maximumWorld.y;
      }
      const modelHeight = maxY - minY;
      const targetH = options.targetHeight ?? 1.3;
      this.modelScale = modelHeight > 0 ? targetH / modelHeight : 1;
      this.yOffset = targetH / 2;

      // Adjust root so feet are at y=0
      this.childYOffset = -minY;
      for (const child of this.root.getChildren()) {
        (child as TransformNode).position.y -= minY;
      }
      this.root.scaling.set(this.modelScale, this.modelScale, this.modelScale);

      // Convert PBR → flat StandardMaterial (matches the low-poly world style).
      // Face-detail primitives (eye/mouth/lip/brow) are tiny (4–48 tris each)
      // and share vertex positions with the larger Skin mesh, so the generic
      // brighten-and-smooth pass washes them out into the skin and gives them
      // jittery depth ordering. Keep their authored colors and normals intact.
      for (const mesh of this.meshes) {
        const pbrMat = mesh.material as any;
        if (!pbrMat) continue;
        const isFaceDetail = FACE_DETAIL_MATS.has(pbrMat.name);
        if (isFaceDetail) keepCloseCameraDetailVisible(mesh);

        const flat = new StandardMaterial(`${pbrMat.name}_flat`, this.scene);
        const hasTexture = !!pbrMat.albedoTexture;

        if (hasTexture) {
          flat.diffuseTexture = pbrMat.albedoTexture;
          pbrMat.albedoTexture.updateSamplingMode(Texture.NEAREST_NEAREST);
        }
        if (pbrMat.albedoColor && !hasTexture) {
          // Face detail keeps its authored color — no 1.3x boost into Skin tone.
          const boost = isFaceDetail ? 1 : 1.3;
          flat.diffuseColor = new Color3(
            Math.min(1, pbrMat.albedoColor.r * boost),
            Math.min(1, pbrMat.albedoColor.g * boost),
            Math.min(1, pbrMat.albedoColor.b * boost),
          );
        }

        flat.specularColor = Color3.Black();
        if (!hasTexture && !isFaceDetail) {
          const dc = flat.diffuseColor;
          flat.emissiveColor = new Color3(dc.r * 0.55, dc.g * 0.55, dc.b * 0.55);
        }

        // Face detail (eye pupil/white/brow/mouth/lip) are 4–48-tri quads.
        // At close zoom the camera-to-face dot-product can flip across the
        // backface threshold as the camera orbits, culling them entirely.
        // Disable backface culling for these — negligible cost given the
        // tri counts, and stable visibility from any angle.
        flat.backFaceCulling = isFaceDetail ? false : (pbrMat.backFaceCulling ?? true);
        flat.alpha = 1;

        mesh.material = flat;

        // Soften visible facet edges on arms/clothing — many meshes ship with
        // split normals from the source DCC, which makes the low-poly silhouette
        // look blocky. Averaging across shared positions gives smooth shading
        // without altering geometry, UVs, or skin weights. Skip face detail —
        // the artist's authored normals carry the silhouette there.
        if (!isFaceDetail) smoothNormalsByPosition(mesh);

      }

      // Identify hair meshes for hide/show under full helmets, and the
      // torso/belt meshes for hide/show under body armor. The character GLB
      // splits "main character" into many primitives, one per material — so
      // we filter by material name (Shirt + variants + belt).
      const BODY_MATERIAL_NAMES = new Set(['shirt', 'shirt openings', 'mat_4550', 'belt']);
      // Only `pants` is the leg cover — `socks` are the feet/ankle visual
      // and stay visible. Plate legs cover thighs + shins, not feet.
      const LEG_MATERIAL_NAMES = new Set(['pants']);
      for (const mesh of this.meshes) {
        const n = mesh.name;
        if (n.startsWith('M_hair_')) {
          this.headMeshes.push(mesh);
          continue;
        }
        const matBase = mesh.material?.name.replace(/_flat$/, '').replace(/\.\d+$/, '').toLowerCase() ?? '';
        if (BODY_MATERIAL_NAMES.has(matBase)) {
          this.bodyMeshes.push(mesh);
          continue;
        }
        if (LEG_MATERIAL_NAMES.has(matBase)) {
          this.legMeshes.push(mesh);
          continue;
        }
        if (matBase === 'skin') {
          this.skinMesh = mesh;
          continue;
        }
        if (HAIR_MATERIAL_NAMES.has(matBase)) {
          this.headMeshes.push(mesh);
        }
      }
      this.buildSkinArmFilter();
      this.buildBodyChestFilter();

      // Collect animation groups from the main GLB
      for (const group of result.animationGroups) {
        const name = group.name.toLowerCase().replace(/\s+/g, '_');
        this.animGroups.set(name, group);
        group.stop();
      }

      // Load additional animations from separate GLB files
      if (options.additionalAnimations) {
        await this.loadAdditionalAnimations(options.additionalAnimations);
      }

      for (const [name, group] of this.animGroups) {
        quantizeAnimationGroup(group, name);
      }

      // Hips Y lock — strip vertical translation off mixamorig:Hips across
      // every loaded animation. The retarget pass for additional-animation
      // GLBs already does this, but the main GLB's bundled animations slip
      // past that path and were dropping the character into the ground at
      // idle. Doing it here as a final pass covers both sources.
      for (const [, group] of this.animGroups) {
        for (const ta of group.targetedAnimations) {
          const target = ta.target as any;
          if (target?.name !== 'mixamorig:Hips') continue;
          const prop = ta.animation.targetProperty;
          if (prop !== 'position' && !prop.startsWith('position')) continue;
          for (const k of ta.animation.getKeys()) {
            const v = k.value as any;
            if (v && typeof v.y === 'number') v.y = 0;
          }
        }
      }

      this.hasWalkB = this.animGroups.has(this.walkanim_b);
      this.hasWalkL = this.animGroups.has(this.walkanim_l);
      this.hasWalkR = this.animGroups.has(this.walkanim_r);

      // Start idle by default
      this.playAnimByState(AnimState.Idle);

      // Apply initial position (with feet offset)
      this.root.position.set(this._position.x, this._position.y + this.feetOffsetY, this._position.z);

      // Picking proxy — the ONLY pickable mesh on the character. All
      // skinned meshes (body, hair, gear) are forced non-pickable in
      // applyPickability() because their rest-pose AABBs extend far
      // above/around the visible silhouette (especially M_hair_1), which
      // caused the phantom "1 m of clickbox above the head" the user kept
      // hitting.
      //
      // Local-Y math (root scale ≈ 0.972 → world ≈ local × 0.972):
      //   feet      = -0.75 local  (≈ -0.73 world below root — verified)
      //   head crown= +0.825 local (≈ +0.80 world above root, char = 1.53 m)
      // Cutting 20 % off the top of the visible character height:
      //   top       = 0.825 - 0.315 = +0.510 local
      //   height    = 0.510 − (−0.75) = 1.26 local
      //   center    = (−0.75 + 0.510) / 2 = −0.12 local
      const proxyHeight = 1.26;
      const proxyDiameter = 1.0;
      const proxy = MeshBuilder.CreateCylinder(`${options.name}_pickProxy`, {
        height: proxyHeight,
        diameter: proxyDiameter,
        tessellation: 12,
      }, this.scene);
      proxy.parent = this.root;
      proxy.position.y = -0.12;
      proxy.isVisible = true;
      proxy.visibility = 0;
      proxy.isPickable = true;
      // layerMask=0 → no camera renders the cylinder (saves a per-frame
      // transparent draw); picker doesn't honour layerMask so it still hits.
      // applyLayerMask() must skip the proxy or it'll overwrite this.
      proxy.layerMask = 0;
      this.pickProxy = proxy;

      // Force all skinned meshes non-pickable so only the proxy catches
      // clicks (see applyPickability comment).
      this.applyPickability();

      // Propagate layerMask (if any) to all body+hair meshes
      this.applyLayerMask();

      this._ready = true;
      this._resolveReady();
    } catch (e) {
      console.error(`[CharacterEntity] Failed to load '${options.modelPath}':`, e);
      this._resolveReady(); // resolve anyway so callers don't hang
    }
  }

  /**
   * Load Mixamo animations from separate GLB files and retarget onto this skeleton.
   *
   * Only rotation tracks are transferred — position/scale tracks are discarded
   * because FBX→GLB exports use centimeter units that don't match our model.
   *
   * Rest-pose correction: FBX→GLB conversion can leave axis-compensation rotations
   * on bones (especially Hips). For each bone, if the source rest rotation differs
   * from ours, every keyframe is corrected:
   *   corrected = ourRest * inverse(srcRest) * keyframe
   * This removes the source rest orientation and applies ours, so animations play
   * in the correct orientation regardless of how the GLB was exported.
   */
  private async loadAdditionalAnimations(anims: AdditionalAnimation[]): Promise<void> {
    // Map bone names → our TransformNodes + their rest rotations
    const ourNodesByName = new Map<string, TransformNode>();
    const ourRestRotations = new Map<string, Quaternion>();

    if (this.skeleton) {
      for (const bone of this.skeleton.bones) {
        const tn = bone.getTransformNode();
        if (tn) {
          ourNodesByName.set(bone.name, tn);
          ourNodesByName.set(tn.name, tn);
          const rest = tn.rotationQuaternion?.clone() ?? Quaternion.Identity();
          ourRestRotations.set(bone.name, rest);
          ourRestRotations.set(tn.name, rest);
        }
      }
    }
    if (this.root) {
      for (const node of this.root.getDescendants(false)) {
        if (node instanceof TransformNode) {
          ourNodesByName.set(node.name, node);
        }
      }
    }

    interface LoadedFile {
      animationGroups: AnimationGroup[];
      skeletons: Skeleton[];
      meshes: AbstractMesh[];
      srcRestRotations: Map<string, Quaternion>;
    }
    const loadedFiles = new Map<string, LoadedFile>();

    // Phase 1: import every unique GLB in parallel. Previously this happened
    // serially inside the per-anim loop, which made first-time character load
    // O(N) over the network for N animation files (~2–5s for the 10 we ship).
    // Babylon's SceneLoader is single-threaded but its imports don't conflict
    // with each other — each one adds nodes to the scene with unique auto-
    // renamed names, and we capture per-file source rest rotations into
    // separately-scoped Maps before any retarget pass runs.
    const uniquePaths = Array.from(new Set(anims.map((a) => a.path)));
    await Promise.all(
      uniquePaths.map(async (animPath) => {
        try {
          const lastSlash = animPath.lastIndexOf('/');
          const dir = animPath.substring(0, lastSlash + 1);
          const file = devCacheBust(animPath.substring(lastSlash + 1));
          const imported = await SceneLoader.ImportMeshAsync('', dir, file, this.scene);

          // Capture source bone rest rotations from TransformNodes
          // (animation GLBs have no Skeleton — bones are just TransformNodes)
          const srcRestRotations = new Map<string, Quaternion>();
          for (const tn of imported.transformNodes) {
            if (tn.rotationQuaternion) {
              srcRestRotations.set(tn.name, tn.rotationQuaternion.clone());
            }
          }

          const result: LoadedFile = {
            animationGroups: imported.animationGroups,
            skeletons: imported.skeletons,
            meshes: imported.meshes,
            srcRestRotations,
          };
          loadedFiles.set(animPath, result);
          for (const g of result.animationGroups) g.stop();
        } catch {
          console.warn(`[CharacterEntity] Failed to load animation file ${animPath}`);
        }
      }),
    );

    // Phase 2: retarget each declared animation onto our skeleton. Synchronous
    // and fast — pure data transforms over already-loaded keyframes.
    for (const anim of anims) {
      try {
        const result = loadedFiles.get(anim.path);
        if (!result) continue;

        // Find the animation group. If animName is set, prefer that — but fall
        // back to the first action if the lookup fails. Mixamo-exported GLBs
        // with only one action often come out with a default Blender name like
        // 'Armature.001Action' that changes between re-exports, so requiring an
        // exact name match is brittle. The fallback covers the common case of
        // single-action anim GLBs without forcing the author to rename.
        let group: AnimationGroup | undefined;
        if (anim.animName) {
          group = result.animationGroups.find(g => g.name === anim.animName);
          if (!group && result.animationGroups.length === 1) {
            group = result.animationGroups[0];
          } else if (!group) {
            console.warn(`[CharacterEntity] '${anim.name}': animName '${anim.animName}' not found in '${anim.path}'. Available: ${result.animationGroups.map(g => g.name).join(', ')}`);
            continue;
          }
        } else {
          group = result.animationGroups[0];
        }
        if (!group) continue;

        const retargetedAnims = [];
        let missCount = 0;

        for (const ta of group.targetedAnimations) {
          const target = ta.target as TransformNode;
          if (!target?.name) continue;

          // Rotation tracks are always allowed.
          // Translation tracks are normally skipped because Mixamo bakes cm-scale
          // bone-bind offsets into them — replaying those on our meter-scale rig
          // blows the skin out into a giant plane. For spine-chain bones we
          // allow translation so hand-authored breathing (subtle vertical lift)
          // reads correctly, but only when the values are sub-meter — that
          // catches Blender-authored anims (m-scale, ~1cm magnitude) and rejects
          // Mixamo FBX→GLB exports (cm-scale, ~1000-magnitude bind data).
          const prop = ta.animation.targetProperty;
          const isRotation = prop === 'rotationQuaternion' || prop.startsWith('rotationQuaternion');
          const isTranslation = prop === 'position' || prop.startsWith('position');
          const TRANSLATION_BONE_WHITELIST = new Set([
            'mixamorig:Hips',
            'mixamorig:Spine',
            'mixamorig:Spine1',
            'mixamorig:Spine2',
          ]);
          if (!isRotation && !isTranslation) continue;
          if (isTranslation) {
            if (!TRANSLATION_BONE_WHITELIST.has(target.name)) continue;
            // Reject cm-scale Mixamo bind tracks — anything > 1m on any axis is
            // not real animation, it's bind-pose data exported in cm.
            const keys = ta.animation.getKeys();
            let maxMag = 0;
            for (const k of keys) {
              const v = k.value as any;
              if (v && typeof v.x === 'number') {
                const m = Math.max(Math.abs(v.x), Math.abs(v.y), Math.abs(v.z));
                if (m > maxMag) maxMag = m;
              }
            }
            if (maxMag > 1.0) continue;
            // Strip Y on Hips for all anims (Mixamo attack windups bake a
            // root dip that drops us below the floor); strip XZ too on the
            // in-place locomotion cycles, otherwise Mixamo sidestep sources
            // drift the character ~0.5m sideways per step on top of the
            // engine's movement.
            if (target.name === 'mixamorig:Hips') {
              const isInPlaceCycle = isWalkVariant(anim.name);
              for (const k of keys) {
                const v = k.value as any;
                if (v && typeof v.y === 'number') v.y = 0;
                if (isInPlaceCycle && v) {
                  if (typeof v.x === 'number') v.x = 0;
                  if (typeof v.z === 'number') v.z = 0;
                }
              }
            }
          }

          // Match source bone → our bone by name
          let ourTarget = ourNodesByName.get(target.name) ?? null;
          if (!ourTarget) {
            const stripped = target.name.replace(/\.\d+$/, '');
            ourTarget = ourNodesByName.get(stripped) ?? null;
          }

          if (!ourTarget) {
            // Thumb bones are intentionally absent on our 57-bone rig (we use
            // Mixamo's 32-bone skeleton plus Polysplit's Index/Middle/Ring/Pinky
            // fingers — no thumbs).
            if (!target.name.includes('Thumb')) missCount++;
            continue;
          }

          // Rest-pose correction: if source and target rest rotations differ,
          // transform each keyframe so it plays correctly on our skeleton.
          const srcRest = result.srcRestRotations.get(target.name);
          const ourRest = ourRestRotations.get(ourTarget.name);
          if (srcRest && ourRest) {
            const dot = Math.abs(Quaternion.Dot(srcRest, ourRest));
            if (dot < 0.999) {
              const srcRestInv = Quaternion.Inverse(srcRest);
              const keys = ta.animation.getKeys();
              for (const key of keys) {
                if (key.value && key.value.w !== undefined) {
                  key.value = ourRest.multiply(srcRestInv.multiply(key.value));
                }
              }
            }
          }

          // Apply constant bone rotation offsets (e.g. pull shoulders back).
          // Per-animation entries take priority; '*' applies to all.
          const offset = BONE_ROTATION_OFFSETS[anim.name]?.[ourTarget.name]
            ?? BONE_ROTATION_OFFSETS['*']?.[ourTarget.name];
          if (offset && (offset.x !== 0 || offset.y !== 0 || offset.z !== 0)) {
            const offsetQuat = Quaternion.FromEulerAngles(offset.x, offset.y, offset.z);
            const keys = ta.animation.getKeys();
            for (const key of keys) {
              if (key.value && key.value.w !== undefined) {
                key.value = key.value.multiply(offsetQuat);
              }
            }
          }

          retargetedAnims.push({ animation: ta.animation, target: ourTarget });
        }

        if (retargetedAnims.length > 0) {
          const newGroup = new AnimationGroup(anim.name, this.scene);
          for (const ra of retargetedAnims) {
            newGroup.addTargetedAnimation(ra.animation, ra.target);
          }
          this.animGroups.set(anim.name, newGroup);
          newGroup.stop();
        } else {
          console.warn(`[CharacterEntity] Retargeting failed for '${anim.name}' — 0 tracks matched`);
        }
      } catch (e) {
        console.warn(`[CharacterEntity] Failed to load '${anim.name}' from '${anim.path}':`, e);
      }
    }

    // Clean up loaded GLB resources
    for (const [, result] of loadedFiles) {
      for (const ag of result.animationGroups) ag.dispose();
      for (const sk of result.skeletons) sk.dispose();
      for (const mesh of result.meshes) mesh.dispose();
    }
  }

  /** Wait until the model is loaded and ready. */
  whenReady(): Promise<void> {
    return this._readyPromise;
  }

  get isReady(): boolean {
    return this._ready;
  }

  /** Stamp picking metadata on every mesh so right-click resolves to the
   *  intended NPC entity (mirrors Npc3DEntity.setEntityIdMetadata). Multiple
   *  customizable NPCs share the `main character.glb` source, so without
   *  this stamp every banker would be indistinguishable from every smith
   *  when the scene picker walks the mesh tree.
   *  Defers to whenReady so callers can stamp before load finishes. */
  setEntityIdMetadata(entityId: number): void {
    const stamp = () => {
      if (this.root) {
        this.root.metadata = { ...(this.root.metadata ?? {}), entityId, kind: 'npc' };
      }
      for (const mesh of this.meshes) {
        mesh.metadata = { ...(mesh.metadata ?? {}), entityId, kind: 'npc' };
      }
      // The pick proxy is the primary hit target — without metadata on it
      // the pick-walk-parents logic can't resolve the NPC entity from a
      // ray that hits the proxy first.
      if (this.pickProxy) {
        this.pickProxy.metadata = { ...(this.pickProxy.metadata ?? {}), entityId, kind: 'npc' };
      }
    };
    if (this._ready) stamp();
    else void this._readyPromise.then(stamp);
  }

  /** Make this character transparent to scene.pick raycasts. The local
   *  player calls this with `false` so right-clicking through your own
   *  character doesn't intercept the click and steal it from the NPC /
   *  object behind you. Reapplies on every subsequent gear attach so
   *  freshly-loaded armor meshes inherit the setting. */
  setPickable(pickable: boolean): void {
    this._pickable = pickable;
    if (this._ready) this.applyPickability();
    else void this._readyPromise.then(() => this.applyPickability());
  }

  private applyPickability(): void {
    if (!this.root) return;
    // Pick only the proxy cylinder. Skinned mesh AABBs (especially hair)
    // don't deform with pose, so leaving them pickable creates phantom
    // hitboxes above the visible character.
    for (const node of this.root.getDescendants(false)) {
      if (node === this.pickProxy) continue;
      if ('isPickable' in node) {
        (node as { isPickable: boolean }).isPickable = false;
      }
    }
    if (this.pickProxy) this.pickProxy.isPickable = this._pickable;
  }

  /** Freeze the character at the first frame of the idle animation. No
   *  per-frame animation evaluation runs — the skeleton matrix is computed
   *  once and stays. Used for stationary NPCs (bankers, shopkeepers) where
   *  saving the per-frame skin update is the largest mobile-budget win. */
  freezeAtIdle(): void {
    const apply = () => {
      const idle = this.animGroups.get('idle');
      if (idle) {
        // Sample frame 0 once, then stop the group so onBeforeAnimations
        // evaluations are skipped entirely. Babylon stops dispatching the
        // animation if the group is not started.
        idle.start(false, 1.0, idle.from, idle.from, false);
        idle.goToFrame(idle.from);
        idle.stop();
      }
    };
    if (this._ready) apply();
    else void this._readyPromise.then(apply);
  }

  // ---------------------------------------------------------------------------
  // Animation state machine
  // ---------------------------------------------------------------------------

  /**
   * Map an AnimState to the animation name(s) to try.
   * Override this to customize which GLB animations map to which states.
   * Falls back through the list until one is found.
   */
  private getAnimNamesForState(state: AnimState, variant?: string): string[] {
    switch (state) {
      case AnimState.Idle:
        return ['idle'];
      case AnimState.Walk:
        return ['walk'];
      case AnimState.Skill:
        return variant ? [variant, 'skill', 'chop', 'idle'] : ['skill', 'chop', 'mine', 'idle'];
      case AnimState.Attack:
        return variant ? [variant, 'attack_slash', 'attack'] : ['attack_punch', 'attack', 'attack_slash'];
      case AnimState.Death:
        return ['death', 'die'];
      default:
        return ['idle'];
    }
  }

  /** Begin or restart the walk cycle. Used by both startWalking and the
   *  playAnimByState(Walk) re-entry path (post-attack resume, etc.). */
  private startWalkCycle(): void {
    this.walkCycleStartMs = performance.now();
    this.playAnim(this.walkanim, true);
    this.currentState = AnimState.Walk;
  }

  /** Play the best matching animation for a given state. */
  private playAnimByState(state: AnimState, variant?: string, loop?: boolean): void {
    if (state === AnimState.Walk) {
      this.startWalkCycle();
      return;
    }
    const names = this.getAnimNamesForState(state, variant);
    for (const name of names) {
      const group = this.animGroups.get(name);
      if (group) {
        this.playAnim(name, loop ?? (state <= AnimState.Skill), () => {
          // One-shot finished — return to idle or walk
          if (this.currentState === state) {
            this.currentState = this.queuedState;
            this.playAnimByState(this.queuedState, this.queuedAnimName, undefined);
          }
        });
        this.currentState = state;
        return;
      }
    }
    // No animation found for this state — stay in current
    console.warn(`[CharacterEntity] No animation found for state ${AnimState[state]}, tried: ${names.join(', ')}`);
  }

  /** Lower-body bones in our Mixamo 57-bone rig. Hips is treated as
   *  lower-body so walk drives its slight bob while attacking-while-walking
   *  (and so attack's hip/spine swing flows through Spine, which lives in
   *  upper). All toe/foot/leg bones are lower; everything else is upper. */
  private static readonly LOWER_BODY_BONES = new Set([
    'hips',
    'leftupleg', 'leftleg', 'leftfoot', 'lefttoebase', 'lefttoe_end',
    'rightupleg', 'rightleg', 'rightfoot', 'righttoebase', 'righttoe_end',
  ]);
  private isLowerBodyBoneName(name: string): boolean {
    return CharacterEntity.LOWER_BODY_BONES.has(name.replace(/^mixamorig:/i, '').toLowerCase());
  }

  /** Lazily build `<name>_upper` and `<name>_lower` AnimationGroups from a
   *  source group by partitioning its TargetedAnimations by bone. Lets us
   *  play upper-body and lower-body of different anims concurrently —
   *  walk_lower + attack_X_upper while moving + swinging. */
  private ensureBoneSplitVariants(baseName: string): boolean {
    if (this.animGroups.has(`${baseName}_upper`) && this.animGroups.has(`${baseName}_lower`)) return true;
    const src = this.animGroups.get(baseName);
    if (!src) return false;
    const upper = new AnimationGroup(`${baseName}_upper`, this.scene);
    const lower = new AnimationGroup(`${baseName}_lower`, this.scene);
    for (const ta of src.targetedAnimations) {
      const t = ta.target as { name?: string };
      if (this.isLowerBodyBoneName(t?.name ?? '')) {
        lower.addTargetedAnimation(ta.animation, ta.target);
      } else {
        upper.addTargetedAnimation(ta.animation, ta.target);
      }
    }
    // normalize() needs at least one targeted animation, so guard each side.
    if (upper.targetedAnimations.length > 0) upper.normalize(src.from, src.to);
    if (lower.targetedAnimations.length > 0) lower.normalize(src.from, src.to);
    this.animGroups.set(`${baseName}_upper`, upper);
    this.animGroups.set(`${baseName}_lower`, lower);
    return true;
  }

  /** Stop any layered-attack groups and clear flags. Used both when the swing
   *  ends naturally and when we tear down to start a fresh full-body anim. */
  private clearLayeredAttack(): void {
    if (this.activeAttackBase) {
      this.animGroups.get(`${this.activeAttackBase}_upper`)?.stop();
      this.animGroups.get(`${this.activeAttackBase}_lower`)?.stop();
    }
    this.activeWalkLowerGroup?.stop();
    this.attackIsLayered = false;
    this.activeAttackBase = '';
    this.activeWalkBase = isWalkVariant(this.walkanim) ? this.walkanim : 'walk';
    this.activeWalkLowerName = `${this.activeWalkBase}_lower`;
    this.activeWalkLowerGroup = null;
  }

  /** Low-level: play a named animation group. */
  private playAnim(name: string, loop: boolean, onEnd?: () => void): void {
    if (name === this.currentAnimName && loop) return;

    const oldGroup = this.currentAnimName ? this.animGroups.get(this.currentAnimName) : null;
    const group = this.animGroups.get(name);
    if (!group) return;

    if (oldGroup) oldGroup.stop();
    const speed = this.getAnimationSpeed(name);
    group.start(loop, speed, group.from, group.to, false);

    this.currentAnimName = name;
    this.oneShotCallback = onEnd ?? null;

    if (!loop && onEnd) {
      group.onAnimationGroupEndObservable.addOnce(() => {
        if (this.oneShotCallback === onEnd) {
          this.oneShotCallback = null;
          onEnd();
        }
      });
    }
  }

  private getAnimDuration(group: AnimationGroup): number {
    return (group.to - group.from) / 60;
  }

  private getAnimationSpeed(name: string): number {
    return ANIM_SPEED_RATIO[name] ?? 1.0;
  }

  // ---------------------------------------------------------------------------
  // Public animation API (mirrors SpriteEntity interface)
  // ---------------------------------------------------------------------------

  /** Start walking animation. */
  startWalking(): void {
    // Layered-attack in progress: re-attach the active walk variant's
    // _lower behind the still-running attack_upper. Called every frame
    // while a path is active, so the steady-state path (lower already
    // playing) early-returns after the cached group's isPlaying check.
    if (this.attackIsLayered) {
      this.queuedState = AnimState.Walk;
      const walkLower = this.activeWalkLowerGroup;
      if (walkLower?.isPlaying) return;
      this.animGroups.get(`${this.activeAttackBase}_lower`)?.stop();
      if (walkLower) {
        walkLower.start(true, this.getAnimationSpeed(this.activeWalkLowerName),
          walkLower.from, walkLower.to, false);
      }
      return;
    }
    if (this.currentState >= AnimState.Attack) return; // don't interrupt attack
    this.queuedState = AnimState.Walk;
    this.queuedAnimName = '';
    // Walk preempts Skill (matches RS2 seq `postanim_move=abortanim`) so
    // clicking another rock while mining instantly aborts the swing.
    if (this.currentState <= AnimState.Skill) this.startWalkCycle();
  }

  /** Stop walking, return to idle. */
  stopWalking(): void {
    if (this.attackIsLayered) {
      const base = this.activeAttackBase;
      this.activeWalkLowerGroup?.stop();
      const lower = this.animGroups.get(`${base}_lower`);
      if (lower && lower.targetedAnimations.length > 0) {
        // Sync attack_lower's start frame to where the upper anim is so the
        // silhouette stays consistent — no rewind / jump-ahead on the legs.
        const speed = ANIM_SPEED_RATIO[base] ?? 1.0;
        const fps = lower.targetedAnimations[0]?.animation?.framePerSecond ?? 60;
        const elapsedMs = performance.now() - this.attackStartMs;
        const frame = Math.min(lower.from + (elapsedMs / 1000) * fps * speed, lower.to);
        lower.start(false, speed, frame, lower.to, false);
      }
      this.queuedState = AnimState.Idle;
      this.queuedAnimName = '';
      return;
    }
    if (this.currentState === AnimState.Walk) {
      this.playAnimByState(AnimState.Idle);
    }
    this.queuedState = AnimState.Idle;
    this.queuedAnimName = '';
  }

  isWalking(): boolean {
    return this.currentState === AnimState.Walk;
  }

  /**
   * Play a named animation as a one-shot, returning to idle when done.
   * Returns false (and does nothing) if the name isn't loaded — no fallback,
   * unlike playAttackAnimation. Used by debug commands like /spell and /anim.
   */
  playNamedOneShot(name: string): boolean {
    if (this.currentState === AnimState.Attack) return false;
    if (!this.animGroups.has(name)) return false;
    this.queuedState = this.currentState >= AnimState.Walk ? AnimState.Walk : AnimState.Idle;
    this.queuedAnimName = '';
    this.playAnim(name, false, () => {
      if (this.currentState === AnimState.Attack) {
        this.currentState = this.queuedState;
        this.playAnimByState(this.queuedState, this.queuedAnimName, undefined);
      }
    });
    this.currentState = AnimState.Attack;
    return true;
  }

  /** Play a one-shot attack animation. Optional variant name (e.g. 'attack_slash').
   *  When the player is currently walking, plays an upper-body-only variant
   *  layered over walk's lower-body so the legs keep cycling — the silhouette
   *  walks AND swings. stopWalking swaps walk_lower for attack_lower mid-swing
   *  so the legs finish the attack pose. */
  playAttackAnimation(variant?: string): void {
    if (this.currentState === AnimState.Attack) return;
    this.queuedState = this.currentState >= AnimState.Walk ? AnimState.Walk : AnimState.Idle;
    this.queuedAnimName = '';

    // Resolve the attack anim name the same way playAnimByState would, so
    // the layered path picks the same group (e.g. attack_2h_smash, falling
    // back to attack_slash, then attack).
    const names = this.getAnimNamesForState(AnimState.Attack, variant);
    let attackName = '';
    for (const n of names) {
      if (this.animGroups.has(n)) { attackName = n; break; }
    }

    const wasWalking = this.isWalking();
    // ensureBoneSplitVariants for the ACTIVE walk variant (strafe picker
    // may have swapped currentAnimName to walk_l/r/b during a face-locked
    // approach). Without this, playLayeredAttack would try to start a
    // walk_l_lower group that doesn't exist yet.
    if (
      wasWalking
      && attackName
      && this.ensureBoneSplitVariants(attackName)
      && this.ensureBoneSplitVariants(this.activeWalkVariant())
    ) {
      this.playLayeredAttack(attackName);
      return;
    }
    // Non-walking, or split-variants unavailable: existing full-body path.
    this.playAnimByState(AnimState.Attack, variant, false);
  }

  /** Resolve the active walk variant from currentAnimName. The strafe
   *  picker may have swapped to walk_l/r/b during a face-locked combat
   *  approach, so we can't assume 'walk'. Falls back to walkanim. */
  private activeWalkVariant(): WalkVariantName {
    return isWalkVariant(this.currentAnimName)
      ? this.currentAnimName
      : (isWalkVariant(this.walkanim) ? this.walkanim : 'walk');
  }

  /** Start a layered attack — `<variant>_lower` runs for the legs,
   *  attack_X_upper for the upper body. Detects which walk variant was
   *  playing (forward / strafe / back) so a player attacking mid-strafe
   *  keeps strafing on the legs instead of snapping to forward. */
  private playLayeredAttack(baseName: string): void {
    const walkVariant = this.activeWalkVariant();
    // Stop whichever walk variant is currently driving the body so it
    // doesn't fight attack_upper for upper-body bones.
    const currentWalk = this.animGroups.get(walkVariant);
    if (currentWalk?.isPlaying) currentWalk.stop();
    this.ensureBoneSplitVariants(walkVariant);
    const lowerName = `${walkVariant}_lower`;
    const walkLower = this.animGroups.get(lowerName) ?? null;
    if (walkLower) {
      walkLower.start(true, this.getAnimationSpeed(lowerName), walkLower.from, walkLower.to, false);
    }

    const upper = this.animGroups.get(`${baseName}_upper`);
    if (!upper) {
      // Shouldn't happen — caller checked ensureBoneSplitVariants — but be safe.
      this.playAnimByState(AnimState.Attack, undefined, false);
      return;
    }
    upper.start(false, ANIM_SPEED_RATIO[baseName] ?? 1.0, upper.from, upper.to, false);

    this.attackIsLayered = true;
    this.activeAttackBase = baseName;
    this.activeWalkBase = walkVariant;
    this.activeWalkLowerName = lowerName;
    this.activeWalkLowerGroup = walkLower;
    this.attackStartMs = performance.now();
    this.currentState = AnimState.Attack;
    this.currentAnimName = `${baseName}_upper`;

    upper.onAnimationGroupEndObservable.addOnce(() => {
      // Could already have been torn down by clearLayeredAttack() if the
      // caller stacked another action; guard against double-cleanup.
      if (!this.attackIsLayered || this.activeAttackBase !== baseName) return;
      this.clearLayeredAttack();
      this.currentState = AnimState.Idle;
      this.playAnimByState(this.queuedState, this.queuedAnimName, undefined);
    });
  }

  /** Play a looping skill animation (e.g. 'chop', 'mine', 'fish'). */
  startSkillAnimation(variant?: string): void {
    this.queuedState = AnimState.Skill;
    this.queuedAnimName = variant ?? '';
    this.playAnimByState(AnimState.Skill, variant, true);
  }

  /** Whether a skill animation is currently playing. */
  isSkillAnimPlaying(): boolean {
    return this.currentState === AnimState.Skill;
  }

  /** Stop skill animation, return to idle. */
  stopSkillAnimation(): void {
    if (this.currentState === AnimState.Skill) {
      this.playAnimByState(AnimState.Idle);
    }
    if (this.queuedState === AnimState.Skill) {
      this.queuedState = AnimState.Idle;
    }
  }

  /** Whether any one-shot animation is playing (attack/death). */
  isAnimating(): boolean {
    return this.currentState >= AnimState.Attack;
  }

  /** Wall-clock duration of a loaded animation in milliseconds (0 if unknown). */
  getAnimationDurationMs(name: string): number {
    const g = this.animGroups.get(name);
    if (!g) return 0;
    const fps = g.targetedAnimations[0]?.animation?.framePerSecond ?? 60;
    if (fps <= 0) return 0;
    return ((g.to - g.from) / fps) * 1000;
  }

  /** List all available animation names (as loaded from GLB). */
  getAnimationNames(): string[] {
    return [...this.animGroups.keys()];
  }

  // ---------------------------------------------------------------------------
  // Facing / rotation
  // ---------------------------------------------------------------------------

  setFacingAngle(radians: number): void {
    this._rotationY = radians;
    this.targetRotationY = radians;
    this.faceLocked = false;
    if (this.root) {
      this.root.rotation.y = radians;
    }
  }

  setTargetFacing(radians: number): void {
    this.targetRotationY = radians;
    this.faceLocked = false;
  }

  faceToward(target: Vector3, _cameraPos?: Vector3): void {
    this.faceTowardXZ(target.x, target.z);
  }

  /** No-allocation variant of faceToward — accepts raw x/z so the per-frame
   *  combat-follow loop doesn't need to construct a Vector3. */
  faceTowardXZ(x: number, z: number): void {
    const dx = x - this._position.x;
    const dz = z - this._position.z;
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    this.targetRotationY = Math.atan2(dx, dz);
    this.faceLocked = false;
  }

  /** Lock body yaw to a world-space point. While locked, walk emits strafe
   *  seqs instead of re-aiming the body. Mirrors RS2's faceEntity/faceSquare.
   *  Re-call each frame to track a moving target. */
  lockFaceToward(target: Vector3): void {
    this.lockFaceTowardXZ(target.x, target.z);
  }

  /** No-allocation overload for the per-frame combat hot path. */
  lockFaceTowardXZ(x: number, z: number): void {
    const dx = x - this._position.x;
    const dz = z - this._position.z;
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    this.targetRotationY = Math.atan2(dx, dz);
    this.faceLocked = true;
  }

  clearFaceLock(): void {
    if (!this.faceLocked) return;
    this.faceLocked = false;
  }

  updateMovementDirection(dx: number, dz: number, _cameraPos?: Vector3): void {
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    this.travelYaw = Math.atan2(dx, dz);
    this.hasTravelDir = true;
    // When unlocked the body chases travel; when locked the caller (combat/
    // talk) owns the body yaw target so the strafe picker can fire.
    if (!this.faceLocked) this.targetRotationY = this.travelYaw;
  }

  /** Pick the walk-seq slot name for the current body-yaw vs travel-yaw
   *  delta. Only meaningful while face-locked: an unlocked body chases
   *  travel direction so the diff is only non-zero during the rotation
   *  lerp, and we don't want strafe to flicker through that catch-up. */
  private pickWalkSeq(): string {
    const diff = wrapAnglePi(this.travelYaw - this._rotationY);
    const a = Math.abs(diff);
    if (a <= CharacterEntity.STRAFE_FORWARD_THRESHOLD) return this.walkanim;
    if (a >= CharacterEntity.STRAFE_BACK_THRESHOLD) return this.hasWalkB ? this.walkanim_b : this.walkanim;
    if (diff > 0) return this.hasWalkR ? this.walkanim_r : this.walkanim;
    return this.hasWalkL ? this.walkanim_l : this.walkanim;
  }

  /** Swap to a different walk-cycle group while preserving cycle phase, so
   *  the legs don't snap back to frame 0 on every strafe-direction change.
   *  Relies on all walk variants sharing cycle length (enforced via canonName
   *  in AnimationQuantizer). */
  private swapWalkSeqPreservingPhase(name: string): void {
    if (name === this.currentAnimName) return;
    const newGroup = this.animGroups.get(name);
    if (!newGroup) return;
    const oldGroup = this.currentAnimName ? this.animGroups.get(this.currentAnimName) : null;
    if (oldGroup) oldGroup.stop();

    const range = newGroup.to - newGroup.from;
    const fps = newGroup.targetedAnimations[0]?.animation?.framePerSecond ?? 60;
    const cycleSec = range / fps;
    const elapsedSec = (performance.now() - this.walkCycleStartMs) / 1000;
    const phase = cycleSec > 0 ? (elapsedSec % cycleSec) / cycleSec : 0;
    const startFrame = newGroup.from + phase * range;

    newGroup.start(true, this.getAnimationSpeed(name), newGroup.from, newGroup.to, false);
    newGroup.goToFrame(startFrame);
    this.currentAnimName = name;
  }

  /** SpriteEntity compat — no-op for 3D characters. */
  updateDirection(_cameraPos: Vector3): void {
    // 3D models don't need camera-based direction swapping
  }

  // ---------------------------------------------------------------------------
  // Position
  // ---------------------------------------------------------------------------

  get position(): Vector3 {
    return this._position;
  }

  set position(pos: Vector3) {
    this._position = pos;
    if (this.root) {
      this.root.position.set(pos.x, pos.y + this.feetOffsetY, pos.z);
    }
  }

  setPositionXYZ(x: number, y: number, z: number): void {
    this._position.set(x, y, z);
    if (this.root) {
      this.root.position.set(x, y + this.feetOffsetY, z);
    }
  }

  // ---------------------------------------------------------------------------
  // Per-frame update
  // ---------------------------------------------------------------------------

  updateAnimation(dt: number): void {
    if (!this.root) return;

    const newYaw = rs2Rotation(this._rotationY, this.targetRotationY, dt);
    if (newYaw !== this._rotationY) {
      this._rotationY = newYaw;
      this.root.rotation.y = newYaw;
    }

    // Strafe picker — only meaningful when face-locked AND we have a
    // travel direction. Layered attacks drive walk_lower directly and
    // would fight a swap, so skip them too.
    if (
      this.currentState === AnimState.Walk
      && this.faceLocked
      && this.hasTravelDir
      && !this.attackIsLayered
    ) {
      const seq = this.pickWalkSeq();
      if (seq !== this.currentAnimName) this.swapWalkSeqPreservingPhase(seq);
    }

    // 2004scape-style turn-in-place: while idle and rotating, swap to
    // turnanim until aligned. Walk state isn't affected — the walk cycle
    // covers body rotation implicitly. Higher-priority states (skill,
    // attack, death) lock the body anim.
    if (this.currentState === AnimState.Idle && this.animGroups.has(this.turnanim)) {
      const aligned = Math.abs(wrapAnglePi(this.targetRotationY - this._rotationY)) < RS2_TURN_SNAP;
      if (!aligned && this.currentAnimName !== this.turnanim) {
        this.playAnim(this.turnanim, true);
      } else if (aligned && this.currentAnimName === this.turnanim) {
        this.playAnim(this.readyanim, true);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Gear attachment
  // ---------------------------------------------------------------------------

  /**
   * Attach a gear piece to a bone.
   * @param slot Equipment slot name (e.g. 'weapon', 'head', 'body')
   * @param itemId The item ID for tracking
   * @param gearTemplate Pre-loaded gear template
   */
  attachGear(slot: string, itemId: number, gearTemplate: GearTemplate): void {
    // Remove existing gear in this slot
    this.detachGear(slot);

    if (!this.skeleton) {
      console.warn('[CharacterEntity] No skeleton — cannot attach gear');
      return;
    }

    // Find the bone by name
    const bone = this.skeleton.bones.find(b => b.name === gearTemplate.boneName);
    if (!bone) {
      console.warn(`[CharacterEntity] Bone '${gearTemplate.boneName}' not found in skeleton`);
      return;
    }

    // Clone the gear template
    const clone = gearTemplate.template.instantiateHierarchy(null, undefined, (source, cloned) => {
      cloned.name = `${source.name}_${slot}_${itemId}`;
    });
    if (!clone) {
      console.warn('[CharacterEntity] Failed to clone gear template');
      return;
    }

    clone.setEnabled(true);
    for (const child of clone.getChildMeshes()) {
      child.setEnabled(true);
    }

    // Attach to bone
    const boneTransform = bone.getTransformNode();
    if (boneTransform) {
      clone.parent = boneTransform;
    } else {
      // Fallback: attach to bone directly via attachToBone helper
      clone.attachToBone(bone, this.root!);
    }

    // Apply local transform — null out rotationQuaternion so euler rotation works
    clone.rotationQuaternion = null;
    clone.position.set(
      gearTemplate.localPosition.x,
      gearTemplate.localPosition.y,
      gearTemplate.localPosition.z
    );
    clone.rotation.set(
      gearTemplate.localRotation.x,
      gearTemplate.localRotation.y,
      gearTemplate.localRotation.z
    );
    const s = gearTemplate.scale;
    clone.scaling.set(s, s, s);

    this.gearAttachments.set(slot, { itemId, node: clone });
    if (slot === 'head') this.setHeadVisible(false);
    // Newly attached gear meshes default to isPickable=true — re-route picks
    // through the proxy so a hat/pauldron AABB doesn't re-introduce the
    // phantom hitbox. Also sets gear.layerMask correctly via applyLayerMask
    // (called separately by callers that need it).
    this.applyPickability();
  }

  /** Remove gear from a slot. */
  detachGear(slot: string): void {
    const existing = this.gearAttachments.get(slot);
    if (existing) {
      existing.node.dispose();
      this.gearAttachments.delete(slot);
    }
    if (slot === 'head' && this.getGearItemId('head') === -1) this.setHeadVisible(true);
  }

  /**
   * Attach skinned armor by parenting meshes directly under the Armature TransformNode.
   * This ensures the mesh world matrix chain is identical to the character mesh,
   * so GPU skinning produces correct results with no clipping.
   */
  attachSkinnedArmor(
    slot: string,
    meshes: AbstractMesh[],
    armorSkeleton: Skeleton,
    itemId: number = -1,
    bodyHideStyle: 'plate' | 'chain' = 'plate',
  ): void {
    this.detachSkinnedArmor(slot);
    if (!this.skeleton || !this.armatureNode) {
      console.warn('[CharacterEntity] Cannot attach skinned armor: no skeleton or armature');
      return;
    }
    // Armor is often authored against a smaller skeleton than ours (we have
    // 57 bones — Mixamo base + 25 finger bones — while a body might only
    // have 32). The shared helper does the name-based remap + vertex-buffer
    // rewrite + skeleton swap; we wrap with slot/visibility bookkeeping.
    const { meshes: kept } = remapSkinningToSkeleton(meshes, armorSkeleton, this.skeleton, this.armatureNode, {
      disposeSourceSkeleton: true,
      warnOnUnmapped: true,
    });
    this.skinnedArmorMeshes.set(slot, kept);
    this.skinnedArmorItemIds.set(slot, itemId);
    if (slot === 'head') this.setHeadVisible(false);
    if (slot === 'body') this.setBodyVisible(false, bodyHideStyle);
    if (slot === 'legs') this.setLegsVisible(false);
    this.applyPickability();
  }

  detachSkinnedArmor(slot: string): void {
    const meshes = this.skinnedArmorMeshes.get(slot);
    if (meshes) {
      for (const mesh of meshes) mesh.dispose();
      this.skinnedArmorMeshes.delete(slot);
      this.skinnedArmorItemIds.delete(slot);
    }
    if (slot === 'head' && this.getGearItemId('head') === -1) this.setHeadVisible(true);
    if (slot === 'body') this.setBodyVisible(true);
    if (slot === 'legs') this.setLegsVisible(true);
  }

  /**
   * Manual skinning binding for armor GLBs that Babylon's loader fails to
   * recognize as skinned (it imports the geometry/material correctly but drops
   * JOINTS_0/WEIGHTS_0 attributes). We fetch the GLB raw, pull the skin's
   * joint indices and per-vertex weights/joints out of the binary buffer, and
   * graft them onto the imported meshes — then bind to the character skeleton
   * with name-based bone remap.
   */
  async attachManualSkinnedArmor(
    slot: string,
    fileUrl: string,
    importedMeshes: AbstractMesh[],
    itemId: number = -1,
    bodyHideStyle: 'plate' | 'chain' = 'plate',
  ): Promise<boolean> {
    if (!this.skeleton || !this.armatureNode) {
      console.warn('[ManualSkin] No character skeleton/armature; skipping');
      return false;
    }
    try {
      const buf = await (await fetch(fileUrl)).arrayBuffer();
      const view = new DataView(buf);
      // GLB: magic(4) "glTF", version(4) = 2, length(4)
      if (view.getUint32(0, true) !== 0x46546c67) throw new Error('Not a GLB');
      // Chunk 0 (JSON): length(4) type(4)='JSON' data
      const jsonLen = view.getUint32(12, true);
      const jsonStr = new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen));
      const json = JSON.parse(jsonStr) as any;
      // Chunk 1 (BIN): length(4) type(4)='BIN ' data — start at 12+8+jsonLen+8
      const binStart = 12 + 8 + jsonLen + 8;

      const skin = json.skins?.[0];
      if (!skin) throw new Error('GLB has no skin');
      const meshNode = json.nodes.find((n: any) => n.skin !== undefined && n.mesh !== undefined);
      if (!meshNode) throw new Error('GLB has no node with both mesh and skin');
      const meshDef = json.meshes[meshNode.mesh];

      // Build name-based remap: armor joint index → character bone index
      const armorJointNames: string[] = skin.joints.map((nodeIdx: number) => json.nodes[nodeIdx].name);
      const remap = new Int32Array(armorJointNames.length);
      let unmapped = 0;
      for (let i = 0; i < armorJointNames.length; i++) {
        const name = armorJointNames[i];
        const charIdx = this.skeleton.bones.findIndex(b => b.name === name);
        if (charIdx < 0) { remap[i] = 0; unmapped++; }
        else remap[i] = charIdx;
      }

      // glTF accessor → typed array slice from the BIN chunk
      const componentSize = (ct: number): number =>
        ({ 5121: 1, 5123: 2, 5125: 4, 5126: 4, 5120: 1, 5122: 2 } as Record<number, number>)[ct] ?? 4;
      const numComponents = (t: string): number =>
        ({ SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 } as Record<string, number>)[t] ?? 1;
      const readAccessor = (accIdx: number): { kind: number; data: Uint8Array | Uint16Array | Float32Array; ncomp: number } => {
        const acc = json.accessors[accIdx];
        const bv = json.bufferViews[acc.bufferView];
        const offset = (bv.byteOffset || 0) + (acc.byteOffset || 0);
        const nc = numComponents(acc.type);
        const total = acc.count * nc;
        const start = binStart + offset;
        let data: Uint8Array | Uint16Array | Float32Array;
        switch (acc.componentType) {
          case 5121: data = new Uint8Array(buf.slice(start, start + total * 1)); break;
          case 5123: data = new Uint16Array(buf.slice(start, start + total * 2)); break;
          case 5126: data = new Float32Array(buf.slice(start, start + total * 4)); break;
          default: throw new Error(`Unsupported component type ${acc.componentType}`);
        }
        return { kind: acc.componentType, data, ncomp: nc };
      };

      // Find the imported meshes that correspond to each glTF primitive.
      // Babylon names them like "{meshName}_primitive{i}" (or just "{meshName}"
      // for single-primitive meshes).
      const baseName = meshNode.name;
      const importedByPrim = new Map<number, AbstractMesh>();
      for (let i = 0; i < meshDef.primitives.length; i++) {
        const wantedNames = meshDef.primitives.length === 1
          ? [baseName, `${baseName}_primitive0`]
          : [`${baseName}_primitive${i}`];
        const m = importedMeshes.find(im => wantedNames.includes(im.name) && im.getTotalVertices() > 0);
        if (m) importedByPrim.set(i, m);
      }
      if (importedByPrim.size === 0) {
        throw new Error(`Could not match any imported mesh to glTF primitives for "${baseName}"`);
      }

      const kept: AbstractMesh[] = [];
      for (let i = 0; i < meshDef.primitives.length; i++) {
        const prim = meshDef.primitives[i];
        const mesh = importedByPrim.get(i);
        if (!mesh) continue;

        const jointsAcc = prim.attributes.JOINTS_0;
        const weightsAcc = prim.attributes.WEIGHTS_0;
        if (jointsAcc === undefined || weightsAcc === undefined) continue;

        const joints = readAccessor(jointsAcc).data; // typically Uint8Array, 4 per vertex
        const weights = readAccessor(weightsAcc).data; // typically Float32Array, 4 per vertex

        // Remap joint indices and convert to Float32Array (Babylon's MatricesIndicesKind).
        const remappedJoints = new Float32Array(joints.length);
        for (let k = 0; k < joints.length; k++) {
          const src = joints[k];
          remappedJoints[k] = src < remap.length ? remap[src] : 0;
        }
        const weightsF32 = weights instanceof Float32Array ? weights : Float32Array.from(weights);

        mesh.setVerticesData(VertexBuffer.MatricesIndicesKind, remappedJoints, false);
        mesh.setVerticesData(VertexBuffer.MatricesWeightsKind, weightsF32, false);
        mesh.numBoneInfluencers = 4;
        mesh.skeleton = this.skeleton;
        mesh.parent = this.armatureNode;
        mesh.rotationQuaternion = null;
        mesh.position.set(0, 0, 0);
        mesh.rotation.set(0, 0, 0);
        mesh.scaling.set(1, 1, 1);
        kept.push(mesh);
      }

      this.detachSkinnedArmor(slot);
      this.skinnedArmorMeshes.set(slot, kept);
      this.skinnedArmorItemIds.set(slot, itemId);
      if (slot === 'head') this.setHeadVisible(false);
      if (slot === 'body') this.setBodyVisible(false, bodyHideStyle);
      if (slot === 'legs') this.setLegsVisible(false);
      this.applyPickability();
      return true;
    } catch (e) {
      console.warn(`[ManualSkin] Failed for ${fileUrl}:`, e);
      return false;
    }
  }

  applySkinnedArmorTransform(slot: string, override: { localPosition?: { x: number; y: number; z: number }; localRotation?: { x: number; y: number; z: number }; scale?: number }): void {
    const meshes = this.skinnedArmorMeshes.get(slot);
    if (!meshes) return;
    for (const mesh of meshes) {
      if (override.localPosition) {
        mesh.position.set(override.localPosition.x, override.localPosition.y, override.localPosition.z);
      }
      if (override.localRotation) {
        mesh.rotation.set(override.localRotation.x, override.localRotation.y, override.localRotation.z);
      }
      if (override.scale != null) {
        mesh.scaling.set(override.scale, override.scale, override.scale);
      }
    }
  }

  /** Get the transform node for gear in a slot (for debug panel). */
  getGearNode(slot: string): import('@babylonjs/core/Meshes/transformNode').TransformNode | null {
    return this.gearAttachments.get(slot)?.node ?? this.skinnedArmorMeshes.get(slot)?.[0] ?? null;
  }

  getSkinnedArmorMeshes(slot: string): AbstractMesh[] | undefined {
    return this.skinnedArmorMeshes.get(slot);
  }

  /** Hide/show the underlying torso/belt meshes. Called when a body-slot
   *  armor is equipped/unequipped to avoid the armor mesh z-fighting with
   *  the character's torso geometry beneath it. Also swaps the Skin
   *  primitive's index buffer to drop arm triangles only — hands/face/legs
   *  remain visible. */
  /** Toggle bare-chest visibility for a body-slot item. `hideStyle` only
   *  matters when hiding (visible=false):
   *    - 'plate' hides the bare-chest (shirt) primitive AND hides arm
   *      triangles on the skin mesh. Plate armor brings its own sleeves
   *      and shoulders.
   *    - 'chain' leaves the shirt visible BUT swaps it to a filtered index
   *      buffer that drops chest/waist triangles. The chainbody GLB sits
   *      over the now-empty chest area; the shirt's sleeves/shoulders/
   *      collar render normally and provide the upper-arm + lower-neck
   *      coverage the bare-skin mesh doesn't have geometry for. */
  setBodyVisible(visible: boolean, hideStyle: 'plate' | 'chain' = 'plate'): void {
    for (const m of this.bodyMeshes) {
      if (visible || hideStyle === 'chain') {
        const bufs = this.bodyMeshIndices.get(m);
        if (bufs) m.setIndices(visible ? bufs.full : bufs.noChest, null);
        m.setEnabled(true);
      } else {
        m.setEnabled(false);
      }
    }
    this.bodyHidden = !visible;
    this.bodyHidesArms = !visible && hideStyle === 'plate';
    this.applySkinIndexMask();
  }

  /** Hide leg-region triangles on the character's skin mesh AND the pants/
   *  socks mesh primitives while plate legs are equipped. Pairs with
   *  setBodyVisible (arm-hide); wearing both stacks the skin-mesh filters
   *  into a single index buffer. */
  setLegsVisible(visible: boolean): void {
    for (const m of this.legMeshes) m.setEnabled(visible);
    this.legsHidden = !visible;
    this.applySkinIndexMask();
  }

  private applySkinIndexMask(): void {
    if (!this.skinMesh || !this.skinIndicesFull) return;
    let target: Uint32Array | null = this.skinIndicesFull;
    if (this.bodyHidesArms && this.legsHidden && this.skinIndicesNoArmsNoLegs) target = this.skinIndicesNoArmsNoLegs;
    else if (this.bodyHidesArms && this.skinIndicesNoArms) target = this.skinIndicesNoArms;
    else if (this.legsHidden && this.skinIndicesNoLegs) target = this.skinIndicesNoLegs;
    if (target) this.skinMesh.setIndices(target, null);
  }

  /** Pre-compute filtered index buffers for the Skin mesh that drop arm
   *  triangles, leg triangles, or both. A triangle is dropped only when
   *  ALL three vertices have a dominant bone in the target region —
   *  triangles spanning a region boundary (e.g. wrist, ankle) stay so the
   *  edge under the armor sleeve/cuff stays clean. Built once at load. */
  private buildSkinArmFilter(): void {
    if (!this.skinMesh || !this.skeleton) return;
    const positions = this.skinMesh.getVerticesData(VertexBuffer.PositionKind);
    const joints = this.skinMesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
    const weights = this.skinMesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
    const indices = this.skinMesh.getIndices();
    if (!positions || !joints || !weights || !indices) return;

    const ARM_BONE_NAMES = new Set([
      'mixamorig:LeftShoulder', 'mixamorig:LeftArm', 'mixamorig:LeftForeArm',
      'mixamorig:RightShoulder', 'mixamorig:RightArm', 'mixamorig:RightForeArm',
    ]);
    // Plate legs cover thighs + shins, not feet. Leaving Foot / ToeBase
    // out of the leg-bone set keeps the skin-mesh foot triangles visible
    // so the feet aren't accidentally hidden. Feet are the `feet` slot's
    // responsibility (boots).
    const LEG_BONE_NAMES = new Set([
      'mixamorig:LeftUpLeg', 'mixamorig:LeftLeg',
      'mixamorig:RightUpLeg', 'mixamorig:RightLeg',
    ]);
    const armIdx = new Set<number>();
    const legIdx = new Set<number>();
    for (let i = 0; i < this.skeleton.bones.length; i++) {
      const name = this.skeleton.bones[i].name;
      if (ARM_BONE_NAMES.has(name)) armIdx.add(i);
      if (LEG_BONE_NAMES.has(name)) legIdx.add(i);
    }

    // Per-vertex region classification using each vert's DOMINANT bone.
    // Uses the actual rig binding rather than weight thresholds — symmetric
    // even when weight painting isn't perfectly mirrored.
    const numVerts = positions.length / 3;
    const isArmVert = new Uint8Array(numVerts);
    const isLegVert = new Uint8Array(numVerts);
    for (let v = 0; v < numVerts; v++) {
      let bestW = -1, bestJ = -1;
      for (let k = 0; k < 4; k++) {
        const w = weights[v * 4 + k];
        if (w > bestW) { bestW = w; bestJ = joints[v * 4 + k] | 0; }
      }
      if (bestJ >= 0) {
        if (armIdx.has(bestJ)) isArmVert[v] = 1;
        else if (legIdx.has(bestJ)) isLegVert[v] = 1;
      }
    }

    const numTris = indices.length / 3;
    const noArm: number[] = [];
    const noLeg: number[] = [];
    const noArmNoLeg: number[] = [];
    for (let t = 0; t < numTris; t++) {
      const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
      const allArm = isArmVert[a] && isArmVert[b] && isArmVert[c];
      const allLeg = isLegVert[a] && isLegVert[b] && isLegVert[c];
      if (!allArm) noArm.push(a, b, c);
      if (!allLeg) noLeg.push(a, b, c);
      if (!allArm && !allLeg) noArmNoLeg.push(a, b, c);
    }

    this.skinIndicesFull = new Uint32Array(indices as ArrayLike<number>);
    this.skinIndicesNoArms = armIdx.size > 0 ? new Uint32Array(noArm) : null;
    this.skinIndicesNoLegs = legIdx.size > 0 ? new Uint32Array(noLeg) : null;
    this.skinIndicesNoArmsNoLegs = (armIdx.size > 0 && legIdx.size > 0) ? new Uint32Array(noArmNoLeg) : null;
  }

  /** Pre-compute a filtered index buffer for every body-slot mesh (shirt,
   *  shirt openings, belt, etc.) that drops chest/waist triangles. Chain
   *  mode swaps to this buffer so the chainbody GLB owns the chest while
   *  the shirt's sleeves/shoulders/collar/neckline remain visible.
   *
   *  Bone-based classification with a Y override for Spine2. The shirt's
   *  Spine2-weighted verts span Y[1.12, 1.30] — the lower half is upper
   *  chest (drop, the chainbody covers it), the upper half is the collar
   *  and neckline (keep, otherwise the bare-skin "Neck" region has no
   *  geometry to fill). Threshold of 1.20 cleanly splits the two.
   *  Hips/Spine/Spine1 are always chest (no neck mixing). */
  private buildBodyChestFilter(): void {
    if (!this.skeleton) return;
    const SOLID_CHEST_BONES = new Set([
      'mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:Spine1',
    ]);
    const SPINE2_NAME = 'mixamorig:Spine2';
    const NECK_KEEP_Y = 1.20;

    const solidChestIdx = new Set<number>();
    let spine2Idx = -1;
    for (let i = 0; i < this.skeleton.bones.length; i++) {
      const n = this.skeleton.bones[i].name;
      if (SOLID_CHEST_BONES.has(n)) solidChestIdx.add(i);
      else if (n === SPINE2_NAME) spine2Idx = i;
    }

    for (const mesh of this.bodyMeshes) {
      const positions = mesh.getVerticesData(VertexBuffer.PositionKind);
      const joints = mesh.getVerticesData(VertexBuffer.MatricesIndicesKind);
      const weights = mesh.getVerticesData(VertexBuffer.MatricesWeightsKind);
      const indices = mesh.getIndices();
      if (!positions || !joints || !weights || !indices) continue;

      const numVerts = positions.length / 3;
      const isChestVert = new Uint8Array(numVerts);
      for (let v = 0; v < numVerts; v++) {
        let bestW = -1, bestJ = -1;
        for (let k = 0; k < 4; k++) {
          const w = weights[v * 4 + k];
          if (w > bestW) { bestW = w; bestJ = joints[v * 4 + k] | 0; }
        }
        if (bestJ < 0) continue;
        if (solidChestIdx.has(bestJ)) {
          isChestVert[v] = 1;
        } else if (bestJ === spine2Idx) {
          // Spine2 covers both upper chest and collar. Y separates them.
          if (positions[v * 3 + 1] < NECK_KEEP_Y) isChestVert[v] = 1;
        }
      }

      const numTris = indices.length / 3;
      const noChest: number[] = [];
      for (let t = 0; t < numTris; t++) {
        const a = indices[t * 3], b = indices[t * 3 + 1], c = indices[t * 3 + 2];
        if (!(isChestVert[a] && isChestVert[b] && isChestVert[c])) {
          noChest.push(a, b, c);
        }
      }
      this.bodyMeshIndices.set(mesh, {
        full: new Uint32Array(indices as ArrayLike<number>),
        noChest: new Uint32Array(noChest),
      });
    }
  }

  setHeadVisible(visible: boolean): void {
    if (!visible) {
      // Wide-brimmed/open hats (kettle hat, etc.) leave hair visible (compressed via morph).
      if (HAIR_VISIBLE_HEAD_ITEMS.has(this.getGearItemId('head'))) {
        this.setHelmetHairMorph(true);
        return;
      }
      for (const mesh of this.headMeshes) {
        mesh.setEnabled(false);
      }
    } else {
      // Re-enable face / non-hair head meshes...
      for (const mesh of this.headMeshes) {
        if (!mesh.name.startsWith('M_hair_')) mesh.setEnabled(true);
      }
      // ...and exactly one hair style. Default to 1 if no appearance set yet
      // — without this fallback, a no-appearance character was getting every
      // M_hair_N enabled at once because headMeshes contains all of them.
      const hairStyle = this.lastAppearance?.hairStyle ?? 1;
      for (let i = 1; i <= HAIR_STYLE_COUNT; i++) {
        this.modularMeshes.get(`M_hair_${i}`)?.setEnabled(i === hairStyle);
      }
    }
    this.setHelmetHairMorph(false);
  }

  /**
   * Build a "tucked under brim" morph target for each indexed M_hair_N mesh.
   * Vertices in the upper half of the local-space hair bbox get clamped down
   * to mid-height and squeezed toward the local centre on X/Z, producing a
   * skullcap silhouette that fits under a wide-brim hat. Influence stays at 0
   * until a kettle-hat-style helm is equipped (see setHelmetHairMorph).
   */
  private buildHelmetHairMorphs(): void {
    for (const [name, hairMesh] of this.modularMeshes) {
      if (!name.startsWith('M_hair_')) continue;
      const positions = hairMesh.getVerticesData(VertexBuffer.PositionKind);
      if (!positions) continue;

      // Pass `false` for applySkeleton — these are static hair meshes and
      // recomputing in skeleton-space here would yield bad bounds.
      hairMesh.refreshBoundingInfo(false, false);
      const bbox = hairMesh.getBoundingInfo().boundingBox;
      const minY = bbox.minimum.y;
      const maxY = bbox.maximum.y;
      // Cut at 50% up the hair — top half collapses to brim height.
      const brimY = minY + (maxY - minY) * 0.5;

      const tucked = new Float32Array(positions.length);
      for (let i = 0; i < positions.length; i += 3) {
        const x = positions[i];
        const y = positions[i + 1];
        const z = positions[i + 2];
        if (y > brimY) {
          // Clamp Y to brim, squeeze X/Z toward centre so it doesn't widen out.
          tucked[i] = x * 0.65;
          tucked[i + 1] = brimY;
          tucked[i + 2] = z * 0.65;
        } else {
          tucked[i] = x;
          tucked[i + 1] = y;
          tucked[i + 2] = z;
        }
      }

      const morph = new MorphTarget(`${name}_tucked`, 0, this.scene);
      morph.setPositions(tucked);

      let mgr = hairMesh.morphTargetManager;
      if (!mgr) {
        mgr = new MorphTargetManager(this.scene);
        hairMesh.morphTargetManager = mgr;
      }
      mgr.addTarget(morph);
    }
  }

  /** Toggle the tucked-under-brim morph target on every hair mesh (influence 0/1). */
  private setHelmetHairMorph(active: boolean): void {
    for (const [name, hairMesh] of this.modularMeshes) {
      if (!name.startsWith('M_hair_')) continue;
      const mgr = hairMesh.morphTargetManager;
      if (!mgr || mgr.numTargets === 0) continue;
      const target = mgr.getTarget(0);
      if (target) target.influence = active ? 1 : 0;
    }
  }


  /** Remove all gear (bone-parented + skinned). */
  detachAllGear(): void {
    for (const [slot] of this.gearAttachments) {
      this.detachGear(slot);
    }
    for (const [slot] of this.skinnedArmorMeshes) {
      this.detachSkinnedArmor(slot);
    }
  }

  /** Get currently attached gear item ID for a slot, or -1. */
  getGearItemId(slot: string): number {
    return this.gearAttachments.get(slot)?.itemId ?? this.skinnedArmorItemIds.get(slot) ?? -1;
  }

  // ---------------------------------------------------------------------------
  // Health bar (same HTML overlay pattern as SpriteEntity)
  // ---------------------------------------------------------------------------

  showHealthBar(current: number, max: number): void {
    this.currentHealth = current;
    this.maxHealth = max;
    this.healthBarVisible = true;

    if (!this.healthBarEl) {
      this.healthBarEl = document.createElement('div');
      this.healthBarEl.className = 'entity-health-bar';
      this.healthBarEl.style.cssText = `
        position: fixed; pointer-events: none; z-index: 150;
        width: 48px; height: 8px;
        background: #400; border: 1px solid #000;
        transform: translate(-50%, -50%);
        border-radius: 1px; overflow: hidden;
      `;
      this.healthBarFillEl = document.createElement('div');
      this.healthBarFillEl.style.cssText = `
        height: 100%; transition: width 0.15s, background 0.15s;
      `;
      this.healthBarEl.appendChild(this.healthBarFillEl);
      this.healthBarTextEl = document.createElement('div');
      this.healthBarTextEl.style.cssText = `
        position: absolute; top: -1px; left: 0; right: 0;
        text-align: center; font-family: Arial, Helvetica, sans-serif;
        font-size: 8px; font-weight: bold; color: #fff;
        text-shadow: 1px 1px 0 #000, -1px -1px 0 #000;
        line-height: 10px; pointer-events: none;
      `;
      this.healthBarEl.appendChild(this.healthBarTextEl);
      document.body.appendChild(this.healthBarEl);
    }

    const ratio = Math.max(0, current / max);
    this.healthBarFillEl!.style.width = `${ratio * 100}%`;
    if (ratio > 0.5) {
      this.healthBarFillEl!.style.background = '#0b0';
    } else if (ratio > 0.25) {
      this.healthBarFillEl!.style.background = '#bb0';
    } else {
      this.healthBarFillEl!.style.background = '#b00';
    }
    this.healthBarTextEl!.textContent = `${current}/${max}`;
  }

  hideHealthBar(): void {
    this.healthBarVisible = false;
    if (this.healthBarEl) {
      this.healthBarEl.remove();
      this.healthBarEl = null;
      this.healthBarFillEl = null;
      this.healthBarTextEl = null;
    }
  }

  getHealthBarWorldPos(out?: Vector3): Vector3 | null {
    if (!this.healthBarVisible || !this.healthBarEl) return null;
    const v = out ?? new Vector3();
    v.set(this._position.x, this._position.y + this.yOffset * 2 + 0.3, this._position.z);
    return v;
  }

  updateHealthBarScreenPos(screenX: number, screenY: number): void {
    if (this.healthBarEl) {
      this.healthBarEl.style.left = `${screenX}px`;
      this.healthBarEl.style.top = `${screenY}px`;
    }
  }

  hasHealthBar(): boolean {
    return this.healthBarVisible && this.healthBarEl !== null;
  }

  // ---------------------------------------------------------------------------
  // Chat bubble (same HTML overlay pattern as SpriteEntity)
  // ---------------------------------------------------------------------------

  showChatBubble(message: string, duration: number = 5000): void {
    this.hideChatBubble();
    const text = message.length > 80 ? message.substring(0, 77) + '...' : message;
    const el = document.createElement('div');
    el.className = 'chat-bubble-overlay';
    el.textContent = text;
    el.style.cssText = `
      position: fixed; pointer-events: none; z-index: 200;
      background: rgba(0, 0, 0, 0.8); color: #fff;
      font-family: Arial, Helvetica, sans-serif; font-size: 13px;
      padding: 4px 10px; border-radius: 6px;
      border: 1px solid #5a4a35; white-space: nowrap;
      transform: translate(-50%, -100%);
      text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
    `;
    document.body.appendChild(el);
    this.chatBubbleEl = el;
    this.chatBubbleTimer = setTimeout(() => this.hideChatBubble(), duration);
  }

  hideChatBubble(): void {
    if (this.chatBubbleTimer) {
      clearTimeout(this.chatBubbleTimer);
      this.chatBubbleTimer = null;
    }
    if (this.chatBubbleEl) {
      this.chatBubbleEl.remove();
      this.chatBubbleEl = null;
    }
  }

  getChatBubbleWorldPos(out?: Vector3): Vector3 | null {
    if (!this.chatBubbleEl) return null;
    const v = out ?? new Vector3();
    v.set(this._position.x, this._position.y + this.yOffset * 2 + 0.6, this._position.z);
    return v;
  }

  updateChatBubbleScreenPos(screenX: number, screenY: number): void {
    if (this.chatBubbleEl) {
      this.chatBubbleEl.style.left = `${screenX}px`;
      this.chatBubbleEl.style.top = `${screenY}px`;
    }
  }

  hasChatBubble(): boolean {
    return this.chatBubbleEl !== null;
  }

  /** Set or update the persistent name label rendered above the head. Pass
   *  empty string to clear. */
  setLabel(text: string): void {
    this.labelText = text;
    if (!text) {
      if (this.labelEl) {
        this.labelEl.remove();
        this.labelEl = null;
      }
      return;
    }
    if (!this.labelEl) {
      const el = document.createElement('div');
      el.className = 'character-name-overlay';
      el.style.cssText = `
        position: fixed; pointer-events: none; z-index: 150;
        font-family: Arial, Helvetica, sans-serif; font-size: 12px;
        color: ${this.labelColor};
        white-space: nowrap;
        transform: translate(-50%, -100%);
        text-shadow: 1px 1px 2px rgba(0,0,0,0.85);
        opacity: 0;
      `;
      document.body.appendChild(el);
      this.labelEl = el;
    } else {
      this.labelEl.style.color = this.labelColor;
    }
    this.labelEl.textContent = text;
  }

  /** World-space anchor for the name label — sits above the chat bubble's slot
   *  so they don't overlap when both are visible. */
  getLabelWorldPos(out?: Vector3): Vector3 | null {
    if (!this.labelEl) return null;
    const v = out ?? new Vector3();
    v.set(this._position.x, this._position.y + this.yOffset * 2 + 0.95, this._position.z);
    return v;
  }

  updateLabelScreenPos(screenX: number, screenY: number, opacity: number = 1): void {
    if (this.labelEl) {
      this.labelEl.style.left = `${screenX}px`;
      this.labelEl.style.top = `${screenY}px`;
      this.labelEl.style.opacity = opacity.toString();
    }
  }

  // ---------------------------------------------------------------------------
  // Picking / mesh access
  // ---------------------------------------------------------------------------

  /** Get all renderable meshes (for raycasting / picking). */
  getMeshes(): AbstractMesh[] {
    return this.meshes;
  }

  /** Get the root transform node. */
  getRoot(): TransformNode | null {
    return this.root;
  }

  /** Get the skeleton (for advanced bone queries). */
  getSkeleton(): Skeleton | null {
    return this.skeleton;
  }

  /** Y offset applied to root children so model feet sit at y=0. */
  getChildYOffset(): number {
    return this.childYOffset;
  }

  /** The Armature TransformNode — skinned armor meshes are parented here. */
  getArmatureNode(): TransformNode | null {
    return this.armatureNode;
  }

  /** List all bone names in the skeleton (useful for debugging gear attachment). */
  getBoneNames(): string[] {
    if (!this.skeleton) return [];
    return this.skeleton.bones.map(b => b.name);
  }

  getBoneRestRotation(boneName: string): Quaternion | null {
    return this.boneRestRotations.get(boneName) ?? null;
  }

  /** World-space position of a named bone, or null if the skeleton or bone isn't loaded. */
  getBoneWorldPosition(boneName: string): Vector3 | null {
    if (!this.skeleton) return null;
    const bone = this.skeleton.bones.find(b => b.name === boneName);
    const tn = bone?.getTransformNode();
    return tn ? tn.getAbsolutePosition().clone() : null;
  }

  /**
   * World-space origin point for spell effects emitted from the caster's hand(s).
   * Midpoint of both hands (suits two-handed staff poses). Falls back to torso or
   * model position if the hand bones aren't found.
   */
  getCastOrigin(): Vector3 {
    const r = this.getBoneWorldPosition('mixamorig:RightHand');
    const l = this.getBoneWorldPosition('mixamorig:LeftHand');
    if (r && l) return Vector3.Center(r, l);
    if (r) return r;
    if (l) return l;
    return this.getTargetAnchor();
  }

  /**
   * World-space point on this character that incoming projectiles should aim at.
   * Chest-height (mixamorig:Spine2). Falls back to model midpoint.
   */
  getTargetAnchor(): Vector3 {
    const p = this.getBoneWorldPosition('mixamorig:Spine2');
    if (p) return p;
    return new Vector3(this._position.x, this._position.y + this.yOffset, this._position.z);
  }

  // ---------------------------------------------------------------------------
  // Appearance — recolor clothing/hair materials
  // ---------------------------------------------------------------------------

  /**
   * Apply a PlayerAppearance by recoloring the GLB's materials.
   * Material names are matched case-insensitively, with .001/.002 suffixes stripped.
   */
  applyAppearance(appearance: PlayerAppearance): void {
    this.lastAppearance = appearance;
    // Color-based recoloring (per-material name matching)
    for (const mesh of this.meshes) {
      const mat = mesh.material;
      if (!mat) continue;
      const baseName = mat.name.replace(/_flat$/, '').replace(/\.\d+$/, '');

      for (const [slot, matNames] of Object.entries(APPEARANCE_MATERIAL_MAP)) {
        let colorIdx = appearance[slot as AppearanceColorSlot];
        let palette = getPalette(slot as AppearanceColorSlot);
        if (slot === 'beltColor' && colorIdx === BELT_NO_BELT) {
          colorIdx = appearance.shirtColor;
          palette = SHIRT_COLORS;
        }
        if (colorIdx < 0 || colorIdx >= palette.length) continue;

        for (const target of matNames) {
          if (baseName.toLowerCase() === target.toLowerCase()) {
            const rgb = palette[colorIdx];
            const c = new Color3(
              Math.min(1, rgb[0] * 1.3),
              Math.min(1, rgb[1] * 1.3),
              Math.min(1, rgb[2] * 1.3),
            );
            (mat as StandardMaterial).diffuseColor = c;
            (mat as StandardMaterial).emissiveColor = new Color3(c.r * 0.55, c.g * 0.55, c.b * 0.55);
          }
        }
      }
    }

    // Modular mesh show/hide — hair only (0 = bald, 1+ = M_hair_1 … M_hair_N).
    // If a head gear (bone-attached or skinned) is equipped, suppress hair so it
    // doesn't poke through the helmet on refresh / appearance update.
    const headItemId = this.getGearItemId('head');
    const headGearEquipped = headItemId !== -1;
    const suppressHair = headGearEquipped && !HAIR_VISIBLE_HEAD_ITEMS.has(headItemId);
    if (this.modularMeshes.size > 0) {
      for (let i = 1; i <= HAIR_STYLE_COUNT; i++) {
        this.modularMeshes.get(`M_hair_${i}`)?.setEnabled(
          !suppressHair && appearance.hairStyle === i,
        );
      }
    }

    // Hair show/hide may have re-enabled meshes; re-propagate layerMask so
    // any newly-enabled hair stays scoped to the right camera.
    this.applyLayerMask();
  }

  // ---------------------------------------------------------------------------
  /**
   * Walk all descendant meshes and apply this.layerMask if set. Idempotent —
   * safe to call after gear attach, hair switch, or any operation that adds
   * new meshes to the rig. No-op if layerMask is undefined.
   */
  private applyLayerMask(): void {
    if (this.layerMask === undefined || !this.root) return;
    const mask = this.layerMask;
    for (const mesh of this.root.getChildMeshes(false)) {
      // Proxy keeps layerMask=0 so no camera renders it (picker still hits).
      if (mesh === this.pickProxy) continue;
      mesh.layerMask = mask;
    }
  }

  // ---------------------------------------------------------------------------
  // Cleanup
  // ---------------------------------------------------------------------------

  dispose(): void {
    this.hideChatBubble();
    this.hideHealthBar();
    this.setLabel('');
    this.detachAllGear();

    // Stop all animations
    for (const [, group] of this.animGroups) {
      group.stop();
      group.dispose();
    }
    this.animGroups.clear();

    // Dispose meshes
    for (const mesh of this.meshes) {
      mesh.dispose();
    }
    this.meshes = [];
    this.headMeshes = [];
    this.bodyMeshes = [];
    this.bodyMeshIndices.clear();
    this.legMeshes = [];
    this.skinMesh = null;
    this.skinIndicesFull = null;
    this.skinIndicesNoArms = null;
    this.modularMeshes.clear();
    if (this.pickProxy) {
      this.pickProxy.dispose();
      this.pickProxy = null;
    }

    if (this.root) {
      this.root.dispose();
      this.root = null;
    }
    this.skeleton = null;
  }

}

// ---------------------------------------------------------------------------
// Gear template loader (static utility)
// ---------------------------------------------------------------------------

/**
 * Load a gear template from a GLB file.
 * The template is disabled and ready to be cloned + attached to bones.
 */
export async function loadGearTemplate(
  scene: Scene,
  def: GearDef,
): Promise<GearTemplate | null> {
  try {
    const lastSlash = def.file.lastIndexOf('/');
    const dir = def.file.substring(0, lastSlash + 1);
    const file = devCacheBust(def.file.substring(lastSlash + 1));

    const result = await SceneLoader.ImportMeshAsync('', dir, file, scene);

    // Apply nearest-neighbor filtering to gear textures
    for (const mesh of result.meshes) {
      const mat = mesh.material;
      if (mat && 'diffuseTexture' in mat && (mat as any).diffuseTexture) {
        (mat as any).diffuseTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
      }
      if (mat && 'albedoTexture' in mat && (mat as any).albedoTexture) {
        (mat as any).albedoTexture.updateSamplingMode(Texture.NEAREST_SAMPLINGMODE);
      }
    }

    const root = new TransformNode(`gearTemplate_${def.itemId}`, scene);
    for (const mesh of result.meshes) {
      if (!mesh.parent || mesh.parent.name === '__root__') {
        mesh.parent = root;
      }
    }

    // Optional: recolor the tool's metal material (keeps handle untouched).
    // The Axe.glb / Pickaxe.glb split metal vs handle into separate materials
    // named "Material.002" (metal) and "Material.001" (handle).
    if (def.metalColor) {
      const [r, g, b] = def.metalColor;
      const tint = new Color3(r, g, b);
      const recolored = new Set<string>();
      for (const mesh of result.meshes) {
        const mat = mesh.material as any;
        if (!mat || !mat.name) continue;
        if (!mat.name.includes('Material.002')) continue;
        // Clone to avoid mutating a shared template material
        const clonedName = `${mat.name}_tint_${def.itemId}`;
        let cloned: any;
        if (recolored.has(clonedName)) {
          cloned = scene.getMaterialByName(clonedName);
        } else {
          cloned = mat.clone(clonedName);
          if (cloned) {
            if ('albedoColor' in cloned) cloned.albedoColor = tint;
            if ('diffuseColor' in cloned) cloned.diffuseColor = tint;
            recolored.add(clonedName);
          }
        }
        if (cloned) mesh.material = cloned;
      }
    }

    // Normalize position so the attachment point is at origin
    // centerOrigin: keep model centered (bows grip at center)
    // default: shift bottom to Y=0 (swords held by handle end)
    if (!def.centerOrigin) {
      let minY = Infinity;
      for (const mesh of result.meshes) {
        if (mesh.getTotalVertices() === 0) continue;
        mesh.computeWorldMatrix(true);
        const bb = mesh.getBoundingInfo().boundingBox;
        if (bb.minimumWorld.y < minY) minY = bb.minimumWorld.y;
      }
      for (const child of root.getChildren()) {
        (child as TransformNode).position.y -= minY;
      }
    }

    root.setEnabled(false);

    return {
      template: root,
      boneName: def.boneName,
      localPosition: def.localPosition
        ? new Vector3(def.localPosition.x, def.localPosition.y, def.localPosition.z)
        : Vector3.Zero(),
      localRotation: def.localRotation
        ? new Vector3(def.localRotation.x, def.localRotation.y, def.localRotation.z)
        : Vector3.Zero(),
      scale: def.scale ?? 1,
    };
  } catch (e) {
    console.warn(`[GearTemplate] Failed to load '${def.file}':`, e);
    return null;
  }
}
