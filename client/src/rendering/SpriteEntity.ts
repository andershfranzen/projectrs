import { Scene } from '@babylonjs/core/scene';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Mesh } from '@babylonjs/core/Meshes/mesh';

/**
 * Directional sprite set — 8-direction materials loaded from 4 sprite images.
 * Directions: S, SE, E, NE (from files), N (fallback to NE), NW/W/SW (mirrored).
 * Call updateDirection() each frame with camera angle to swap material.
 */
export interface DirectionalSpriteSet {
  /** Materials for each of 8 directions: S, SE, E, NE, N, NW, W, SW */
  materials: StandardMaterial[];
  /** Whether each direction is mirrored (flip plane X scale) */
  mirrored: boolean[];
}

/**
 * Animation sprite set — 4 cardinal or 8 directional x N frames.
 * Used for attack/walk animations. West mirrors East for 4-cardinal sets.
 */
export interface AnimationSpriteSet {
  /** materials[dirIndex][frameIndex] — 4 or 8 dirs x N frames */
  materials: StandardMaterial[][];
  /** Number of frames per direction */
  frameCount: number;
  /** Whether the W direction should mirror (flip X scale) — for 4-dir sets */
  mirrorW: boolean;
  /** Mesh scale factors to match idle sprite pixel density (set after loading) */
  meshScaleX: number;
  meshScaleY: number;
  /** Per-direction mirror flags for 8-dir sets (indexed by DIR_S..DIR_SW) */
  mirrored8?: boolean[];
}

/** Direction indices */
const DIR_S = 0, DIR_SE = 1, DIR_E = 2, DIR_NE = 3;
const DIR_N = 4, DIR_NW = 5, DIR_W = 6, DIR_SW = 7;

/** Cardinal indices for animation sprite sets */
const CARD_S = 0, CARD_E = 1, CARD_N = 2, CARD_W = 3;

/**
 * Map 8-direction index to closest cardinal direction index (S/E/N/W).
 * SE→S, NE→E, NW→N, SW→S  (biased toward the facing direction that looks best)
 */
const DIR_TO_CARDINAL: number[] = [
  CARD_S,  // 0: S  → S
  CARD_S,  // 1: SE → S
  CARD_E,  // 2: E  → E
  CARD_E,  // 3: NE → E
  CARD_N,  // 4: N  → N
  CARD_N,  // 5: NW → N
  CARD_W,  // 6: W  → W
  CARD_W,  // 7: SW → W
];

/**
 * Pre-load a directional sprite set from image files.
 * Expects: south.png, south-east.png, east.png, north-east.png in basePath.
 * Optional: north.png (falls back to north-east if missing).
 * W/SW/NW are auto-mirrored from E/SE/NE.
 */
export async function loadDirectionalSprites(scene: Scene, basePath: string, name: string): Promise<DirectionalSpriteSet> {
  const files = ['south.png', 'south-east.png', 'east.png', 'north-east.png', 'north.png'];

  // Also try loading explicit NW, W, SW, N sprites (full 8-direction sets)
  const allFiles = [
    'south.png', 'south-east.png', 'east.png', 'north-east.png',
    'north.png', 'north-west.png', 'west.png', 'south-west.png',
  ];

  // Load all textures, waiting for each to fully load (or fail)
  const textures: (Texture | null)[] = await Promise.all(
    allFiles.map((file) => new Promise<Texture | null>((resolve) => {
      const tex = new Texture(
        `${basePath}/${file}`, scene, true, true, Texture.NEAREST_SAMPLINGMODE,
        () => { tex.hasAlpha = true; resolve(tex); },  // onLoad
        () => { resolve(null); }                         // onError
      );
    }))
  );

  const [texS, texSE, texE, texNE, texN, texNW, texW, texSW] = textures;

  // Fallbacks: use mirrored versions if explicit sprites don't exist
  const texNorth = texN ?? texNE;
  const texNorthWest = texNW ?? texNE;
  const texWest = texW ?? texE;
  const texSouthWest = texSW ?? texSE;

  const makeMat = (label: string, tex: Texture | null): StandardMaterial => {
    const mat = new StandardMaterial(`${name}_${label}`, scene);
    if (tex) {
      mat.diffuseTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
    }
    mat.specularColor = new Color3(0, 0, 0);
    mat.emissiveColor = new Color3(0.3, 0.3, 0.3);
    mat.backFaceCulling = false;
    mat.transparencyMode = 1; // ALPHATEST: discard transparent pixels (no quad outline) and write depth
    return mat;
  };

  const materials = [
    makeMat('S', texS),            // 0: S
    makeMat('SE', texSE),          // 1: SE
    makeMat('E', texE),            // 2: E
    makeMat('NE', texNE),          // 3: NE
    makeMat('N', texNorth),        // 4: N
    makeMat('NW', texNorthWest),   // 5: NW
    makeMat('W', texWest),         // 6: W
    makeMat('SW', texSouthWest),   // 7: SW
  ];

  // Only mirror if using fallback textures (no explicit sprite for that direction)
  const mirrored = [false, false, false, false, false, !texNW, !texW, !texSW];

  for (const m of materials) m.freeze();
  return { materials, mirrored };
}

/**
 * Load animation sprites for 4 cardinal directions x N frames.
 * Expects: basePath/south/frame_000.png .. frame_{N-1}.png, etc for east, north, west.
 * West is loaded explicitly if available; otherwise mirrors east.
 */
export async function loadAnimationSprites(
  scene: Scene, basePath: string, name: string, frameCount: number
): Promise<AnimationSpriteSet> {
  const dirs = ['south', 'east', 'north', 'west'];
  const materials: StandardMaterial[][] = [];
  let mirrorW = false;

  for (let d = 0; d < dirs.length; d++) {
    const dirMats: StandardMaterial[] = [];
    for (let f = 0; f < frameCount; f++) {
      const frameStr = String(f).padStart(3, '0');
      const filePath = `${basePath}/${dirs[d]}/frame_${frameStr}.png`;
      const mat = await new Promise<StandardMaterial>((resolve) => {
        const tex = new Texture(
          filePath, scene, true, true, Texture.NEAREST_SAMPLINGMODE,
          () => { tex.hasAlpha = true; resolve(makeMat()); },
          () => { resolve(makeMat()); } // fallback: material with no texture
        );
        function makeMat(): StandardMaterial {
          const m = new StandardMaterial(`${name}_anim_${dirs[d]}_${f}`, scene);
          if (tex.isReady()) m.diffuseTexture = tex;
          m.useAlphaFromDiffuseTexture = true;
          m.specularColor = new Color3(0, 0, 0);
          m.emissiveColor = new Color3(0.3, 0.3, 0.3);
          m.backFaceCulling = false;
          m.transparencyMode = 1;
          return m;
        }
      });
      dirMats.push(mat);
    }
    materials.push(dirMats);
  }

  // Check if west frames actually loaded (have textures), otherwise mirror east
  if (materials[CARD_W].length > 0 && materials[CARD_W][0].diffuseTexture) {
    mirrorW = false;
  } else {
    // Use east materials for west, and flag mirroring
    materials[CARD_W] = materials[CARD_E];
    mirrorW = true;
  }

  for (const dirMats of materials) for (const m of dirMats) m.freeze();
  return { materials, frameCount, mirrorW, meshScaleX: 1, meshScaleY: 1 };
}

/**
 * Load animation sprites for 8 directions x N frames.
 * Expects: basePath/{south,south-east,east,...}/frame_000.png .. frame_{N-1}.png.
 * Missing directions fall back to mirrored counterparts.
 */
export async function load8DirAnimationSprites(
  scene: Scene, basePath: string, name: string, frameCount: number
): Promise<AnimationSpriteSet> {
  const dirNames = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];
  const materials: StandardMaterial[][] = [];
  const loaded: boolean[] = [];

  for (let d = 0; d < dirNames.length; d++) {
    const dirMats: StandardMaterial[] = [];
    let dirLoaded = false;
    for (let f = 0; f < frameCount; f++) {
      const frameStr = String(f).padStart(3, '0');
      const filePath = `${basePath}/${dirNames[d]}/frame_${frameStr}.png`;
      const mat = await new Promise<StandardMaterial>((resolve) => {
        const tex = new Texture(
          filePath, scene, true, true, Texture.NEAREST_SAMPLINGMODE,
          () => { tex.hasAlpha = true; dirLoaded = true; resolve(makeMat()); },
          () => { resolve(makeMat()); }
        );
        function makeMat(): StandardMaterial {
          const m = new StandardMaterial(`${name}_8anim_${dirNames[d]}_${f}`, scene);
          if (tex.isReady()) m.diffuseTexture = tex;
          m.useAlphaFromDiffuseTexture = true;
          m.specularColor = new Color3(0, 0, 0);
          m.emissiveColor = new Color3(0.3, 0.3, 0.3);
          m.backFaceCulling = false;
          m.transparencyMode = 1;
          return m;
        }
      });
      dirMats.push(mat);
    }
    materials.push(dirMats);
    loaded.push(dirLoaded);
  }

  // Fallback mirroring: NW←NE, W←E, SW←SE (if those dirs didn't load)
  const mirrored8 = [false, false, false, false, false, false, false, false];
  // DIR_NW=5 mirrors DIR_NE=3, DIR_W=6 mirrors DIR_E=2, DIR_SW=7 mirrors DIR_SE=1
  if (!loaded[DIR_NW]) { materials[DIR_NW] = materials[DIR_NE]; mirrored8[DIR_NW] = true; }
  if (!loaded[DIR_W])  { materials[DIR_W]  = materials[DIR_E];  mirrored8[DIR_W]  = true; }
  if (!loaded[DIR_SW]) { materials[DIR_SW] = materials[DIR_SE]; mirrored8[DIR_SW] = true; }
  if (!loaded[DIR_N] && loaded[DIR_NE]) { materials[DIR_N] = materials[DIR_NE]; }

  // Freeze all materials — they never change after load, so Babylon can skip uniform rebinds.
  // Use a Set to avoid freezing aliased arrays twice (mirrored dirs share the source array).
  const frozen = new Set<StandardMaterial>();
  for (const dirMats of materials) {
    for (const m of dirMats) {
      if (!frozen.has(m)) { m.freeze(); frozen.add(m); }
    }
  }
  return { materials, frameCount, mirrorW: false, meshScaleX: 1, meshScaleY: 1, mirrored8 };
}

/**
 * Compute which of 8 direction indices to use based on camera-to-entity angle.
 * Returns 0-7 (S, SE, E, NE, N, NW, W, SW).
 */
export function getDirectionIndex(cameraPos: Vector3, entityPos: Vector3): number {
  // Angle from entity to camera (so we show the side facing the camera)
  const dx = cameraPos.x - entityPos.x;
  const dz = cameraPos.z - entityPos.z;
  let angle = Math.atan2(dx, dz); // 0 = camera south of entity (looking at front)
  if (angle < 0) angle += Math.PI * 2;

  // Quantize to 8 directions (each 45°, offset by 22.5°)
  const idx = Math.round(angle / (Math.PI / 4)) % 8;
  // Map: 0=S, 1=SW, 2=W, 3=NW, 4=N, 5=NE, 6=E, 7=SE
  // We want: 0=S, 1=SE, 2=E, 3=NE, 4=N, 5=NW, 6=W, 7=SW
  const remap = [DIR_S, DIR_SW, DIR_W, DIR_NW, DIR_N, DIR_NE, DIR_E, DIR_SE];
  return remap[idx];
}

/**
 * Compute which of 8 direction indices to use based on movement direction
 * AND camera position. Projects movement into screen space so the sprite
 * visually faces the on-screen movement direction.
 *
 * Screen space: right = +screenX, down (toward camera) = +screenY.
 * Sprite convention: DIR_S = front (walking toward camera / down on screen),
 * DIR_E = right-facing, DIR_N = back (away from camera), DIR_W = left-facing.
 */
export function getMovementDirectionIndex(moveDx: number, moveDz: number, cameraPos: Vector3, entityPos: Vector3): number {
  // Camera horizontal angle (entity → camera direction in XZ plane)
  const camDx = cameraPos.x - entityPos.x;
  const camDz = cameraPos.z - entityPos.z;
  const camAngle = Math.atan2(camDx, camDz);

  // Project world movement into screen-space axes:
  // screenRight = perpendicular to camera direction (90° CW in XZ plane)
  // screenDown = toward camera direction
  const cosA = Math.cos(camAngle);
  const sinA = Math.sin(camAngle);
  // "Toward camera" axis = (sinA, cosA) in world XZ
  // "Screen right" axis = 90° CW from toward-camera = (cosA, -sinA) in world XZ
  const screenRight = moveDx * cosA - moveDz * sinA;
  const screenDown  = moveDx * sinA + moveDz * cosA;

  // atan2(-screenRight, screenDown): 0 = toward camera = front
  // Negate screenRight to compensate for billboard Y-rotation flipping the texture horizontally
  let angle = Math.atan2(-screenRight, screenDown);
  if (angle < 0) angle += Math.PI * 2;

  const idx = Math.round(angle / (Math.PI / 4)) % 8;
  // Direct mapping: 0=front(S), 1=front-right(SE), 2=right(E), ...
  const remap = [DIR_S, DIR_SE, DIR_E, DIR_NE, DIR_N, DIR_NW, DIR_W, DIR_SW];
  return remap[idx];
}

export interface SpriteEntityOptions {
  name: string;
  color: Color3;
  width?: number;
  height?: number;
  label?: string;
  labelColor?: string;
  /** If provided, uses directional sprites instead of colored rectangle */
  directionalSprites?: DirectionalSpriteSet;
  /** If provided, uses this image as the sprite texture (for ground items) */
  iconUrl?: string;
}

/**
 * A billboard sprite entity — a 2D plane that always faces the camera.
 * Used for players, NPCs, items on the ground.
 * For MVP, we draw colored rectangles with text labels.
 * Later these will be replaced with actual sprite textures.
 */
export class SpriteEntity {
  private plane: Mesh;
  private scene: Scene;
  private label: string;
  private _position: Vector3 = Vector3.Zero();
  private yOffset: number; // half-height, so feet sit on ground
  private baseScaleX: number = 1; // original X scale (for mirroring)
  /** Material + texture owned by this sprite (only for iconUrl / fallback rect paths — pooled sprite sets are NOT owned). */
  private ownedMaterial: StandardMaterial | null = null;
  private ownedTexture: DynamicTexture | null = null;

  // Directional sprites
  private dirSprites: DirectionalSpriteSet | null = null;
  private currentDirIndex: number = -1;

  // Attack animations (named map + default)
  private defaultAttackAnim: AnimationSpriteSet | null = null;
  private attackAnims: Map<string, AnimationSpriteSet> = new Map();
  private activeAttackAnim: AnimationSpriteSet | null = null;
  private attackPlaying: boolean = false;
  private attackDirIndex: number = 0;
  private attackFrameIndex: number = 0;
  private attackFrameTimer: number = 0;
  private attackFrameDuration: number = 0.125; // 125ms per frame

  // Walk animation (8-directional looping)
  private walkAnim: AnimationSpriteSet | null = null;
  private walkPlaying: boolean = false;
  private walkFrameIndex: number = 0;
  private walkFrameTimer: number = 0;
  private walkFrameDuration: number = 0.15; // 150ms per frame

  // Health bar (HTML overlay)
  private healthBarEl: HTMLDivElement | null = null;
  private healthBarFillEl: HTMLDivElement | null = null;
  private healthBarTextEl: HTMLDivElement | null = null;
  private maxHealth: number = 10;
  private currentHealth: number = 10;
  private healthBarVisible: boolean = false;

  // Chat bubble (HTML overlay — managed externally, we just store the element)
  private chatBubbleEl: HTMLDivElement | null = null;
  private chatBubbleTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(scene: Scene, options: SpriteEntityOptions) {
    this.scene = scene;
    // Empty string = explicitly no label (used by ground items). The previous
    // `options.label || options.name` fallback baked the entity's internal
    // name (e.g. `gitem_42`) into the texture for any caller that omitted a
    // label, which is almost never what you want.
    this.label = options.label ?? '';

    const width = options.width || 0.8;
    const height = options.height || 1.4;
    this.yOffset = height / 2;
    this.baseScaleX = 1;

    // Create billboard plane
    this.plane = MeshBuilder.CreatePlane(
      options.name,
      { width, height },
      scene
    );
    this.plane.billboardMode = Mesh.BILLBOARDMODE_Y;

    if (options.directionalSprites) {
      // Use pre-loaded directional sprite materials
      this.dirSprites = options.directionalSprites;
      this.plane.material = this.dirSprites.materials[DIR_S]; // default: south
      this.currentDirIndex = DIR_S;
    } else if (options.iconUrl) {
      // Ground item icon — load PNG texture with label underneath
      const texSize = 128;
      const texture = new DynamicTexture(`${options.name}_tex`, texSize, scene, false);
      const ctx = texture.getContext();
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        // Draw icon centered, scaled to fit
        const iconSize = 80;
        const offsetX = (texSize - iconSize) / 2;
        ctx.clearRect(0, 0, texSize, texSize);
        (ctx as CanvasRenderingContext2D).imageSmoothingEnabled = false;
        // Centered icon — recompute offsetY so the icon fills the texture
        // when there's no label, and stays in the upper area when there is one
        // (so the label has room beneath it).
        const yOff = this.label ? 8 : (texSize - iconSize) / 2;
        ctx.drawImage(img, offsetX, yOff, iconSize, iconSize);
        if (this.label) {
          ctx.fillStyle = options.labelColor || '#ffaa00';
          ctx.font = 'bold 13px sans-serif';
          (ctx as any).textAlign = 'center';
          ctx.fillText(this.label, 64, 104);
        }
        texture.update();
      };
      img.src = options.iconUrl;

      const mat = new StandardMaterial(`${options.name}_mat`, scene);
      mat.diffuseTexture = texture;
      mat.specularColor = new Color3(0, 0, 0);
      mat.emissiveColor = new Color3(0.5, 0.5, 0.5);
      mat.backFaceCulling = false;
      texture.hasAlpha = true;
      mat.useAlphaFromDiffuseTexture = true;
      mat.transparencyMode = 1;

      this.plane.material = mat;
      this.ownedMaterial = mat;
      this.ownedTexture = texture;
    } else {
      // Fallback: colored rectangle with label (original behavior)
      const texSize = 128;
      const texture = new DynamicTexture(`${options.name}_tex`, texSize, scene, false);
      const ctx = texture.getContext();

      ctx.fillStyle = `rgb(${options.color.r * 255}, ${options.color.g * 255}, ${options.color.b * 255})`;
      ctx.fillRect(24, 20, 80, 90);

      ctx.fillStyle = '#eec39a';
      ctx.beginPath();
      ctx.arc(64, 18, 16, 0, Math.PI * 2);
      ctx.fill();

      if (this.label) {
        ctx.fillStyle = options.labelColor || '#ffffff';
        ctx.font = 'bold 14px sans-serif';
        (ctx as any).textAlign = 'center';
        ctx.fillText(this.label, 64, 126);
      }

      texture.update();

      const mat = new StandardMaterial(`${options.name}_mat`, scene);
      mat.diffuseTexture = texture;
      mat.specularColor = new Color3(0, 0, 0);
      mat.emissiveColor = new Color3(0.3, 0.3, 0.3);
      mat.backFaceCulling = false;
      texture.hasAlpha = true;
      mat.useAlphaFromDiffuseTexture = true;
      mat.transparencyMode = 1;

      this.plane.material = mat;
      this.ownedMaterial = mat;
      this.ownedTexture = texture;
    }
  }

  /** Upgrade an existing sprite to use directional sprites (e.g. after async load) */
  setDirectionalSprites(sprites: DirectionalSpriteSet): void {
    this.dirSprites = sprites;
    this.currentDirIndex = DIR_S;
    this.plane.material = sprites.materials[DIR_S];
  }

  /** Attach a default attack animation sprite set (backwards compat for NPCs) */
  setAttackAnimation(anim: AnimationSpriteSet): void {
    this.defaultAttackAnim = anim;
  }

  /** Add a named attack animation (e.g. 'punch', 'kick', 'sword') */
  addAttackAnimation(name: string, anim: AnimationSpriteSet): void {
    this.attackAnims.set(name, anim);
  }

  /** Attach a walk animation sprite set (8-directional looping) */
  setWalkAnimation(anim: AnimationSpriteSet): void {
    this.walkAnim = anim;
  }

  /** Start looping the walk animation */
  startWalking(): void {
    if (!this.walkAnim || this.walkPlaying) return;
    this.walkPlaying = true;
    this.walkFrameIndex = 0;
    this.walkFrameTimer = 0;
    if (!this.attackPlaying) {
      this.applyWalkFrame();
    }
  }

  /** Stop the walk animation, restore idle sprite */
  stopWalking(): void {
    if (!this.walkPlaying) return;
    this.walkPlaying = false;
    if (!this.attackPlaying) {
      this.restoreIdleSprite();
    }
  }

  isWalking(): boolean {
    return this.walkPlaying;
  }

  /** Helper: get the direction index into an AnimationSpriteSet's materials array */
  private getAnimDirIndex(anim: AnimationSpriteSet): number {
    const dir = this.currentDirIndex >= 0 ? this.currentDirIndex : DIR_S;
    // 8-dir anim: use direction index directly; 4-dir: map to cardinal
    return anim.materials.length === 8 ? dir : DIR_TO_CARDINAL[dir];
  }

  /** Helper: check if a given direction should be mirrored for this anim */
  private getAnimMirror(anim: AnimationSpriteSet, dirIndex: number): boolean {
    if (anim.materials.length === 8 && anim.mirrored8) {
      return anim.mirrored8[dirIndex];
    }
    return dirIndex === CARD_W && anim.mirrorW;
  }

  /** Apply the current walk frame material */
  private applyWalkFrame(): void {
    if (!this.walkAnim) return;
    const dirIdx = this.getAnimDirIndex(this.walkAnim);
    this.plane.material = this.walkAnim.materials[dirIdx][this.walkFrameIndex];
    const mirror = this.getAnimMirror(this.walkAnim, dirIdx);
    this.plane.scaling.x = (mirror ? -1 : 1) * this.baseScaleX * this.walkAnim.meshScaleX;
    this.plane.scaling.y = this.walkAnim.meshScaleY;
    this.plane.position.y = this._position.y + this.yOffset * this.walkAnim.meshScaleY;
  }

  /** Restore idle directional sprite (no animation playing) */
  private restoreIdleSprite(): void {
    this.plane.scaling.y = 1;
    this.plane.position.y = this._position.y + this.yOffset;
    if (this.dirSprites && this.currentDirIndex >= 0) {
      this.plane.material = this.dirSprites.materials[this.currentDirIndex];
      this.plane.scaling.x = this.dirSprites.mirrored[this.currentDirIndex] ? -this.baseScaleX : this.baseScaleX;
    } else {
      this.plane.scaling.x = this.baseScaleX;
    }
  }

  /** Start playing an attack animation. Name selects from named anims; omit for default. */
  playAttackAnimation(name?: string): void {
    const anim = name ? this.attackAnims.get(name) : (this.defaultAttackAnim ?? this.attackAnims.values().next().value);
    if (!anim) return;
    this.activeAttackAnim = anim;
    this.attackDirIndex = this.getAnimDirIndex(anim);
    this.attackFrameIndex = 0;
    this.attackFrameTimer = 0;
    this.attackPlaying = true;
    // Set first frame
    this.plane.material = anim.materials[this.attackDirIndex][0];
    const mirror = this.getAnimMirror(anim, this.attackDirIndex);
    this.plane.scaling.x = (mirror ? -1 : 1) * this.baseScaleX * anim.meshScaleX;
    this.plane.scaling.y = anim.meshScaleY;
    this.plane.position.y = this._position.y + this.yOffset * anim.meshScaleY;
  }

  /** Advance animation timer. Call every frame with delta time in seconds. */
  updateAnimation(dt: number): void {
    // Attack animation takes priority
    if (this.attackPlaying && this.activeAttackAnim) {
      this.attackFrameTimer += dt;
      if (this.attackFrameTimer >= this.attackFrameDuration) {
        this.attackFrameTimer -= this.attackFrameDuration;
        this.attackFrameIndex++;
        if (this.attackFrameIndex >= this.activeAttackAnim.frameCount) {
          // Attack finished
          this.attackPlaying = false;
          this.activeAttackAnim = null;
          if (this.walkPlaying) {
            this.applyWalkFrame();
          } else {
            this.restoreIdleSprite();
          }
          return;
        }
        this.plane.material = this.activeAttackAnim.materials[this.attackDirIndex][this.attackFrameIndex];
      }
      return;
    }

    // Walk animation loops while walkPlaying
    if (this.walkPlaying && this.walkAnim) {
      this.walkFrameTimer += dt;
      if (this.walkFrameTimer >= this.walkFrameDuration) {
        this.walkFrameTimer -= this.walkFrameDuration;
        this.walkFrameIndex = (this.walkFrameIndex + 1) % this.walkAnim.frameCount;
        this.applyWalkFrame();
      }
    }
  }

  /** Whether an attack animation is currently playing */
  isAnimating(): boolean {
    return this.attackPlaying;
  }

  /**
   * Update directional sprite based on camera position.
   * Call each frame for entities with directional sprites.
   */
  updateDirection(cameraPos: Vector3): void {
    if (!this.dirSprites || this.attackPlaying) return;
    const idx = getDirectionIndex(cameraPos, this._position);
    if (idx === this.currentDirIndex) return;
    this.currentDirIndex = idx;
    if (this.walkPlaying && this.walkAnim) {
      this.applyWalkFrame();
    } else {
      this.plane.material = this.dirSprites.materials[idx];
      this.plane.scaling.x = this.dirSprites.mirrored[idx] ? -this.baseScaleX : this.baseScaleX;
    }
  }

  /**
   * Update directional sprite based on movement direction (dx, dz) and camera position.
   * Only updates if the entity is actually moving (dx/dz non-zero).
   */
  updateMovementDirection(dx: number, dz: number, cameraPos: Vector3): void {
    if (!this.dirSprites || this.attackPlaying) return;
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    const idx = getMovementDirectionIndex(dx, dz, cameraPos, this._position);
    if (idx === this.currentDirIndex) return;
    this.currentDirIndex = idx;
    if (this.walkPlaying && this.walkAnim) {
      this.applyWalkFrame();
    } else {
      this.plane.material = this.dirSprites.materials[idx];
      this.plane.scaling.x = this.dirSprites.mirrored[idx] ? -this.baseScaleX : this.baseScaleX;
    }
  }

  /**
   * Face toward a target position (e.g. combat target).
   * Uses the same screen-space projection as movement direction.
   */
  faceToward(targetPos: Vector3, cameraPos: Vector3): void {
    if (!this.dirSprites || this.attackPlaying) return;
    const dx = targetPos.x - this._position.x;
    const dz = targetPos.z - this._position.z;
    if (Math.abs(dx) < 0.001 && Math.abs(dz) < 0.001) return;
    const idx = getMovementDirectionIndex(dx, dz, cameraPos, this._position);
    if (idx === this.currentDirIndex) return;
    this.currentDirIndex = idx;
    if (this.walkPlaying && this.walkAnim) {
      this.applyWalkFrame();
    } else {
      this.plane.material = this.dirSprites.materials[idx];
      this.plane.scaling.x = this.dirSprites.mirrored[idx] ? -this.baseScaleX : this.baseScaleX;
    }
  }

  get position(): Vector3 {
    return this._position;
  }

  set position(pos: Vector3) {
    this._position = pos;
    this.plane.position.x = pos.x;
    // During animation, mesh is scaled — adjust Y so feet stay grounded
    let yScale = 1;
    if (this.attackPlaying && this.activeAttackAnim) {
      yScale = this.activeAttackAnim.meshScaleY;
    } else if (this.walkPlaying && this.walkAnim) {
      yScale = this.walkAnim.meshScaleY;
    }
    this.plane.position.y = pos.y + this.yOffset * yScale;
    this.plane.position.z = pos.z;
  }

  setPositionXYZ(x: number, y: number, z: number): void {
    this._position.set(x, y, z);
    this.plane.position.x = x;
    let yScale = 1;
    if (this.attackPlaying && this.activeAttackAnim) {
      yScale = this.activeAttackAnim.meshScaleY;
    } else if (this.walkPlaying && this.walkAnim) {
      yScale = this.walkAnim.meshScaleY;
    }
    this.plane.position.y = y + this.yOffset * yScale;
    this.plane.position.z = z;
  }

  showHealthBar(current: number, max: number): void {
    this.currentHealth = current;
    this.maxHealth = max;
    this.healthBarVisible = true;

    if (!this.healthBarEl) {
      // Container
      this.healthBarEl = document.createElement('div');
      this.healthBarEl.className = 'entity-health-bar';
      this.healthBarEl.style.cssText = `
        position: fixed; pointer-events: none; z-index: 150;
        width: 48px; height: 8px;
        background: #400; border: 1px solid #000;
        transform: translate(-50%, -50%);
        border-radius: 1px; overflow: hidden;
      `;

      // Fill bar
      this.healthBarFillEl = document.createElement('div');
      this.healthBarFillEl.style.cssText = `
        height: 100%; transition: width 0.15s, background 0.15s;
      `;
      this.healthBarEl.appendChild(this.healthBarFillEl);

      // HP text
      this.healthBarTextEl = document.createElement('div');
      this.healthBarTextEl.style.cssText = `
        position: absolute; top: -1px; left: 0; right: 0;
        text-align: center; font-family: monospace;
        font-size: 8px; font-weight: bold; color: #fff;
        text-shadow: 1px 1px 0 #000, -1px -1px 0 #000;
        line-height: 10px; pointer-events: none;
      `;
      this.healthBarEl.appendChild(this.healthBarTextEl);

      document.body.appendChild(this.healthBarEl);
    }

    const ratio = Math.max(0, current / max);
    this.healthBarFillEl!.style.width = `${ratio * 100}%`;

    // Color: green → yellow → red
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

  /** Update the health bar screen position */
  updateHealthBarScreenPos(screenX: number, screenY: number): void {
    if (this.healthBarEl) {
      this.healthBarEl.style.left = `${screenX}px`;
      this.healthBarEl.style.top = `${screenY}px`;
    }
  }

  hasHealthBar(): boolean {
    return this.healthBarVisible && this.healthBarEl !== null;
  }

  showChatBubble(message: string, duration: number = 5000): void {
    this.hideChatBubble();

    const text = message.length > 80 ? message.substring(0, 77) + '...' : message;

    const el = document.createElement('div');
    el.className = 'chat-bubble-overlay';
    el.textContent = text;
    el.style.cssText = `
      position: fixed; pointer-events: none; z-index: 200;
      background: rgba(0, 0, 0, 0.8); color: #fff;
      font-family: monospace; font-size: 13px;
      padding: 4px 10px; border-radius: 6px;
      border: 1px solid #5a4a35; white-space: nowrap;
      transform: translate(-50%, -100%);
      text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
    `;
    document.body.appendChild(el);
    this.chatBubbleEl = el;

    this.chatBubbleTimer = setTimeout(() => {
      this.hideChatBubble();
    }, duration);
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

  /** Update the screen position of the chat bubble HTML element */
  updateChatBubbleScreenPos(screenX: number, screenY: number): void {
    if (this.chatBubbleEl) {
      this.chatBubbleEl.style.left = `${screenX}px`;
      this.chatBubbleEl.style.top = `${screenY}px`;
    }
  }

  hasChatBubble(): boolean {
    return this.chatBubbleEl !== null;
  }

  dispose(): void {
    this.hideChatBubble();
    this.hideHealthBar();
    this.plane.dispose();
    if (this.ownedMaterial) {
      this.ownedMaterial.dispose();
      this.ownedMaterial = null;
    }
    if (this.ownedTexture) {
      this.ownedTexture.dispose();
      this.ownedTexture = null;
    }
  }

  getMesh(): Mesh {
    return this.plane;
  }
}
