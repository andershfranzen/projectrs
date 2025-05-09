import {
  Scene,
  MeshBuilder,
  StandardMaterial,
  Color3,
  Vector3,
  Mesh,
} from '@babylonjs/core';

export class Tree {
  private scene: Scene;
  private mesh: any;

  constructor(scene: Scene, position: Vector3) {
    this.scene = scene;
    this.createMesh(position);
  }

  private createMesh(position: Vector3): void {
    // Create trunk
    const trunk = MeshBuilder.CreateCylinder(
      'tree_trunk',
      { height: 2, diameter: 0.5 },
      this.scene
    );
    trunk.position = new Vector3(position.x, 1, position.z);

    const trunkMaterial = new StandardMaterial('trunk_material', this.scene);
    trunkMaterial.diffuseColor = new Color3(0.4, 0.2, 0.1);
    trunk.material = trunkMaterial;

    // Create leaves
    const leaves = MeshBuilder.CreateSphere(
      'tree_leaves',
      { diameter: 2 },
      this.scene
    );
    leaves.position = new Vector3(position.x, 3, position.z);

    const leavesMaterial = new StandardMaterial('leaves_material', this.scene);
    leavesMaterial.diffuseColor = new Color3(0.1, 0.4, 0.1);
    leaves.material = leavesMaterial;

    // Group the meshes
    this.mesh = [trunk, leaves];
  }

  public dispose(): void {
    if (this.mesh) {
      this.mesh.forEach((mesh: any) => mesh.dispose());
    }
  }
} 