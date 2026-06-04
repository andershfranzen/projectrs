import type { Scene } from '@babylonjs/core/scene';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import type { SkyboxConfig } from '@projectrs/shared';

const WORLD_CAMERA_MASK = 0x0FFFFFFF;
const SKYBOX_DIAMETER = 96;
const SUN_DIAMETER = 7.5;
const SUN_DISTANCE = SKYBOX_DIAMETER * 0.42;
const SUN_ELEVATION = SKYBOX_DIAMETER * 0.20;
const COLOR_EPSILON = 0.006;

export const DEFAULT_SKYBOX_CONFIG: SkyboxConfig = {
  color: [0.40, 0.62, 0.92],
  showSun: true,
};

export const DEFAULT_DUNGEON_SKYBOX_CONFIG: SkyboxConfig = {
  color: [0, 0, 0],
  showSun: false,
};

const DEFAULT_SUN_COLOR = new Color3(1.0, 0.86, 0.36);

function colorFromRgb01(rgb: [number, number, number]): Color3 {
  return new Color3(
    Math.max(0, Math.min(1, rgb[0])),
    Math.max(0, Math.min(1, rgb[1])),
    Math.max(0, Math.min(1, rgb[2])),
  );
}

export class GameSkybox {
  private readonly skyMesh: Mesh;
  private readonly sunMesh: Mesh;
  private readonly skyMaterial: StandardMaterial;
  private readonly sunMaterial: StandardMaterial;
  private readonly currentColor = new Color3(-1, -1, -1);
  private currentShowSun: boolean | null = null;

  constructor(scene: Scene) {
    this.skyMaterial = new StandardMaterial('game_skybox_material', scene);
    this.skyMaterial.diffuseColor = Color3.White();
    this.skyMaterial.emissiveColor = Color3.White();
    this.skyMaterial.specularColor = Color3.Black();
    this.skyMaterial.disableLighting = true;
    this.skyMaterial.disableDepthWrite = true;
    this.skyMaterial.fogEnabled = false;
    this.skyMaterial.backFaceCulling = false;

    this.skyMesh = MeshBuilder.CreateSphere('game_skybox', {
      diameter: SKYBOX_DIAMETER,
      segments: 16,
      sideOrientation: Mesh.BACKSIDE,
    }, scene);
    this.prepareSkyMesh(this.skyMesh);
    this.skyMesh.material = this.skyMaterial;

    this.sunMaterial = new StandardMaterial('game_skybox_sun_material', scene);
    this.sunMaterial.diffuseColor = DEFAULT_SUN_COLOR;
    this.sunMaterial.emissiveColor = DEFAULT_SUN_COLOR;
    this.sunMaterial.specularColor = Color3.Black();
    this.sunMaterial.disableLighting = true;
    this.sunMaterial.disableDepthWrite = true;
    this.sunMaterial.fogEnabled = false;
    this.sunMaterial.backFaceCulling = false;

    this.sunMesh = MeshBuilder.CreateSphere('game_skybox_sun', {
      diameter: SUN_DIAMETER,
      segments: 12,
    }, scene);
    this.prepareSkyMesh(this.sunMesh);
    this.sunMesh.position.set(SUN_DISTANCE, SUN_ELEVATION, 0);
    this.sunMesh.material = this.sunMaterial;
    this.sunMesh.renderingGroupId = 1;

    this.setConfig(DEFAULT_SKYBOX_CONFIG);
  }

  setConfig(config: SkyboxConfig | undefined): void {
    const color = colorFromRgb01(config?.color ?? DEFAULT_SKYBOX_CONFIG.color);
    const showSun = config?.showSun !== false;
    if (
      Math.abs(color.r - this.currentColor.r) < COLOR_EPSILON &&
      Math.abs(color.g - this.currentColor.g) < COLOR_EPSILON &&
      Math.abs(color.b - this.currentColor.b) < COLOR_EPSILON &&
      showSun === this.currentShowSun
    ) {
      return;
    }

    this.currentColor.copyFrom(color);
    this.currentShowSun = showSun;
    this.skyMaterial.diffuseColor.copyFrom(color);
    this.skyMaterial.emissiveColor.copyFrom(color);
    this.sunMesh.setEnabled(showSun);
  }

  dispose(): void {
    this.sunMesh.dispose(false, true);
    this.skyMesh.dispose(false, true);
  }

  private prepareSkyMesh(mesh: Mesh): void {
    mesh.infiniteDistance = true;
    mesh.ignoreCameraMaxZ = true;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.layerMask = WORLD_CAMERA_MASK;
    mesh.applyFog = false;
  }
}
