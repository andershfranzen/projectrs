import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Mesh,
  Texture,
  Color4,
  Animation,
  SineEase,
  TransformNode
} from '@babylonjs/core';
import { TileType } from './TileType';

export class Chunk {
  private scene: Scene;
  private position: Vector3;
  private size: number;
  private tiles: TileType[][];
  private meshes: Mesh[] = [];
  private parent?: TransformNode;

  constructor(scene: Scene, position: Vector3, size: number, tiles: TileType[][], parent?: TransformNode) {
    this.scene = scene;
    this.position = position;
    this.size = size;
    this.tiles = tiles;
    this.parent = parent;
    this.generate();
  }

  private addMesh(mesh: Mesh) {
    if (this.parent) mesh.parent = this.parent;
    this.meshes.push(mesh);
  }

  private generate(): void {
    // Optimization: If all tiles are WATER, render a single large water mesh
    const allWater = this.tiles.every(row => row.every(tile => tile === TileType.WATER));
    if (allWater) {
      this.createLargeWaterMesh();
    } else {
      this.addTerrainFeatures();
    }
  }

  private addTerrainFeatures(): void {
    for (let x = 0; x < this.size; x++) {
      for (let z = 0; z < this.size; z++) {
        const tileType = this.tiles[x][z];
        const worldX = this.position.x + x;
        const worldZ = this.position.z + z;

        switch (tileType) {
          case TileType.WATER:
            this.createWaterTile(worldX, worldZ);
            break;
          case TileType.SAND:
            this.createSandTile(worldX, worldZ);
            break;
          case TileType.MOUNTAIN:
            this.createMountainTile(worldX, worldZ);
            break;
          case TileType.FOREST:
            this.createForestTile(worldX, worldZ);
            break;
          default:
            this.createGrassTile(worldX, worldZ);
        }
      }
    }
  }

  private createWaterTile(x: number, z: number): void {
    const water = MeshBuilder.CreateGround(
      `water_${x}_${z}`,
      { width: 1, height: 1, subdivisions: 4 },
      this.scene
    );
    water.position = new Vector3(x + 0.5, -0.1, z + 0.5);
    
    const material = new StandardMaterial(`water_mat_${x}_${z}`, this.scene);
    material.diffuseColor = new Color3(0.1, 0.3, 0.8);
    material.alpha = 0.8;
    material.specularColor = new Color3(0.2, 0.2, 0.2);
    material.emissiveColor = new Color3(0.1, 0.1, 0.3);
    
    // Add water texture
    const waterTexture = new Texture("https://assets.babylonjs.com/environments/waterbump.png", this.scene);
    material.bumpTexture = waterTexture;
    material.bumpTexture.level = 0.1;
    
    water.material = material;
    
    // Add gentle wave animation
    const animation = new Animation(
      "waterAnimation",
      "position.y",
      30,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CYCLE
    );

    const keyFrames = [];
    keyFrames.push({
      frame: 0,
      value: -0.1
    });
    keyFrames.push({
      frame: 15,
      value: -0.15
    });
    keyFrames.push({
      frame: 30,
      value: -0.1
    });

    animation.setKeys(keyFrames);
    animation.setEasingFunction(new SineEase());
    water.animations.push(animation);
    this.scene.beginAnimation(water, 0, 30, true);
    
    this.addMesh(water);
  }

  private createSandTile(x: number, z: number): void {
    const sand = MeshBuilder.CreateGround(
      `sand_${x}_${z}`,
      { width: 1, height: 1 },
      this.scene
    );
    sand.position = new Vector3(x + 0.5, 0, z + 0.5);
    
    const material = new StandardMaterial(`sand_mat_${x}_${z}`, this.scene);
    material.diffuseColor = new Color3(0.9, 0.8, 0.6);
    material.specularColor = new Color3(0.1, 0.1, 0.1);
    sand.material = material;
    
    this.addMesh(sand);
  }

  private createMountainTile(x: number, z: number): void {
    const mountain = MeshBuilder.CreateBox(
      `mountain_${x}_${z}`,
      { height: 2, width: 1, depth: 1 },
      this.scene
    );
    mountain.position = new Vector3(x + 0.5, 1, z + 0.5);
    
    const material = new StandardMaterial(`mountain_mat_${x}_${z}`, this.scene);
    material.diffuseColor = new Color3(0.5, 0.5, 0.5);
    mountain.material = material;
    
    this.addMesh(mountain);
  }

  private createForestTile(x: number, z: number): void {
    const forest = MeshBuilder.CreateGround(
      `forest_${x}_${z}`,
      { width: 1, height: 1 },
      this.scene
    );
    forest.position = new Vector3(x + 0.5, 0, z + 0.5);
    
    const material = new StandardMaterial(`forest_mat_${x}_${z}`, this.scene);
    material.diffuseColor = new Color3(0.2, 0.6, 0.2);
    material.specularColor = new Color3(0.1, 0.1, 0.1);
    forest.material = material;
    
    this.addMesh(forest);
  }

  private createGrassTile(x: number, z: number): void {
    const grass = MeshBuilder.CreateGround(
      `grass_${x}_${z}`,
      { width: 1, height: 1 },
      this.scene
    );
    grass.position = new Vector3(x + 0.5, 0, z + 0.5);
    
    const material = new StandardMaterial(`grass_mat_${x}_${z}`, this.scene);
    material.diffuseColor = new Color3(0.4, 0.8, 0.4);
    material.specularColor = new Color3(0.1, 0.1, 0.1);
    grass.material = material;
    
    this.addMesh(grass);
  }

  private createLargeWaterMesh(): void {
    const water = MeshBuilder.CreateGround(
      `water_chunk_${this.position.x}_${this.position.z}`,
      { width: this.size, height: this.size, subdivisions: 8 },
      this.scene
    );
    water.position = new Vector3(
      this.position.x + this.size / 2,
      -0.1,
      this.position.z + this.size / 2
    );
    const material = new StandardMaterial(`water_mat_chunk_${this.position.x}_${this.position.z}`, this.scene);
    material.diffuseColor = new Color3(0.1, 0.3, 0.8);
    material.alpha = 0.8;
    material.specularColor = new Color3(0.2, 0.2, 0.2);
    material.emissiveColor = new Color3(0.1, 0.1, 0.3);
    const waterTexture = new Texture("https://assets.babylonjs.com/environments/waterbump.png", this.scene);
    material.bumpTexture = waterTexture;
    material.bumpTexture.level = 0.1;
    water.material = material;
    // Gentle wave animation
    const animation = new Animation(
      "waterAnimation",
      "position.y",
      30,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CYCLE
    );
    const keyFrames = [
      { frame: 0, value: -0.1 },
      { frame: 15, value: -0.15 },
      { frame: 30, value: -0.1 }
    ];
    animation.setKeys(keyFrames);
    animation.setEasingFunction(new SineEase());
    water.animations.push(animation);
    this.scene.beginAnimation(water, 0, 30, true);
    this.addMesh(water);
  }

  public dispose(): void {
    for (const mesh of this.meshes) {
      mesh.dispose();
    }
    this.meshes = [];
  }
} 