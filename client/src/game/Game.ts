import { Scene, Engine, UniversalCamera, HemisphericLight, Vector3, CubeTexture, Color3, PointerEventTypes, Scalar, TransformNode } from '@babylonjs/core';
import { io, Socket } from 'socket.io-client';
import { World } from './world/World';
import { Player } from './entities/Player';
import type { PlayerDirection } from './entities/Player';
import * as GUI from '@babylonjs/gui';

export class Game {
  private canvas: HTMLCanvasElement;
  private engine: Engine;
  private scene: Scene;
  private camera: UniversalCamera;
  private world: World;
  private localPlayer: Player;
  private socket: Socket;
  private moveTarget: Vector3 | null = null;
  private moveSpeed: number = 4; // tiles per second
  private worldRoot: TransformNode;
  private cameraAngle: number = Math.PI / 4; // 45 degrees
  private targetCameraAngle: number = Math.PI / 4; // Target angle for smooth rotation
  private cameraRadius: number = 15;
  private cameraHeight: number = 10;
  private cameraRotationSpeed: number = 6; // Speed of camera rotation interpolation

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, true);
    this.scene = new Scene(this.engine);
    this.socket = io('http://localhost:3000');

    // Create world root node
    this.worldRoot = new TransformNode('worldRoot', this.scene);

    // Create skybox
    const skybox = this.scene.createDefaultSkybox(
      CubeTexture.CreateFromPrefilteredData(
        "https://assets.babylonjs.com/environments/environmentSpecular.env",
        this.scene
      ),
      true,
      1000,
      0.25
    );

    // Setup fixed isometric camera
    this.camera = new UniversalCamera('camera', new Vector3(0, this.cameraHeight, -this.cameraRadius), this.scene);
    this.camera.setTarget(Vector3.Zero());
    this.camera.attachControl(canvas, true);
    this.camera.inputs.clear(); // We'll handle rotation manually
    this.camera.minZ = 0.1;

    // Add lighting
    const light = new HemisphericLight(
      'light',
      new Vector3(1, 1, 1),
      this.scene
    );
    light.intensity = 0.8;
    light.groundColor = new Color3(0.2, 0.2, 0.3);
    light.specular = new Color3(0.1, 0.1, 0.1);

    // Initialize world (parented to worldRoot)
    this.world = new World(
      this.scene,
      this.socket,
      'local-player',
      16,
      3,
      this.worldRoot // pass root node for parenting
    );

    // Initialize local player (parented to worldRoot)
    this.localPlayer = new Player(
      this.scene,
      'local-player',
      new Vector3(8, 0, 8),
      this.worldRoot // pass root node for parenting
    );

    this.world.initialize();

    // Handle click-to-move
    this.scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type === PointerEventTypes.POINTERPICK) {
        const pick = this.scene.pick(this.scene.pointerX, this.scene.pointerY);
        if (pick && pick.pickedPoint) {
          this.moveTarget = new Vector3(
            Math.floor(pick.pickedPoint.x),
            0,
            Math.floor(pick.pickedPoint.z)
          );
        }
      }
    });

    // Handle left/right arrow keys for camera rotation
    window.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        this.targetCameraAngle -= Math.PI / 32;
      } else if (e.key === 'ArrowRight') {
        this.targetCameraAngle += Math.PI / 32;
      }
      // Do not move the player with arrow keys
    });

    // --- RuneScape Classic-like UI ---
    const advancedTexture = GUI.AdvancedDynamicTexture.CreateFullscreenUI('UI');
    const iconBar = new GUI.StackPanel();
    iconBar.width = '60px';
    iconBar.isVertical = true;
    iconBar.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
    iconBar.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP;
    iconBar.top = '20px';
    iconBar.left = '-20px';
    advancedTexture.addControl(iconBar);

    // Icon info
    const icons = [
      { name: 'Settings', icon: '\u2699' },
      { name: 'Friends', icon: '\u263A' },
      { name: 'Magic', icon: '\u2728' },
      { name: 'Quests', icon: '\u2605' },
      { name: 'Stats', icon: '\u26A1' },
      { name: 'Map', icon: '\u25A3' },
      { name: 'Inventory', icon: '\u25A0' }
    ];
    const panels: GUI.Rectangle[] = [];
    icons.forEach((item, idx) => {
      // Icon button
      const btn = GUI.Button.CreateImageOnlyButton(`icon_${item.name}`, '');
      btn.width = '48px';
      btn.height = '48px';
      btn.thickness = 0;
      btn.background = '#222';
      btn.cornerRadius = 8;
      btn.paddingTop = '4px';
      btn.paddingBottom = '4px';
      btn.pointerEnterAnimation = () => { btn.background = '#444'; };
      btn.pointerOutAnimation = () => { btn.background = '#222'; };

      // Use a TextBlock for the icon (placeholder, can be replaced with images)
      const iconText = new GUI.TextBlock();
      iconText.text = item.icon;
      iconText.fontSize = 32;
      iconText.color = 'white';
      btn.addControl(iconText);

      // Tooltip (Rectangle with TextBlock)
      const tooltipRect = new GUI.Rectangle();
      tooltipRect.width = '120px';
      tooltipRect.height = '32px';
      tooltipRect.cornerRadius = 6;
      tooltipRect.color = '#888';
      tooltipRect.background = '#333';
      tooltipRect.thickness = 1;
      tooltipRect.alpha = 0.9;
      tooltipRect.isVisible = false;
      tooltipRect.zIndex = 1000;
      const tooltipText = new GUI.TextBlock();
      tooltipText.text = item.name;
      tooltipText.color = 'white';
      tooltipText.fontSize = 18;
      tooltipRect.addControl(tooltipText);
      advancedTexture.addControl(tooltipRect);
      btn.onPointerEnterObservable.add(() => {
        tooltipRect.isVisible = true;
        tooltipRect.left = '-130px';
        tooltipRect.top = `${-160 + idx * 56}px`;
        tooltipRect.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
        tooltipRect.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP;
      });
      btn.onPointerOutObservable.add(() => { tooltipRect.isVisible = false; });

      // Fold-out panel
      const panel = new GUI.Rectangle();
      panel.width = '320px';
      panel.height = '400px';
      panel.thickness = 2;
      panel.cornerRadius = 12;
      panel.color = '#888';
      panel.background = '#181818ee';
      panel.left = '-340px';
      panel.top = `${-160 + idx * 56}px`;
      panel.horizontalAlignment = GUI.Control.HORIZONTAL_ALIGNMENT_RIGHT;
      panel.verticalAlignment = GUI.Control.VERTICAL_ALIGNMENT_TOP;
      panel.isVisible = false;
      panel.zIndex = 999;
      const panelText = new GUI.TextBlock();
      panelText.text = `${item.name} Menu`;
      panelText.color = 'white';
      panelText.fontSize = 28;
      panelText.top = '-170px';
      panel.addControl(panelText);
      advancedTexture.addControl(panel);
      panels.push(panel);

      btn.onPointerUpObservable.add(() => {
        // Hide all panels except this one
        panels.forEach((p, i) => { p.isVisible = i === idx ? !p.isVisible : false; });
      });

      iconBar.addControl(btn);
    });
    // --- End UI ---

    // Start game loop
    this.engine.runRenderLoop(() => {
      this.update();
      this.scene.render();
    });

    window.addEventListener('resize', () => {
      this.engine.resize();
    });
  }

  private update(): void {
    // Move player toward target if set
    if (this.moveTarget) {
      const playerPos = this.localPlayer.getPosition();
      const target = this.moveTarget.clone();
      target.y = playerPos.y;
      const toTarget = target.subtract(playerPos);
      const dist = toTarget.length();
      if (dist > 0.05) {
        const dir = toTarget.normalize();
        this.localPlayer.setDirection(this.getDirectionFromVector(dir) as PlayerDirection);
        const step = Math.min(this.moveSpeed * this.engine.getDeltaTime() / 1000, dist);
        this.localPlayer.setPosition(playerPos.add(dir.scale(step)));
        this.localPlayer.updateAnimation(performance.now());
      } else {
        this.moveTarget = null;
        this.localPlayer.setDirection('down');
        this.localPlayer.setFrame(0);
      }
    }

    // Update world based on player position
    this.world.updateWorld(this.localPlayer.getPosition());

    // Smoothly interpolate camera angle
    const deltaTime = this.engine.getDeltaTime() / 1000; // Convert to seconds
    const angleDiff = this.targetCameraAngle - this.cameraAngle;
    
    // Normalize the angle difference to handle wrapping around 2π
    const normalizedDiff = Math.atan2(Math.sin(angleDiff), Math.cos(angleDiff));
    
    // Apply smooth interpolation with immediate response
    const rotationStep = this.cameraRotationSpeed * deltaTime;
    const smoothFactor = Math.min(1, rotationStep);
    this.cameraAngle += normalizedDiff * smoothFactor;

    // Update camera position to orbit around player
    const playerPos = this.localPlayer.getPosition();
    const camX = playerPos.x + Math.sin(this.cameraAngle) * this.cameraRadius;
    const camZ = playerPos.z + Math.cos(this.cameraAngle) * this.cameraRadius;
    this.camera.position.x = camX;
    this.camera.position.z = camZ;
    this.camera.position.y = playerPos.y + this.cameraHeight;
    this.camera.setTarget(playerPos);
  }

  private getDirectionFromVector(vec: Vector3): string {
    const angle = Math.atan2(vec.x, vec.z);
    const deg = Scalar.NormalizeRadians(angle) * 180 / Math.PI;
    if (deg >= -22.5 && deg < 22.5) return 'up';
    if (deg >= 22.5 && deg < 67.5) return 'up_right';
    if (deg >= 67.5 && deg < 112.5) return 'right';
    if (deg >= 112.5 && deg < 157.5) return 'down_right';
    if (deg >= 157.5 || deg < -157.5) return 'down';
    if (deg >= -157.5 && deg < -112.5) return 'down_left';
    if (deg >= -112.5 && deg < -67.5) return 'left';
    if (deg >= -67.5 && deg < -22.5) return 'up_left';
    return 'down';
  }

  public dispose(): void {
    this.world.dispose();
    this.localPlayer.dispose();
    this.engine.dispose();
    this.socket.disconnect();
  }
} 