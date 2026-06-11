import { MaterialPluginBase } from '@babylonjs/core/Materials/materialPluginBase';
import type { Material } from '@babylonjs/core/Materials/material';

/**
 * Procedural per-type ground detail. Injected into the shared terrain
 * StandardMaterial so the flat vertex-colored ground gains a living surface
 * pattern without any texture asset:
 *
 *   family 0 grass/moss  → fine organic speckle + faint blade streak
 *   family 1 dirt/path   → soft clumps
 *   family 2 sand/desert → fine grain
 *   family 3 stone/rock  → cracked stone cells (voronoi edges)
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

// Distance between the two nearest feature points — small near cell borders,
// giving "cracked stone" edge lines.
float gdVoronoiEdge(vec2 p) {
  vec2 g = floor(p);
  vec2 f = fract(p);
  float d1 = 8.0;
  float d2 = 8.0;
  for (int j = -1; j <= 1; j++) {
    for (int i = -1; i <= 1; i++) {
      vec2 o = vec2(float(i), float(j));
      vec2 r = o + vec2(gdHash(g + o), gdHash(g + o + 19.7)) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; }
      else if (d < d2) { d2 = d; }
    }
  }
  return sqrt(d2) - sqrt(d1);
}
`;

const FRAGMENT_MAIN_END = `
{
  float fam = floor(vGroundDetailFamily + 0.5);
  if (fam >= 0.0) {
    vec2 wp = vGroundDetailPosW.xz;
    float m = 1.0;
    if (fam < 0.5) {
      // grass: two-octave speckle plus a faint vertical blade streak
      float n = gdNoise(wp * 6.5) * 0.55 + gdNoise(wp * 21.0) * 0.45;
      float streak = gdNoise(vec2(wp.x * 38.0, wp.y * 5.0));
      m = mix(0.88, 1.13, n) + (streak - 0.5) * 0.09;
    } else if (fam < 1.5) {
      // dirt: low-frequency clumps
      float n = gdNoise(wp * 3.6) * 0.6 + gdNoise(wp * 15.0) * 0.4;
      m = mix(0.89, 1.10, n);
    } else if (fam < 2.5) {
      // sand: fine even grain
      float n = gdNoise(wp * 28.0) * 0.7 + gdNoise(wp * 9.0) * 0.3;
      m = mix(0.94, 1.07, n);
    } else {
      // stone: cracked cells darken the seams, plus light grain
      float e = gdVoronoiEdge(wp * 3.2);
      float grain = gdNoise(wp * 16.0);
      m = mix(0.80, 1.04, smoothstep(0.0, 0.10, e)) + (grain - 0.5) * 0.05;
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
