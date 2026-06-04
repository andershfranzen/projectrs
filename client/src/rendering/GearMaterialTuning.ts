import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Color3 } from '@babylonjs/core/Maths/math.color';

const DEFAULT_FLAT_BRIGHTNESS = 1.3;
const DARK_HUE_LUMA_MAX = 0.24;
const DARK_HUE_CHROMA_MIN = 0.025;
const DARK_HUE_SATURATION = 1.6;
const DARK_HUE_BRIGHTNESS = 1.16;
const FLAT_METAL_EMISSIVE = 0.46;
const FLAT_NON_METAL_EMISSIVE = 0.55;
const AUTHORED_METAL_ROUGHNESS_MAX = 0.95;
const AUTHORED_METAL_MIN = 0.1;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function colorLuminance(color: Color3): number {
  return color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
}

function colorChroma(color: Color3): number {
  return Math.max(color.r, color.g, color.b) - Math.min(color.r, color.g, color.b);
}

function colorTimes(color: Color3, factor: number): Color3 {
  return new Color3(
    clamp01(color.r * factor),
    clamp01(color.g * factor),
    clamp01(color.b * factor),
  );
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function materialHasTexture(mat: unknown): boolean {
  const source = mat as Record<string, unknown> | null;
  return !!source && (!!source.albedoTexture || !!source.diffuseTexture);
}

export function isAuthoredGearMetalMaterial(mat: unknown, hasTexture = materialHasTexture(mat)): boolean {
  if (!mat || hasTexture) return false;
  const source = mat as Record<string, unknown>;
  const roughness = readFiniteNumber(source.roughness);
  const metallic = readFiniteNumber(source.metallic);
  return (roughness !== null && roughness < AUTHORED_METAL_ROUGHNESS_MAX)
    || (metallic !== null && metallic > AUTHORED_METAL_MIN);
}

export function tuneGearDiffuseColor(baseColor: Color3, isMetal: boolean): Color3 {
  if (!isMetal) return colorTimes(baseColor, DEFAULT_FLAT_BRIGHTNESS);

  const luma = colorLuminance(baseColor);
  const chroma = colorChroma(baseColor);
  if (luma >= DARK_HUE_LUMA_MAX || chroma < DARK_HUE_CHROMA_MIN) {
    return colorTimes(baseColor, DEFAULT_FLAT_BRIGHTNESS);
  }

  return new Color3(
    clamp01((luma + (baseColor.r - luma) * DARK_HUE_SATURATION) * DARK_HUE_BRIGHTNESS),
    clamp01((luma + (baseColor.g - luma) * DARK_HUE_SATURATION) * DARK_HUE_BRIGHTNESS),
    clamp01((luma + (baseColor.b - luma) * DARK_HUE_SATURATION) * DARK_HUE_BRIGHTNESS),
  );
}

export function applyFlatGearLighting(mat: StandardMaterial, hasTexture: boolean, isMetal: boolean): void {
  if (isMetal) {
    mat.specularColor = new Color3(0.14, 0.14, 0.13);
    mat.specularPower = 30;
  } else {
    mat.specularColor = Color3.Black();
  }

  if (hasTexture) return;
  const dc = mat.diffuseColor;
  const emissive = isMetal ? FLAT_METAL_EMISSIVE : FLAT_NON_METAL_EMISSIVE;
  mat.emissiveColor = new Color3(dc.r * emissive, dc.g * emissive, dc.b * emissive);
}

