import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Mesh,
  TransformNode,
  Animation,
  SineEase,
} from '@babylonjs/core';

export class Tree {
  private scene: Scene;
  private meshes: Mesh[] = [];
  private rootNode?: TransformNode;
  private variation: number;

  constructor(scene: Scene, position: Vector3, variation: number = Math.random()) {
    this.scene = scene;
    this.variation = variation;
    this.createMesh(position);
  }

  private createMesh(position: Vector3): void {
    // Create root transform node for easy animation
    this.rootNode = new TransformNode(`tree_root_${position.x}_${position.z}`, this.scene);
    this.rootNode.position = position;

    // Determine tree type based on variation
    const treeType = Math.floor(this.variation * 3); // 0, 1, or 2

    switch (treeType) {
      case 0:
        this.createOakTree();
        break;
      case 1:
        this.createPineTree();
        break;
      case 2:
        this.createBirchTree();
        break;
      default:
        this.createOakTree();
    }

    // Add gentle sway animation
    this.addSwayAnimation();
  }

  private createOakTree(): void {
    // Trunk - slightly tapered
    const trunkHeight = 1.8 + this.variation * 0.6;
    const trunkBottom = 0.4 + this.variation * 0.1;
    const trunkTop = 0.3 + this.variation * 0.1;
    
    const trunk = MeshBuilder.CreateCylinder(
      'tree_trunk',
      { 
        height: trunkHeight, 
        diameterTop: trunkTop,
        diameterBottom: trunkBottom,
        tessellation: 8
      },
      this.scene
    );
    trunk.position = new Vector3(0, trunkHeight / 2, 0);
    trunk.parent = this.rootNode;

    const trunkMaterial = new StandardMaterial('trunk_material', this.scene);
    trunkMaterial.diffuseColor = new Color3(0.35, 0.2, 0.1);
    trunkMaterial.specularColor = new Color3(0.1, 0.05, 0.02);
    trunk.material = trunkMaterial;

    // Main foliage - large sphere
    const mainLeaves = MeshBuilder.CreateSphere(
      'tree_leaves_main',
      { diameter: 2.2 + this.variation * 0.6, segments: 8 },
      this.scene
    );
    mainLeaves.position = new Vector3(0, trunkHeight + 0.8, 0);
    mainLeaves.parent = this.rootNode;

    const leavesMaterial = new StandardMaterial('leaves_material', this.scene);
    leavesMaterial.diffuseColor = new Color3(0.15, 0.5, 0.15);
    leavesMaterial.specularColor = new Color3(0.1, 0.3, 0.1);
    mainLeaves.material = leavesMaterial;

    // Additional smaller foliage clusters for detail
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2;
      const offset = 0.6 + this.variation * 0.3;
      const cluster = MeshBuilder.CreateSphere(
        `tree_leaves_cluster_${i}`,
        { diameter: 1.2 + this.variation * 0.4, segments: 6 },
        this.scene
      );
      cluster.position = new Vector3(
        Math.cos(angle) * offset,
        trunkHeight + 0.5 + this.variation * 0.4,
        Math.sin(angle) * offset
      );
      cluster.parent = this.rootNode;
      cluster.material = leavesMaterial;
      this.meshes.push(cluster);
    }

    this.meshes.push(trunk, mainLeaves);
  }

  private createPineTree(): void {
    // Taller, thinner trunk
    const trunkHeight = 2.5 + this.variation * 0.8;
    const trunk = MeshBuilder.CreateCylinder(
      'tree_trunk',
      { 
        height: trunkHeight, 
        diameter: 0.25 + this.variation * 0.1,
        tessellation: 8
      },
      this.scene
    );
    trunk.position = new Vector3(0, trunkHeight / 2, 0);
    trunk.parent = this.rootNode;

    const trunkMaterial = new StandardMaterial('trunk_material', this.scene);
    trunkMaterial.diffuseColor = new Color3(0.3, 0.18, 0.1);
    trunk.material = trunkMaterial;

    // Conical foliage layers (3 layers)
    const layers = 3;
    for (let i = 0; i < layers; i++) {
      const layerHeight = trunkHeight + i * 0.8;
      const layerSize = 1.5 - i * 0.3;
      const layer = MeshBuilder.CreateCylinder(
        `tree_pine_layer_${i}`,
        { 
          height: 0.8, 
          diameterTop: layerSize * 0.6,
          diameterBottom: layerSize,
          tessellation: 8
        },
        this.scene
      );
      layer.position = new Vector3(0, layerHeight, 0);
      layer.parent = this.rootNode;

      const pineMaterial = new StandardMaterial(`pine_material_${i}`, this.scene);
      pineMaterial.diffuseColor = new Color3(0.1, 0.4, 0.2);
      layer.material = pineMaterial;
      this.meshes.push(layer);
    }

    this.meshes.push(trunk);
  }

  private createBirchTree(): void {
    // Tall, white trunk
    const trunkHeight = 2.2 + this.variation * 0.7;
    const trunk = MeshBuilder.CreateCylinder(
      'tree_trunk',
      { 
        height: trunkHeight, 
        diameter: 0.3 + this.variation * 0.1,
        tessellation: 8
      },
      this.scene
    );
    trunk.position = new Vector3(0, trunkHeight / 2, 0);
    trunk.parent = this.rootNode;

    const trunkMaterial = new StandardMaterial('trunk_material', this.scene);
    trunkMaterial.diffuseColor = new Color3(0.9, 0.85, 0.8); // White birch
    trunkMaterial.specularColor = new Color3(0.3, 0.3, 0.3);
    trunk.material = trunkMaterial;

    // Smaller, more sparse foliage
    const leaves1 = MeshBuilder.CreateSphere(
      'tree_leaves_1',
      { diameter: 1.8 + this.variation * 0.5, segments: 8 },
      this.scene
    );
    leaves1.position = new Vector3(0, trunkHeight + 0.6, 0);
    leaves1.parent = this.rootNode;

    const leaves2 = MeshBuilder.CreateSphere(
      'tree_leaves_2',
      { diameter: 1.4 + this.variation * 0.4, segments: 8 },
      this.scene
    );
    leaves2.position = new Vector3(0, trunkHeight + 1.2, 0);
    leaves2.parent = this.rootNode;

    const leavesMaterial = new StandardMaterial('leaves_material', this.scene);
    leavesMaterial.diffuseColor = new Color3(0.2, 0.55, 0.2);
    leaves1.material = leavesMaterial;
    leaves2.material = leavesMaterial;

    this.meshes.push(trunk, leaves1, leaves2);
  }

  private addSwayAnimation(): void {
    if (!this.rootNode) return;

    // Gentle sway animation
    const swayAnimation = new Animation(
      "treeSway",
      "rotation.z",
      60,
      Animation.ANIMATIONTYPE_FLOAT,
      Animation.ANIMATIONLOOPMODE_CYCLE
    );

    const swayAmount = 0.05 + this.variation * 0.03; // Slight variation per tree
    const keyFrames = [
      { frame: 0, value: -swayAmount },
      { frame: 30, value: swayAmount },
      { frame: 60, value: -swayAmount }
    ];

    swayAnimation.setKeys(keyFrames);
    swayAnimation.setEasingFunction(new SineEase());
    this.rootNode.animations.push(swayAnimation);
    this.scene.beginAnimation(this.rootNode, 0, 60, true);
  }

  public getPosition(): Vector3 {
    return this.rootNode ? this.rootNode.position : Vector3.Zero();
  }

  public dispose(): void {
    for (const mesh of this.meshes) {
      mesh.dispose();
    }
    if (this.rootNode) {
      this.rootNode.dispose();
    }
    this.meshes = [];
  }
} 