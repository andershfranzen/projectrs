import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { Material } from '@babylonjs/core/Materials/material';

/**
 * Procedural per-type ground detail. Injected into the shared terrain
 * StandardMaterial so the flat vertex-colored ground gains a living surface
 * pattern without any texture asset:
 *
 *   family 0 grass/moss  → fine organic speckle
 *   family 1 dirt/path   → soft clumps
 *   family 2 sand/desert → fine grain
 *   family 3 stone/rock  → cheap cracked stone cells
 *
 * The family comes from a per-vertex `groundDetail` float attribute (see
 * ChunkManager.buildGroundMesh + shared groundDetailFamily). Patterns are keyed
 * off WORLD position so they're continuous across chunk boundaries — no seams.
 * Modulation is intentionally subtle (a brightness multiply) to stay low-poly
 * rather than photo-real.
 */
const VERTEX_DEFINITIONS = `
attribute float groundDetail;
varying vec3 vGroundDetailPosW;
varying float vGroundDetailFamily;
`;

const VERTEX_MAIN_END = `
vGroundDetailPosW = (finalWorld * vec4(position, 1.0)).xyz;
vGroundDetailFamily = groundDetail;
`;

const FRAGMENT_DEFINITIONS = `
varying vec3 vGroundDetailPosW;
varying float vGroundDetailFamily;

float gdHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

float gdNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = gdHash(i);
  float b = gdHash(i + vec2(1.0, 0.0));
  float c = gdHash(i + vec2(0.0, 1.0));
  float d = gdHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float gdCellInterior(vec2 p) {
  vec2 cell = floor(p);
  vec2 f = abs(fract(p) - 0.5);
  float edge = min(f.x, f.y);
  float width = 0.035 + gdHash(cell) * 0.035;
  return smoothstep(width, width + 0.045, edge);
}

float gdGrassStrands(vec2 p) {
  vec2 band = vec2(p.x * 8.0 + p.y * 1.7, p.y * 3.2);
  vec2 cell = floor(band);
  float h = gdHash(cell + vec2(19.7, 3.1));
  float keep = step(0.42, h);
  float offset = fract(h * 7.13) * 0.72;
  float line = abs(fract(band.x + offset) - 0.5);
  float blade = 1.0 - smoothstep(0.020, 0.090, line);
  return blade * keep;
}
`;

const FRAGMENT_MAIN_END = `
{
  float fam = floor(vGroundDetailFamily + 0.5);
  if (fam >= 0.0) {
    vec2 wp = vGroundDetailPosW.xz;
    float m = 1.0;
    if (fam < 0.5) {
      // grass: soft body noise plus cheap strand highlights. This carries most
      // of the grass texture so geometry can stay edge-only and sparse.
      float n = gdNoise(wp * 6.0);
      float speck = gdHash(floor(wp * 23.0));
      float strands = gdGrassStrands(wp);
      m = mix(0.88, 1.10, n) + (speck - 0.5) * 0.045 + strands * 0.085;
    } else if (fam < 1.5) {
      // dirt: low-frequency clumps with a little dry grit
      float n = gdNoise(wp * 4.0);
      float grit = gdHash(floor(wp * 12.0));
      m = mix(0.90, 1.09, n) + (grit - 0.5) * 0.04;
    } else if (fam < 2.5) {
      // sand: mostly hash grain, with very light broad variation
      float grain = gdHash(floor(wp * 30.0));
      float n = gdNoise(wp * 5.5);
      m = mix(0.95, 1.06, grain) + (n - 0.5) * 0.035;
    } else {
      // stone: no Voronoi loop; one noise warp, one cell-line pass, one grain hash
      vec2 sp = wp * 3.1 + vec2((gdNoise(wp * 0.75) - 0.5) * 0.35);
      float interior = gdCellInterior(sp);
      float grain = gdHash(floor(wp * 18.0));
      m = mix(0.82, 1.04, interior) + (grain - 0.5) * 0.04;
    }
    gl_FragColor.rgb *= clamp(m, 0.6, 1.3);
  }
}
`;

export class GroundDetailPluginMaterial extends MaterialPluginBase {
  constructor(material: Material) {
    super(material, 'GroundDetail', 200, { GROUND_DETAIL: true });
    this._enable(true);
  }

  getClassName(): string {
    return 'GroundDetailPluginMaterial';
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  prepareDefines(defines: any): void {
    defines.GROUND_DETAIL = true;
  }

  getAttributes(attributes: string[]): void {
    attributes.push('groundDetail');
  }

  getCustomCode(shaderType: string): { [point: string]: string } | null {
    if (shaderType === 'vertex') {
      return {
        CUSTOM_VERTEX_DEFINITIONS: VERTEX_DEFINITIONS,
        CUSTOM_VERTEX_MAIN_END: VERTEX_MAIN_END,
      };
    }
    if (shaderType === 'fragment') {
      return {
        CUSTOM_FRAGMENT_DEFINITIONS: FRAGMENT_DEFINITIONS,
        CUSTOM_FRAGMENT_MAIN_END: FRAGMENT_MAIN_END,
      };
    }
    return null;
  }
}
