import { Scene } from '@babylonjs/core/scene';
import { Material } from '@babylonjs/core/Materials/material';
import { ShaderMaterial } from '@babylonjs/core/Materials/shaderMaterial';
import { Texture } from '@babylonjs/core/Materials/Textures/texture';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import '@babylonjs/core/Shaders/ShadersInclude/instancesDeclaration';
import '@babylonjs/core/Shaders/ShadersInclude/instancesVertex';

export const FISHING_SPOT_EFFECT_BASE_TEXTURE = '/assets/textures/08_mixed_blue.png';
export const FISHING_SPOT_EFFECT_MIST_TEXTURE = '/assets/textures/04_fine_mist.png';
const FISHING_SPOT_EFFECT_CYCLE_SECONDS = 159 / 24;

const FISHING_SPOT_EFFECT_VERTICES: Array<[number, number, number]> = [
  [0.116592, 0.105364, -0.011622],
  [-0.061639, 0.095048, 0.368315],
  [0.158975, 0.129881, 0.412011],
  [0.259755, 0.035487, 0.151219],
  [-0.115548, 0.078399, 0.351683],
  [0.378921, 0.049204, -0.031128],
  [0.082538, 0.176872, -0.166556],
  [-0.380123, 0.078086, 0.148099],
  [0.111381, 0.075412, -0.412011],
  [-0.431068, 0.116774, -0.194243],
  [-0.235514, 0.200368, 0.113747],
  [0.20293, 0.118471, -0.161581],
  [0.089662, 0.079307, -0.377013],
  [0.188958, 0.093226, 0.191202],
  [0.431068, 0.035, 0.128991],
  [0.208811, 0.050653, -0.407629],
];

export const FISHING_SPOT_EFFECT_VISUAL_BOUNDS = Object.freeze({
  minX: -0.431068,
  minY: 0.035,
  minZ: -0.412011,
  maxX: 0.431068,
  maxY: 0.200368,
  maxZ: 0.412011,
});

const FISHING_SPOT_EFFECT_QUADS: Array<{
  vertices: [number, number, number, number];
  normal: [number, number, number];
}> = [
  { vertices: [0, 1, 2, 3], normal: [0.135364, 0.988268, -0.070737] },
  { vertices: [4, 5, 6, 7], normal: [0.088574, 0.971806, 0.218513] },
  { vertices: [8, 9, 10, 11], normal: [0.009014, 0.974182, -0.225585] },
  { vertices: [12, 13, 14, 15], normal: [0.218287, 0.973913, -0.062002] },
];

export type FishingSpotEffectResources = {
  material: ShaderMaterial;
  waterMaterial: ShaderMaterial;
  baseTexture: Texture;
  mistTexture: Texture;
};

export function isFishingSpotEffectAssetId(assetId: string | null | undefined): boolean {
  return String(assetId || '').startsWith('FishingSpotBubbles');
}

export function createFishingSpotEffectResources(
  scene: Scene,
  namePrefix: string = 'fishingSpotEffect',
): FishingSpotEffectResources {
  const baseTexture = new Texture(
    FISHING_SPOT_EFFECT_BASE_TEXTURE,
    scene,
    false,
    true,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  prepareLayerTexture(baseTexture);

  const mistTexture = new Texture(
    FISHING_SPOT_EFFECT_MIST_TEXTURE,
    scene,
    false,
    true,
    Texture.BILINEAR_SAMPLINGMODE,
  );
  prepareLayerTexture(mistTexture);

  const material = new ShaderMaterial(
    `${namePrefix}_material`,
    scene,
    {
      vertexSource: FISHING_SPOT_EFFECT_VERTEX_SHADER,
      fragmentSource: FISHING_SPOT_EFFECT_FRAGMENT_SHADER,
    },
    {
      attributes: ['position', 'uv', 'world0', 'world1', 'world2', 'world3'],
      uniforms: ['world', 'viewProjection', 'timeSeconds'],
      samplers: ['baseTexture', 'mistTexture'],
      needAlphaBlending: true,
      needAlphaTesting: false,
    },
  );
  material.setTexture('baseTexture', baseTexture);
  material.setTexture('mistTexture', mistTexture);
  material.setFloat('timeSeconds', 0);
  material.backFaceCulling = false;
  material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  material.alpha = 1;
  material.disableDepthWrite = true;

  const waterMaterial = new ShaderMaterial(
    `${namePrefix}_waterDarkeningMaterial`,
    scene,
    {
      vertexSource: FISHING_SPOT_WATER_DARKENING_VERTEX_SHADER,
      fragmentSource: FISHING_SPOT_WATER_DARKENING_FRAGMENT_SHADER,
    },
    {
      attributes: ['position', 'uv', 'world0', 'world1', 'world2', 'world3'],
      uniforms: ['world', 'viewProjection', 'timeSeconds'],
      needAlphaBlending: true,
      needAlphaTesting: false,
    },
  );
  waterMaterial.setFloat('timeSeconds', 0);
  waterMaterial.backFaceCulling = false;
  waterMaterial.transparencyMode = Material.MATERIAL_ALPHABLEND;
  waterMaterial.alpha = 1;
  waterMaterial.disableDepthWrite = true;

  return { material, waterMaterial, baseTexture, mistTexture };
}

export function createFishingSpotEffectPlane(
  scene: Scene,
  name: string,
  material: Material,
): Mesh {
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  for (const quad of FISHING_SPOT_EFFECT_QUADS) {
    const index = positions.length / 3;
    for (const vertexIndex of quad.vertices) positions.push(...FISHING_SPOT_EFFECT_VERTICES[vertexIndex]);
    for (let i = 0; i < 4; i++) normals.push(...quad.normal);
    uvs.push(0, 1, 1, 1, 1, 0, 0, 0);
    indices.push(index, index + 2, index + 1, index, index + 3, index + 2);
  }

  vd.positions = positions;
  vd.normals = normals;
  vd.uvs = uvs;
  vd.indices = indices;
  vd.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  // This shader blends softly and does not write depth, so draw it after terrain and water.
  mesh.renderingGroupId = 2;
  mesh.alphaIndex = 1;
  return mesh;
}

export function createFishingSpotWaterDarkeningPlane(
  scene: Scene,
  name: string,
  material: Material,
): Mesh {
  const halfWidth = 5.1;
  const halfDepth = 4.55;
  const y = 0.024;
  const mesh = new Mesh(name, scene);
  const vd = new VertexData();
  vd.positions = [
    -halfWidth, y, -halfDepth,
    halfWidth, y, -halfDepth,
    halfWidth, y, halfDepth,
    -halfWidth, y, halfDepth,
  ];
  vd.normals = [
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
    0, 1, 0,
  ];
  vd.uvs = [
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ];
  vd.indices = [0, 1, 2, 0, 2, 3];
  vd.applyToMesh(mesh);
  mesh.material = material;
  mesh.isPickable = false;
  mesh.renderingGroupId = 2;
  mesh.alphaIndex = 0;
  return mesh;
}

export function updateFishingSpotEffectTexture(resources: FishingSpotEffectResources, timeSeconds: number): void {
  const cycleTime = timeSeconds % FISHING_SPOT_EFFECT_CYCLE_SECONDS;
  resources.material.setFloat('timeSeconds', cycleTime);
  resources.waterMaterial.setFloat('timeSeconds', cycleTime);
}

function prepareLayerTexture(texture: Texture): void {
  texture.hasAlpha = true;
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.anisotropicFilteringLevel = 1;
}

const FISHING_SPOT_EFFECT_VERTEX_SHADER = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 viewProjection;
#include<instancesDeclaration>

varying vec2 vUV;

void main(void) {
  vUV = uv;
  #include<instancesVertex>
  gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
}
`;

const FISHING_SPOT_WATER_DARKENING_VERTEX_SHADER = `
precision highp float;

attribute vec3 position;
attribute vec2 uv;

uniform mat4 viewProjection;
#include<instancesDeclaration>

varying vec2 vUV;

void main(void) {
  vUV = uv;
  #include<instancesVertex>
  gl_Position = viewProjection * finalWorld * vec4(position, 1.0);
}
`;

const FISHING_SPOT_EFFECT_FRAGMENT_SHADER = `
precision highp float;

varying vec2 vUV;

uniform sampler2D baseTexture;
uniform sampler2D mistTexture;
uniform float timeSeconds;

void main(void) {
  float progress = fract(timeSeconds / ${FISHING_SPOT_EFFECT_CYCLE_SECONDS.toFixed(8)});
  vec2 baseUv = vUV * 3.0 + vec2(progress, progress);
  vec2 mistUv = vUV * 2.34 + vec2(-2.0 * progress, progress);

  vec4 base = texture2D(baseTexture, baseUv);
  vec4 mist = texture2D(mistTexture, mistUv);

  float mistStrength = 0.43 + 0.13 * sin(6.28318531 * progress);
  float mistAlpha = mist.a * mistStrength;
  float alpha = 1.0 - ((1.0 - base.a) * (1.0 - mistAlpha));
  if (alpha < 0.02) discard;

  vec3 screened = 1.0 - ((1.0 - base.rgb) * (1.0 - mist.rgb));
  vec3 color = mix(base.rgb, screened, mistAlpha);

  gl_FragColor = vec4(color, alpha);
}
`;

const FISHING_SPOT_WATER_DARKENING_FRAGMENT_SHADER = `
precision highp float;

varying vec2 vUV;

uniform float timeSeconds;

void main(void) {
  vec2 p = (vUV - vec2(0.5)) * 2.0;
  float radius = length(p);
  float softOval = smoothstep(1.0, 0.08, radius);
  float core = smoothstep(0.58, 0.0, radius);
  float pulse = 0.92 + 0.08 * sin(6.28318531 * fract(timeSeconds / 3.7));
  float alpha = (0.20 * softOval + 0.095 * core) * pulse;
  if (alpha < 0.01) discard;

  gl_FragColor = vec4(0.004, 0.018, 0.025, alpha);
}
`;
