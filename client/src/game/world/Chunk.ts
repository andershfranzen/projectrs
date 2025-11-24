import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Mesh,
  Texture,
  Animation,
  SineEase,
  TransformNode
} from '@babylonjs/core';
import { TileType } from './TileType';
import { Tree } from '../entities/Tree';

export class Chunk {
  private scene: Scene;
  private position: Vector3;
  private size: number;
  private tiles: TileType[][];
  private meshes: Mesh[] = [];
  private trees: Tree[] = [];
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
          case TileType.LAKE:
            this.createLakeTile(worldX, worldZ);
            break;
          case TileType.RIVER:
            this.createRiverTile(worldX, worldZ);
            break;
          case TileType.SAND:
            this.createSandTile(worldX, worldZ);
            break;
          case TileType.MOUNTAIN:
            this.createMountainTile(worldX, worldZ);
            break;
          case TileType.ROCK:
            this.createRockTile(worldX, worldZ);
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
    // Add base ground first
    const ground = MeshBuilder.CreateGround(
      `mountain_ground_${x}_${z}`,
      { width: 1, height: 1 },
      this.scene
    );
    ground.position = new Vector3(x + 0.5, 0, z + 0.5);
    
    const groundMaterial = new StandardMaterial(`mountain_ground_mat_${x}_${z}`, this.scene);
    groundMaterial.diffuseColor = new Color3(0.4, 0.4, 0.35);
    ground.material = groundMaterial;
    this.addMesh(ground);

    // Create varied mountain heights
    const heightVariation = ((x * 7 + z * 11) % 5) * 0.3;
    const mountainHeight = 1.8 + heightVariation;
    
    // Main mountain block
    const mountain = MeshBuilder.CreateBox(
      `mountain_${x}_${z}`,
      { height: mountainHeight, width: 1, depth: 1 },
      this.scene
    );
    mountain.position = new Vector3(x + 0.5, mountainHeight / 2, z + 0.5);
    
    // Add some variation with smaller rocks on top
    const rockChance = (x * 13 + z * 17) % 100;
    if (rockChance < 40) {
      const rockHeight = 0.2 + ((x + z) % 3) * 0.1;
      const rock = MeshBuilder.CreateBox(
        `mountain_rock_${x}_${z}`,
        { 
          width: 0.4 + (rockChance % 3) * 0.1,
          height: rockHeight,
          depth: 0.4 + (rockChance % 2) * 0.1
        },
        this.scene
      );
      const offsetX = ((rockChance * 3) % 6 - 3) * 0.15;
      const offsetZ = ((rockChance * 5) % 6 - 3) * 0.15;
      rock.position = new Vector3(
        x + 0.5 + offsetX,
        mountainHeight + rockHeight / 2,
        z + 0.5 + offsetZ
      );
      rock.rotation.y = (rockChance * 7) % 360 * Math.PI / 180;
      
      const rockMaterial = new StandardMaterial(`mountain_rock_mat_${x}_${z}`, this.scene);
      rockMaterial.diffuseColor = new Color3(0.45, 0.45, 0.45);
      rock.material = rockMaterial;
      this.addMesh(rock);
    }
    
    const material = new StandardMaterial(`mountain_mat_${x}_${z}`, this.scene);
    // Slight color variation for more natural look
    const grayVariation = 0.45 + ((x + z) % 10) * 0.02;
    material.diffuseColor = new Color3(grayVariation, grayVariation, grayVariation);
    material.specularColor = new Color3(0.2, 0.2, 0.2);
    mountain.material = material;
    
    this.addMesh(mountain);
  }

  private createForestTile(x: number, z: number): void {
    // Darker grass for forest floor
    const forest = MeshBuilder.CreateGround(
      `forest_${x}_${z}`,
      { width: 1, height: 1 },
      this.scene
    );
    forest.position = new Vector3(x + 0.5, 0, z + 0.5);
    
    const material = new StandardMaterial(`forest_mat_${x}_${z}`, this.scene);
    material.diffuseColor = new Color3(0.15, 0.5, 0.15);
    material.specularColor = new Color3(0.05, 0.05, 0.05);
    forest.material = material;
    
    this.addMesh(forest);

    // Place trees randomly (about 30% chance per tile)
    const treeChance = (x * 17 + z * 23) % 100; // Deterministic randomness
    if (treeChance < 30) {
      const treeVariation = (x * 0.1 + z * 0.1) % 1;
      const treePos = new Vector3(
        x + 0.5 + (treeChance % 20 - 10) * 0.02,
        0,
        z + 0.5 + ((treeChance * 7) % 20 - 10) * 0.02
      );
      const tree = new Tree(this.scene, treePos, treeVariation);
      this.trees.push(tree);
    }
  }

  private createGrassTile(x: number, z: number): void {
    const grass = MeshBuilder.CreateGround(
      `grass_${x}_${z}`,
      { width: 1, height: 1 },
      this.scene
    );
    grass.position = new Vector3(x + 0.5, 0, z + 0.5);
    
    // Add slight color variation for more natural look
    const variation = (x * 7 + z * 11) % 20;
    const greenVariation = 0.75 + (variation / 100);
    const material = new StandardMaterial(`grass_mat_${x}_${z}`, this.scene);
    material.diffuseColor = new Color3(0.35, greenVariation, 0.35);
    material.specularColor = new Color3(0.1, 0.1, 0.1);
    grass.material = material;
    
    this.addMesh(grass);

    // Occasionally add small decorative elements (rocks, flowers)
    const decorChance = (x * 13 + z * 19) % 100;
    if (decorChance < 5) {
      this.createSmallRock(x + 0.5, z + 0.5);
    }
  }

  private createSmallRock(x: number, z: number): void {
    const rockSize = 0.15 + ((x * z) % 10) * 0.02;
    const rock = MeshBuilder.CreateSphere(
      `small_rock_${x}_${z}`,
      { diameter: rockSize, segments: 6 },
      this.scene
    );
    rock.position = new Vector3(x, rockSize / 2, z);
    rock.scaling = new Vector3(1, 0.6, 1); // Flatten slightly
    
    const material = new StandardMaterial(`rock_mat_${x}_${z}`, this.scene);
    material.diffuseColor = new Color3(0.4, 0.4, 0.4);
    rock.material = material;
    
    this.addMesh(rock);
  }

  private createRockTile(x: number, z: number): void {
    // Base ground
    const ground = MeshBuilder.CreateGround(
      `rock_ground_${x}_${z}`,
      { width: 1, height: 1 },
      this.scene
    );
    ground.position = new Vector3(x + 0.5, 0, z + 0.5);
    
    const groundMaterial = new StandardMaterial(`rock_ground_mat_${x}_${z}`, this.scene);
    groundMaterial.diffuseColor = new Color3(0.5, 0.5, 0.45);
    ground.material = groundMaterial;
    
    this.addMesh(ground);

    // Add multiple rocks
    const rockCount = 2 + ((x * z) % 3);
    for (let i = 0; i < rockCount; i++) {
      const offsetX = ((i * 7) % 7 - 3) * 0.15;
      const offsetZ = ((i * 11) % 7 - 3) * 0.15;
      const rockHeight = 0.2 + ((x + i) % 5) * 0.05;
      const rock = MeshBuilder.CreateBox(
        `rock_${x}_${z}_${i}`,
        { 
          width: 0.3 + (i % 3) * 0.1,
          height: rockHeight,
          depth: 0.3 + (i % 2) * 0.1
        },
        this.scene
      );
      rock.position = new Vector3(
        x + 0.5 + offsetX,
        rockHeight / 2,
        z + 0.5 + offsetZ
      );
      rock.rotation.y = (i * 23) % 360 * Math.PI / 180;
      
      const material = new StandardMaterial(`rock_mat_${x}_${z}_${i}`, this.scene);
      material.diffuseColor = new Color3(0.5, 0.5, 0.5);
      material.specularColor = new Color3(0.2, 0.2, 0.2);
      rock.material = material;
      
      this.addMesh(rock);
    }
  }

  private createLakeTile(x: number, z: number): void {
    const lake = MeshBuilder.CreateGround(
      `lake_${x}_${z}`,
      { width: 1, height: 1, subdivisions: 6 },
      this.scene
    );
    lake.position = new Vector3(x + 0.5, -0.05, z + 0.5);
    
    const material = new StandardMaterial(`lake_mat_${x}_${z}`, this.scene);
    material.diffuseColor = new Color3(0.15, 0.4, 0.7); // Slightly different from ocean
    material.alpha = 0.85;
    material.specularColor = new Color3(0.3, 0.3, 0.3);
    material.emissiveColor = new Color3(0.05, 0.1, 0.2);
    
    // Add water texture
    const waterTexture = new Texture("https://assets.babylonjs.com/environments/waterbump.png", this.scene);
    material.bumpTexture = waterTexture;
    material.bumpTexture.level = 0.15;
    
    lake.material = material;
    
    // Add flowing water animation (slower than ocean)
    const animation = new Animation(
      "lakeAnimation",
      "position.y",
      40,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CYCLE
    );

    const keyFrames = [
      { frame: 0, value: -0.05 },
      { frame: 20, value: -0.08 },
      { frame: 40, value: -0.05 }
    ];

    animation.setKeys(keyFrames);
    animation.setEasingFunction(new SineEase());
    lake.animations.push(animation);
    this.scene.beginAnimation(lake, 0, 40, true);
    
    this.addMesh(lake);
  }

  private createRiverTile(x: number, z: number): void {
    const river = MeshBuilder.CreateGround(
      `river_${x}_${z}`,
      { width: 1, height: 1, subdivisions: 4 },
      this.scene
    );
    river.position = new Vector3(x + 0.5, -0.03, z + 0.5);
    
    const material = new StandardMaterial(`river_mat_${x}_${z}`, this.scene);
    material.diffuseColor = new Color3(0.2, 0.45, 0.75); // Flowing water color
    material.alpha = 0.9;
    material.specularColor = new Color3(0.4, 0.4, 0.4);
    material.emissiveColor = new Color3(0.1, 0.15, 0.25);
    
    // Add water texture with higher bump for flow effect
    const waterTexture = new Texture("https://assets.babylonjs.com/environments/waterbump.png", this.scene);
    material.bumpTexture = waterTexture;
    material.bumpTexture.level = 0.2;
    
    river.material = material;
    
    // Add flowing water animation (faster than lake) - more turbulent
    const flowAnimation = new Animation(
      "riverFlowAnimation",
      "position.y",
      20,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CYCLE
    );

    const keyFrames = [
      { frame: 0, value: -0.03 },
      { frame: 10, value: -0.06 },
      { frame: 20, value: -0.03 }
    ];

    flowAnimation.setKeys(keyFrames);
    flowAnimation.setEasingFunction(new SineEase());
    river.animations.push(flowAnimation);
    this.scene.beginAnimation(river, 0, 20, true);
    
    this.addMesh(river);
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
    for (const tree of this.trees) {
      tree.dispose();
    }
    this.meshes = [];
    this.trees = [];
  }
} 