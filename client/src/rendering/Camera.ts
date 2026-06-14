import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';

const WORLD_CAMERA_MASK = 0x0FFFFFFF;

// 2004Scape/Client camera parameters. Vanilla RS2 uses a 2048-unit circular
// angle system (`pitch & 0x7ff`), perspective projection with focal length
// 512 px (~53° HFOV), pitch range 128-383 (= 22.5°–67.36° below horizontal),
// and a target ~0.39 tiles above ground. See 2004Scape/Client2 src/js/game.ts.
//
// RS2 also couples radius to pitch (`distance = pitch * 3 + 600`, game.ts:1697):
// the low, near-ground pitch is closest and the top-down pitch is furthest.
// At our world scale the original 1.78x range is too aggressive, so we map
// pitch into the small locked 8-13 radius range and keep wheel zoom as an
// offset around that pitch-derived base. When the player explicitly zooms all
// the way out, pitch is only allowed a small inward pull so max zoom-out never
// turns into the near-ground close-up.
//
// Mapping to Babylon's ArcRotateCamera (beta = angle from +Y axis):
//   beta = π/2 − rs_pitch_in_radians
// → RS pitch 128  ⇒ beta ≈ 1.178 rad (most horizontal allowed)
// → RS pitch 383  ⇒ beta ≈ 0.396 rad (most top-down allowed)
const RS_PITCH_MIN = 128;
const RS_PITCH_MAX = 383;
const RS_UNITS_PER_TILE = 128;
const RS_TARGET_Y_OFFSET_UNITS = 50;
const RS_CAMERA_FOLLOW_SNAP_TILES = 500 / RS_UNITS_PER_TILE;
const RS_CAMERA_FOLLOW_CYCLE_SECONDS = 0.02;
const RS_CAMERA_FOLLOW_LERP_PER_CYCLE = 1 / 16;
const LOCKED_FOV = 0.93;  // ~53° HFOV
const LOCKED_BETA_AT_PITCH_MIN = Math.PI / 2 - (RS_PITCH_MIN / 2048) * 2 * Math.PI;
const LOCKED_BETA_AT_PITCH_MAX = Math.PI / 2 - (RS_PITCH_MAX / 2048) * 2 * Math.PI;
const LOCKED_TARGET_Y_OFFSET = RS_TARGET_Y_OFFSET_UNITS / RS_UNITS_PER_TILE;
const LOCKED_DEFAULT_BETA = LOCKED_BETA_AT_PITCH_MIN;
const LOCKED_MIN_RADIUS = 8;
const LOCKED_MAX_RADIUS = 13;
const LOCKED_DEFAULT_RADIUS = 11;
const LOCKED_MAX_ZOOM_OUT_ALLOWED_PULL = 0.75;
const LOCKED_PITCH_RADIUS_LERP = 0.18;
const LOCKED_RADIUS_EPSILON = 0.001;
const NORTH_ALPHA = Math.PI / 2;
const TARGET_ALPHA_LERP = 0.16;
const TARGET_ALPHA_EPSILON = 0.01;

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
  private targetAlpha: number | null = null;
  private locked: boolean = true;
  private lockedRadiusScale: number = 1;
  private lockedZoomOffset: number = 0;
  private lockedZoomedOutIntent: boolean = false;
  private lastLockedAppliedRadius: number = LOCKED_DEFAULT_RADIUS;
  private lastLockedRadiusInitialized: boolean = false;
  private followTargetInitialized: boolean = false;
  private debugZoom: boolean = false;
  private readonly canvas: HTMLCanvasElement;
  private readonly wheelIntentHandler = (event: WheelEvent): void => this.trackWheelZoomIntent(event);

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.targetPosition = new Vector3(32, 0, 32);

    this.camera = new ArcRotateCamera(
      'gameCamera',
      -Math.PI / 4,
      LOCKED_DEFAULT_BETA,
      LOCKED_DEFAULT_RADIUS,
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

    // Panning disabled; wheel zoom precision keeps the small locked-mode zoom
    // range usable without making free-camera zoom too twitchy.
    this.camera.panningSensibility = 0;
    this.camera.wheelPrecision = 30;

    this.camera.attachControl(canvas, true);
    canvas.addEventListener('wheel', this.wheelIntentHandler, { passive: true });

    // Middle-mouse only — left-click stays free for game input
    (this.camera.inputs.attached.pointers as any).buttons = [1];

    // Remove built-in keyboard input — we handle WASD manually
    this.camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');

    // Default to locked (non-admin). ADMIN_FLAGS unlocks for admins.
    this.applyLockState();
  }

  /** Locked = 2004Scape/Client camera: 22.5°–67.3° pitch, small player
   *  zoom range, ~53° FOV, +0.39 tile look-at Y offset. Yaw via middle-mouse. */
  setLockedMode(locked: boolean): void {
    if (this.locked === locked) return;
    this.locked = locked;
    this.followTargetInitialized = false;
    this.applyLockState();
  }

  private applyLockState(): void {
    if (this.locked) {
      const lowerRadius = this.lockedMinRadius();
      const upperRadius = this.lockedMaxRadius();
      this.targetRadius = -1;
      this.camera.lowerBetaLimit = LOCKED_BETA_AT_PITCH_MAX;
      this.camera.upperBetaLimit = LOCKED_BETA_AT_PITCH_MIN;
      this.camera.lowerRadiusLimit = lowerRadius;
      this.camera.upperRadiusLimit = upperRadius;
      this.camera.fov = LOCKED_FOV;
      this.camera.beta = Math.min(
        Math.max(this.camera.beta, LOCKED_BETA_AT_PITCH_MAX),
        LOCKED_BETA_AT_PITCH_MIN,
      );
      this.camera.radius = Math.min(Math.max(this.camera.radius, lowerRadius), upperRadius);
      this.lastLockedRadiusInitialized = false;
      this.syncLockedRadiusToPitch(true, true);
    } else {
      this.camera.lowerBetaLimit = FREE_LOWER_BETA;
      this.camera.upperBetaLimit = FREE_UPPER_BETA;
      this.camera.lowerRadiusLimit = FREE_LOWER_RADIUS;
      this.camera.upperRadiusLimit = FREE_UPPER_RADIUS;
      this.camera.fov = 0.8;  // Babylon default
      this.lastLockedRadiusInitialized = false;
    }
  }

  setLockedRadiusScale(scale: number): void {
    if (!Number.isFinite(scale) || scale <= 0) return;
    if (Math.abs(scale - this.lockedRadiusScale) < 0.001) return;

    const oldLower = this.lockedMinRadius();
    const oldUpper = this.lockedMaxRadius();
    const oldRange = oldUpper - oldLower;
    const zoomRatio = oldRange > 0
      ? Math.min(Math.max((this.camera.radius - oldLower) / oldRange, 0), 1)
      : 1;

    this.lockedRadiusScale = scale;
    if (this.locked) {
      this.targetRadius = -1;
      const nextLower = this.lockedMinRadius();
      const nextUpper = this.lockedMaxRadius();
      this.camera.radius = nextLower + (nextUpper - nextLower) * zoomRatio;
      this.applyLockState();
    }
  }

  private lockedMinRadius(): number {
    return LOCKED_MIN_RADIUS * this.lockedRadiusScale;
  }

  private lockedMaxRadius(): number {
    return LOCKED_MAX_RADIUS * this.lockedRadiusScale;
  }

  private lockedPitchRadiusRatio(): number {
    const range = LOCKED_BETA_AT_PITCH_MIN - LOCKED_BETA_AT_PITCH_MAX;
    if (range <= 0) return 0;
    return Math.min(Math.max((LOCKED_BETA_AT_PITCH_MIN - this.camera.beta) / range, 0), 1);
  }

  private lockedPitchBaseRadius(): number {
    const lower = this.lockedMinRadius();
    const upper = this.lockedMaxRadius();
    return lower + (upper - lower) * this.lockedPitchRadiusRatio();
  }

  private clampedLockedZoomOffset(baseRadius: number, lowerRadius: number, upperRadius: number): number {
    return Math.min(
      Math.max(this.lockedZoomOffset, lowerRadius - baseRadius),
      upperRadius - baseRadius,
    );
  }

  private lockedMaxZoomOutGuardRadius(): number {
    return Math.max(
      this.lockedMinRadius(),
      this.lockedMaxRadius() - LOCKED_MAX_ZOOM_OUT_ALLOWED_PULL * this.lockedRadiusScale,
    );
  }

  private isAtLockedZoomOutLimit(radius: number): boolean {
    return radius >= this.lockedMaxRadius() - 0.05 * this.lockedRadiusScale;
  }

  private syncLockedRadiusToPitch(snap = false, preserveCurrentRadius = false): void {
    if (!this.locked || this.debugZoom) return;

    const lower = this.lockedMinRadius();
    const upper = this.lockedMaxRadius();
    const base = this.lockedPitchBaseRadius();
    this.camera.radius = Math.min(Math.max(this.camera.radius, lower), upper);

    if (!this.lastLockedRadiusInitialized) {
      if (preserveCurrentRadius) this.lockedZoomOffset = this.camera.radius - base;
      this.lastLockedRadiusInitialized = true;
    } else {
      const externalDelta = this.camera.radius - this.lastLockedAppliedRadius;
      if (Math.abs(externalDelta) > LOCKED_RADIUS_EPSILON) {
        this.lockedZoomOffset += externalDelta;
        if (externalDelta < 0 && !this.isAtLockedZoomOutLimit(this.camera.radius)) {
          this.lockedZoomedOutIntent = false;
        } else if (externalDelta > 0 && this.isAtLockedZoomOutLimit(this.camera.radius)) {
          this.lockedZoomedOutIntent = true;
        }
      }
    }

    const clampedOffset = this.clampedLockedZoomOffset(base, lower, upper);
    let desired = Math.min(Math.max(base + clampedOffset, lower), upper);
    if (this.lockedZoomedOutIntent) {
      desired = Math.max(desired, this.lockedMaxZoomOutGuardRadius());
    }
    const next = snap
      ? desired
      : this.camera.radius + (desired - this.camera.radius) * LOCKED_PITCH_RADIUS_LERP;
    this.camera.radius = next;
    this.lastLockedAppliedRadius = next;
  }

  private trackWheelZoomIntent(event: WheelEvent): void {
    if (!this.locked || this.debugZoom || event.deltaY === 0) return;
    if (event.deltaY > 0 && this.isAtLockedZoomOutLimit(this.camera.radius)) {
      this.lockedZoomedOutIntent = true;
    } else if (event.deltaY < 0) {
      this.lockedZoomedOutIntent = false;
    }
  }

  followTarget(position: Vector3, dt: number = 1 / 60, smooth: boolean = true): void {
    // RS2 looks at a point ~0.39 tiles above ground in locked mode.
    const targetY = this.locked ? position.y + LOCKED_TARGET_Y_OFFSET : position.y;
    this.updateFollowAnchor(position, targetY, dt, smooth);
    this.camera.target.copyFrom(this.targetPosition);

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

    if (this.targetAlpha !== null) {
      const diff = GameCamera.wrapAnglePi(this.targetAlpha - this.camera.alpha);
      if (Math.abs(diff) > TARGET_ALPHA_EPSILON) {
        this.camera.alpha += diff * TARGET_ALPHA_LERP;
      } else {
        this.camera.alpha = this.targetAlpha;
        this.targetAlpha = null;
      }
    }

    this.syncLockedRadiusToPitch();
  }

  private updateFollowAnchor(position: Vector3, targetY: number, dt: number, smooth: boolean): void {
    if (!this.locked) {
      this.targetPosition.set(position.x, targetY, position.z);
      this.followTargetInitialized = true;
      return;
    }

    const dx = position.x - this.targetPosition.x;
    const dz = position.z - this.targetPosition.z;
    if (
      !this.followTargetInitialized
      || !smooth
      || Math.abs(dx) > RS_CAMERA_FOLLOW_SNAP_TILES
      || Math.abs(dz) > RS_CAMERA_FOLLOW_SNAP_TILES
    ) {
      this.targetPosition.set(position.x, targetY, position.z);
      this.followTargetInitialized = true;
      return;
    }

    const safeDt = Number.isFinite(dt) ? Math.max(0, dt) : 1 / 60;
    const followT = 1 - Math.pow(
      1 - RS_CAMERA_FOLLOW_LERP_PER_CYCLE,
      safeDt / RS_CAMERA_FOLLOW_CYCLE_SECONDS,
    );
    this.targetPosition.x += dx * followT;
    this.targetPosition.y = targetY;
    this.targetPosition.z += dz * followT;
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
    if (this.locked && !this.debugZoom) {
      const base = this.lockedPitchBaseRadius();
      this.lockedZoomOffset = this.camera.radius - base;
      this.lockedZoomOffset = this.clampedLockedZoomOffset(
        base,
        this.lockedMinRadius(),
        this.lockedMaxRadius(),
      );
      this.lockedZoomedOutIntent = this.isAtLockedZoomOutLimit(this.camera.radius);
      this.lastLockedRadiusInitialized = true;
      this.lastLockedAppliedRadius = this.camera.radius;
    }
  }

  rotate(deltaAlpha: number, deltaBeta: number = 0): void {
    if (deltaAlpha !== 0) this.targetAlpha = null;
    this.camera.alpha += deltaAlpha;
    if (deltaBeta !== 0) {
      const lower = this.camera.lowerBetaLimit ?? FREE_LOWER_BETA;
      const upper = this.camera.upperBetaLimit ?? FREE_UPPER_BETA;
      this.camera.beta = Math.min(Math.max(this.camera.beta + deltaBeta, lower), upper);
      this.targetBeta = -1;
      this.syncLockedRadiusToPitch();
    }
  }

  rotateNorth(): void {
    this.targetAlpha = this.nearestEquivalentAlpha(NORTH_ALPHA);
  }

  private nearestEquivalentAlpha(target: number): number {
    return this.camera.alpha + GameCamera.wrapAnglePi(target - this.camera.alpha);
  }

  private static wrapAnglePi(angle: number): number {
    while (angle > Math.PI) angle -= Math.PI * 2;
    while (angle < -Math.PI) angle += Math.PI * 2;
    return angle;
  }

  enterDebugZoom(): void {
    this.debugZoom = true;
    this.camera.lowerRadiusLimit = 1.5;
    this.camera.upperRadiusLimit = 20;
    this.camera.wheelPrecision = 20;
    this.camera.lowerBetaLimit = 0.1;
    this.camera.upperBetaLimit = Math.PI / 1.8;
  }

  exitDebugZoom(): void {
    this.debugZoom = false;
    this.camera.wheelPrecision = 30;
    if (this.locked) {
      this.targetRadius = -1;
      this.lockedZoomOffset = 0;
      this.lockedZoomedOutIntent = false;
      this.lastLockedRadiusInitialized = false;
    } else {
      this.setTargetRadius(FREE_DEFAULT_RADIUS);
    }
    this.setTargetBeta(LOCKED_DEFAULT_BETA);
    // Re-apply limits per current lock state.
    this.applyLockState();
    if (this.locked) this.syncLockedRadiusToPitch(true);
  }

  getCamera(): ArcRotateCamera {
    return this.camera;
  }

  dispose(): void {
    this.canvas.removeEventListener('wheel', this.wheelIntentHandler);
    this.camera.detachControl();
    this.camera.dispose();
  }
}
