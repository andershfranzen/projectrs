import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Mesh,
  Texture,
  TransformNode
} from '@babylonjs/core';

export type PlayerDirection =
  | 'down'
  | 'down_right'
  | 'right'
  | 'up_right'
  | 'up'
  | 'up_left'
  | 'left'
  | 'down_left';

export class Player {
  private scene: Scene;
  private id: string;
  private mesh?: Mesh;
  private position: Vector3;
  private direction: PlayerDirection = 'down';
  private frame: number = 0;
  private frameCount: number = 3;
  private spriteBasePath = '/assets/sprites/player/';
  private spriteMaterial?: StandardMaterial;
  private lastUpdate: number = 0;
  private parent?: TransformNode;

  constructor(scene: Scene, id: string, position: Vector3, parent?: TransformNode) {
    this.scene = scene;
    this.id = id;
    this.position = position;
    this.parent = parent;
    this.createSpriteMesh();
  }

  private createSpriteMesh(): void {
    // Create a thin plane (quad) for the sprite
    this.mesh = MeshBuilder.CreatePlane(
      `player_${this.id}`,
      { width: 1, height: 1.5 },
      this.scene
    );
    // Offset so feet are at ground level
    this.mesh.position = this.position.add(new Vector3(0, 0.75, 0));
    this.mesh.billboardMode = Mesh.BILLBOARDMODE_Y;
    // Do NOT parent to world root node; player should always face camera

    // Create material
    this.spriteMaterial = new StandardMaterial(`player_sprite_mat_${this.id}`, this.scene);
    this.spriteMaterial.diffuseTexture = this.getCurrentTexture();
    this.spriteMaterial.diffuseTexture.hasAlpha = true;
    this.spriteMaterial.emissiveColor = new Color3(1, 1, 1);
    this.spriteMaterial.backFaceCulling = false;
    this.mesh.material = this.spriteMaterial;
  }

  private getCurrentTexture(): Texture {
    // Determine the correct sprite path and mirroring
    let dir = this.direction;
    let mirror = false;
    if (dir === 'left') {
      dir = 'right';
      mirror = true;
    } else if (dir === 'up_left') {
      dir = 'up_right';
      mirror = true;
    } else if (dir === 'down_left') {
      dir = 'down_right';
      mirror = true;
    }
    const path = `${this.spriteBasePath}player_walk_${dir}_${this.frame}.png`;
    const tex = new Texture(path, this.scene);
    tex.hasAlpha = true;
    // Mirror if needed
    if (mirror) tex.uScale = -1;
    return tex;
  }

  public setDirection(direction: PlayerDirection) {
    this.direction = direction;
    this.updateSprite();
  }

  public setFrame(frame: number) {
    this.frame = frame % this.frameCount;
    this.updateSprite();
  }

  private updateSprite() {
    if (this.spriteMaterial) {
      this.spriteMaterial.diffuseTexture = this.getCurrentTexture();
    }
  }

  public getPosition(): Vector3 {
    return this.mesh ? this.mesh.position : this.position;
  }

  public updateAnimation(time: number) {
    // Example: cycle frames every 200ms
    if (time - this.lastUpdate > 200) {
      this.frame = (this.frame + 1) % this.frameCount;
      this.updateSprite();
      this.lastUpdate = time;
    }
  }

  public dispose(): void {
    if (this.mesh) {
      this.mesh.dispose();
    }
  }

  public setPosition(pos: Vector3) {
    const groundPos = new Vector3(pos.x, 0, pos.z);
    if (this.mesh) {
      // Always use y=0 for ground, then add offset
      this.mesh.position = new Vector3(pos.x, 0.75, pos.z);
    }
    this.position = groundPos;
  }
} 