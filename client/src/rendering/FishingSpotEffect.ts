import { Scene } from '@babylonjs/core/scene';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';

export const FISHING_SPOT_EFFECT_TEXTURE = '/assets/textures/17.png';
export const FISHING_SPOT_EFFECT_SIZE = 0.92;
export const FISHING_SPOT_EFFECT_Y_OFFSET = 0.035;

export type FishingSpotEffectResources = {
  material: StandardMaterial;
  texture: Texture;
};

export function isFishingSpotEffectAssetId(assetId: string | null | undefined): boolean {
  return String(assetId || '').startsWith('FishingSpotBubbles');
}

export function createFishingSpotEffectResources(
  scene: Scene,
  namePrefix: string = 'fishingSpotEffect',
): FishingSpotEffectResources {
  const texture = new Texture(
    FISHING_SPOT_EFFECT_TEXTURE,
    scene,
    false,
    true,
    Texture.NEAREST_SAMPLINGMODE,
  );
  texture.hasAlpha = true;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 1;

  const material = new StandardMaterial(`${namePrefix}_material`, scene);
  material.diffuseTexture = texture;
  material.emissiveTexture = texture;
  material.diffuseColor = new Color3(0.82, 1.0, 1.0);
  material.emissiveColor = new Color3(0.32, 0.66, 0.92);
  material.specularColor = new Color3(0, 0, 0);
  material.backFaceCulling = false;
  material.disableLighting = true;
  material.useAlphaFromDiffuseTexture = true;
  material.transparencyMode = Material.MATERIAL_ALPHATEST;
  material.alphaCutOff = 0.08;
  material.alpha = 1;

  return { material, texture };
}

export function createFishingSpotEffectPlane(
  scene: Scene,
  name: string,
  material: StandardMaterial,
): Mesh {
  const half = FISHING_SPOT_EFFECT_SIZE / 2;
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = [
    -half, FISHING_SPOT_EFFECT_Y_OFFSET, -half,
    half, FISHING_SPOT_EFFECT_Y_OFFSET, -half,
    half, FISHING_SPOT_EFFECT_Y_OFFSET, half,
    -half, FISHING_SPOT_EFFECT_Y_OFFSET, half,
  ];
  vd.normals = [
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ];
  vd.uvs = [
    0, 1,
    1, 1,
    1, 0,
    0, 0,
  ];
  vd.indices = [0, 2, 1, 0, 3, 2];
  vd.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.renderingGroupId = 0;
  return mesh;
}

export function updateFishingSpotEffectTexture(texture: Texture, timeSeconds: number): void {
  texture.uOffset = wrap01(timeSeconds * 0.035);
  texture.vOffset = wrap01(-timeSeconds * 0.62);
}

function wrap01(value: number): number {
  return value - Math.floor(value);
}
