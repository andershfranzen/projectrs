import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';

const WORLD_CAMERA_MASK = 0x0FFFFFFF;

// 2004Scape/Client camera parameters. Vanilla RS2 uses a 2048-unit circular
// angle system (`pitch & 0x7ff`), perspective projection with focal length
// 512 px (~53° HFOV), pitch range 128-383 (= 22.5°–67.36° below horizontal),
// and a target ~0.39 tiles above ground. See 2004Scape/Client2 src/js/game.ts.
//
// RS2 also couples radius to pitch (`distance = pitch * 3 + 600`, game.ts:1697)
// but at our world scale the 1.78× range reads as visibly aggressive zoom on
// every pitch tweak — not what the original "felt" like. We keep the pitch
// range + FOV + Y offset but fix the radius.
//
// Mapping to Babylon's ArcRotateCamera (beta = angle from +Y axis):
//   beta = π/2 − rs_pitch_in_radians
// → RS pitch 128  ⇒ beta ≈ 1.178 rad (most horizontal allowed)
// → RS pitch 383  ⇒ beta ≈ 0.396 rad (most top-down allowed)
const RS_PITCH_MIN = 128;
const RS_PITCH_MAX = 383;
const RS_UNITS_PER_TILE = 128;
const RS_TARGET_Y_OFFSET_UNITS = 50;
const LOCKED_FOV = 0.93;  // ~53° HFOV
const LOCKED_BETA_AT_PITCH_MIN = Math.PI / 2 - (RS_PITCH_MIN / 2048) * 2 * Math.PI;
const LOCKED_BETA_AT_PITCH_MAX = Math.PI / 2 - (RS_PITCH_MAX / 2048) * 2 * Math.PI;
const LOCKED_TARGET_Y_OFFSET = RS_TARGET_Y_OFFSET_UNITS / RS_UNITS_PER_TILE;
const LOCKED_DEFAULT_BETA = LOCKED_BETA_AT_PITCH_MIN;
const LOCKED_RADIUS = 10;

// Admin (free-camera) limits.
const FREE_LOWER_BETA = 0.4;
const FREE_UPPER_BETA = Math.PI / 2.2;
const FREE_LOWER_RADIUS = 5;
const FREE_UPPER_RADIUS = 30;
const FREE_DEFAULT_RADIUS = 12;

export class GameCamera {
  private camera: ArcRotateCamera;
  private targetPosition: Vector3;
  private targetRadius: number = -1; // -1 = no active zoom transition
  private targetBeta: number = -1;  // -1 = no active beta transition
  private locked: boolean = true;
  private lockedRadius: number = LOCKED_RADIUS;

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    this.targetPosition = new Vector3(32, 0, 32);

    this.camera = new ArcRotateCamera(
      'gameCamera',
      -Math.PI / 4,
      LOCKED_DEFAULT_BETA,
      LOCKED_RADIUS,
      this.targetPosition.clone(),
      scene
    );
    this.camera.layerMask = WORLD_CAMERA_MASK;

    // Clip planes — keep the near plane low enough that close zooms don't
    // slice off tiny face-detail meshes (eyes/brows/hair) before the body.
    this.camera.minZ = 0.1;
    this.camera.maxZ = 60;

    // Smooth camera
    this.camera.inertia = 0.9;
    this.camera.panningInertia = 0.9;

    // Panning disabled; wheel zoom precision keeps a usable feel in free mode
    // (locked mode ignores wheel via lower===upper radius limits).
    this.camera.panningSensibility = 0;
    this.camera.wheelPrecision = 30;

    this.camera.attachControl(canvas, true);

    // Middle-mouse only — left-click stays free for game input
    (this.camera.inputs.attached.pointers as any).buttons = [1];

    // Remove built-in keyboard input — we handle WASD manually
    this.camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');

    // Default to locked (non-admin). ADMIN_FLAGS unlocks for admins.
    this.applyLockState();
  }

  /** Locked = 2004Scape/Client camera: 22.5°–67.3° pitch, pitch-coupled
   *  radius, ~53° FOV, +0.39 tile look-at Y offset. Yaw via middle-mouse,
   *  zoom is *not* user-controllable directly (changes with pitch). */
  setLockedMode(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.applyLockState();
  }

  private applyLockState(): void {
    if (this.locked) {
      this.camera.lowerBetaLimit = LOCKED_BETA_AT_PITCH_MAX;
      this.camera.upperBetaLimit = LOCKED_BETA_AT_PITCH_MIN;
      this.camera.lowerRadiusLimit = this.lockedRadius;
      this.camera.upperRadiusLimit = this.lockedRadius;
      this.camera.fov = LOCKED_FOV;
      this.camera.beta = Math.min(
        Math.max(this.camera.beta, LOCKED_BETA_AT_PITCH_MAX),
        LOCKED_BETA_AT_PITCH_MIN,
      );
      this.camera.radius = this.lockedRadius;
    } else {
      this.camera.lowerBetaLimit = FREE_LOWER_BETA;
      this.camera.upperBetaLimit = FREE_UPPER_BETA;
      this.camera.lowerRadiusLimit = FREE_LOWER_RADIUS;
      this.camera.upperRadiusLimit = FREE_UPPER_RADIUS;
      this.camera.fov = 0.8;  // Babylon default
    }
  }

  setLockedRadiusScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return;
    const nextRadius = LOCKED_RADIUS * scale;
    if (Math.abs(nextRadius - this.lockedRadius) < 0.01) return;
    this.lockedRadius = nextRadius;
    if (this.locked) {
      this.targetRadius = -1;
      this.applyLockState();
    }
  }

  followTarget(position: Vector3): void {
    // RS2 looks at a point ~0.39 tiles above ground in locked mode.
    const targetY = this.locked ? position.y + LOCKED_TARGET_Y_OFFSET : position.y;
    const speed = 0.2;
    this.camera.target.x += (position.x - this.camera.target.x) * speed;
    this.camera.target.y += (targetY - this.camera.target.y) * speed;
    this.camera.target.z += (position.z - this.camera.target.z) * speed;

    if (this.targetRadius > 0) {
      const diff = this.targetRadius - this.camera.radius;
      if (Math.abs(diff) > 0.1) {
        this.camera.radius += diff * 0.08;
      } else {
        this.camera.radius = this.targetRadius;
        this.targetRadius = -1;
      }
    }

    if (this.targetBeta > 0) {
      const diff = this.targetBeta - this.camera.beta;
      if (Math.abs(diff) > 0.01) {
        this.camera.beta += diff * 0.08;
      } else {
        this.camera.beta = this.targetBeta;
        this.targetBeta = -1;
      }
    }
  }

  setTargetRadius(radius: number): void {
    this.targetRadius = radius;
  }

  setTargetBeta(beta: number): void {
    this.targetBeta = beta;
  }

  zoomByFactor(factor: number): void {
    if (!Number.isFinite(factor) || factor <= 0) return;
    const lower = this.camera.lowerRadiusLimit ?? FREE_LOWER_RADIUS;
    const upper = this.camera.upperRadiusLimit ?? FREE_UPPER_RADIUS;
    this.targetRadius = -1;
    this.camera.radius = Math.min(Math.max(this.camera.radius * factor, lower), upper);
  }

  rotate(deltaAlpha: number, deltaBeta: number = 0): void {
    this.camera.alpha += deltaAlpha;
    if (deltaBeta !== 0) {
      const lower = this.camera.lowerBetaLimit ?? FREE_LOWER_BETA;
      const upper = this.camera.upperBetaLimit ?? FREE_UPPER_BETA;
      this.camera.beta = Math.min(Math.max(this.camera.beta + deltaBeta, lower), upper);
      this.targetBeta = -1;
    }
  }

  enterDebugZoom(): void {
    this.camera.lowerRadiusLimit = 1.5;
    this.camera.upperRadiusLimit = 20;
    this.camera.wheelPrecision = 20;
    this.camera.lowerBetaLimit = 0.1;
    this.camera.upperBetaLimit = Math.PI / 1.8;
  }

  exitDebugZoom(): void {
    this.camera.wheelPrecision = 30;
    this.setTargetRadius(FREE_DEFAULT_RADIUS);
    this.setTargetBeta(LOCKED_DEFAULT_BETA);
    // Re-apply limits per current lock state.
    this.applyLockState();
  }

  getCamera(): ArcRotateCamera {
    return this.camera;
  }
}
