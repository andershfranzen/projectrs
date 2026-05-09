import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { Scene } from '@babylonjs/core/scene';

export class GameCamera {
  private camera: ArcRotateCamera;
  private targetPosition: Vector3;
  private targetRadius: number = -1; // -1 = no active zoom transition
  private targetBeta: number = -1;  // -1 = no active beta transition

  constructor(scene: Scene, canvas: HTMLCanvasElement) {
    this.targetPosition = new Vector3(32, 0, 32);

    this.camera = new ArcRotateCamera(
      'gameCamera',
      -Math.PI / 4,    // horizontal rotation (45 degrees)
      Math.PI / 3.2,   // vertical angle (~56 degrees — nice isometric feel)
      12,              // fixed zoom distance (outdoor)
      this.targetPosition.clone(),
      scene
    );

    // Clip planes — minZ/maxZ tuned to reduce overdraw (far = fog end)
    this.camera.minZ = 0.5;
    this.camera.maxZ = 60;

    // Constrain camera
    this.camera.lowerBetaLimit = 0.4;
    this.camera.upperBetaLimit = Math.PI / 2.2;
    this.camera.lowerRadiusLimit = 5;
    this.camera.upperRadiusLimit = 30;

    // Smooth camera
    this.camera.inertia = 0.9;
    this.camera.panningInertia = 0.9;

    // Scroll-wheel zoom; panning still disabled
    this.camera.panningSensibility = 0;
    this.camera.wheelPrecision = 30;

    this.camera.attachControl(canvas, true);

    // Use middle mouse button for rotation so left-click is free for game input
    (this.camera.inputs.attached.pointers as any).buttons = [1]; // middle button only

    // Remove built-in keyboard input — we handle WASD manually
    this.camera.inputs.removeByType('ArcRotateCameraKeyboardMoveInput');
  }

  followTarget(position: Vector3): void {
    // Smooth follow — lerp camera target toward player
    const speed = 0.2;
    this.camera.target.x += (position.x - this.camera.target.x) * speed;
    this.camera.target.y += (position.y - this.camera.target.y) * speed;
    this.camera.target.z += (position.z - this.camera.target.z) * speed;

    // Smooth zoom toward target radius (only when actively transitioning)
    if (this.targetRadius > 0) {
      const diff = this.targetRadius - this.camera.radius;
      if (Math.abs(diff) > 0.1) {
        this.camera.radius += diff * 0.08;
      } else {
        this.camera.radius = this.targetRadius;
        this.targetRadius = -1;
      }
    }
    // Smooth beta transition (indoor → more top-down)
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

  enterDebugZoom(): void {
    this.camera.lowerRadiusLimit = 1.5;
    this.camera.upperRadiusLimit = 20;
    this.camera.wheelPrecision = 20;
    this.camera.lowerBetaLimit = 0.1;
    this.camera.upperBetaLimit = Math.PI / 1.8;
  }

  exitDebugZoom(): void {
    this.camera.lowerRadiusLimit = 5;
    this.camera.upperRadiusLimit = 30;
    this.camera.wheelPrecision = 30;
    this.camera.lowerBetaLimit = 0.4;
    this.camera.upperBetaLimit = Math.PI / 2.2;
    this.setTargetRadius(12);
    this.setTargetBeta(Math.PI / 3.2);
  }

  getCamera(): ArcRotateCamera {
    return this.camera;
  }
}
