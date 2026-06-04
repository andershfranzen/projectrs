import { Scene } from '@babylonjs/core/scene';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Material } from '@babylonjs/core/Materials/material';
import { DynamicTexture } from '@babylonjs/core/Materials/Textures/dynamicTexture';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Color3 } from '@babylonjs/core/Maths/math.color';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';

const SHADOW_TEXTURE_SIZE = 128;
const SHADOW_Y_OFFSET = 0.018;
const shadowMaterialCache = new WeakMap<Scene, StandardMaterial>();

function clampPositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function shadowMaterial(scene: Scene): StandardMaterial {
  const cached = shadowMaterialCache.get(scene);
  if (cached) return cached;

  const texture = new DynamicTexture('mob_ground_shadow_texture', SHADOW_TEXTURE_SIZE, scene, false, Texture.BILINEAR_SAMPLINGMODE);
  const ctx = texture.getContext() as CanvasRenderingContext2D;
  const c = SHADOW_TEXTURE_SIZE / 2;
  ctx.clearRect(0, 0, SHADOW_TEXTURE_SIZE, SHADOW_TEXTURE_SIZE);
  const gradient = ctx.createRadialGradient(c, c, 0, c, c, c);
  gradient.addColorStop(0, 'rgba(0,0,0,0.40)');
  gradient.addColorStop(0.45, 'rgba(0,0,0,0.28)');
  gradient.addColorStop(0.74, 'rgba(0,0,0,0.10)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, SHADOW_TEXTURE_SIZE, SHADOW_TEXTURE_SIZE);
  texture.hasAlpha = true;
  texture.update();

  const mat = new StandardMaterial('mob_ground_shadow_material', scene);
  mat.diffuseTexture = texture;
  mat.opacityTexture = texture;
  mat.useAlphaFromDiffuseTexture = true;
  mat.diffuseColor = Color3.White();
  mat.specularColor = Color3.Black();
  mat.disableLighting = true;
  mat.backFaceCulling = false;
  mat.transparencyMode = Material.MATERIAL_ALPHABLEND;
  shadowMaterialCache.set(scene, mat);
  return mat;
}

export function createMobGroundShadow(
  scene: Scene,
  name: string,
  parent: TransformNode,
  width: number,
  depth: number,
  parentUniformScale: number,
  parentToGroundY: number,
): Mesh {
  const parentScale = clampPositive(parentUniformScale, 1);
  const shadow = MeshBuilder.CreatePlane(name, { size: 1 }, scene);
  shadow.parent = parent;
  shadow.rotation.x = Math.PI / 2;
  shadow.position.y = (parentToGroundY + SHADOW_Y_OFFSET) / parentScale;
  shadow.scaling.set(
    clampPositive(width, 0.65) / parentScale,
    clampPositive(depth, 0.5) / parentScale,
    1,
  );
  shadow.isPickable = false;
  shadow.alwaysSelectAsActiveMesh = true;
  shadow.material = shadowMaterial(scene);
  return shadow;
}
