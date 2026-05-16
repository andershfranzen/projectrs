/**
 * Geometry for the texture-overlay half-paint cut.
 *
 * The cut is a single LINE through the tile center (u=0.5, v=0.5) at an
 * arbitrary angle. The line is undirected, so cut angles are normalized to
 * [0, π). The two halves are deterministic: HALF_A is the side whose normal
 * points in the direction (-sin(angle), cos(angle)); HALF_B is the other
 * side. For the legacy splits:
 *   - π/4   (TL-BR line)  → HALF_A is the upper-right triangle (TR side)
 *   - 3π/4  (BL-TR line)  → HALF_A is the upper-left triangle (TL side)
 *
 * The picker uses HALF_A for textureId and HALF_B for textureIdB.
 */

export type CutHalf = 'A' | 'B'

/** A tile-local (u, v) point in [0, 1] × [0, 1]. */
export interface UVPoint { u: number; v: number }

export interface CutPolygons {
  /** Ordered (u, v) ring for half A, CCW in tile UV space. */
  halfA: UVPoint[]
  /** Ordered (u, v) ring for half B, CCW in tile UV space. */
  halfB: UVPoint[]
  /** The two points where the cut line meets the tile boundary. */
  cutEndpoints: [UVPoint, UVPoint]
}

// --- Named cut angles ---

export const CUT_HORIZONTAL  = 0
export const CUT_DIAG_TL_BR  = Math.PI / 4
export const CUT_VERTICAL    = Math.PI / 2
export const CUT_DIAG_BL_TR  = (3 * Math.PI) / 4

/** Default cut angle for fresh tiles — matches legacy `split: 'forward'`. */
export const DEFAULT_CUT_ANGLE = CUT_DIAG_BL_TR

/** Snap targets for the cursor-driven cut picker (radians). */
export const CUT_SNAP_ANGLES: readonly number[] = [
  CUT_HORIZONTAL, CUT_DIAG_TL_BR, CUT_VERTICAL, CUT_DIAG_BL_TR,
]

export const CUT_SNAP_TOLERANCE_RAD = (10 * Math.PI) / 180

/** Read-only 4-corner CCW ring used when not in half-paint mode. */
export const FULL_TILE_RING: readonly UVPoint[] = [
  { u: 0, v: 0 },
  { u: 1, v: 0 },
  { u: 1, v: 1 },
  { u: 0, v: 1 },
]

// --- Helpers ---

/** Normalize a cut angle into [0, π). */
export function normalizeCutAngle(angle: number): number {
  let a = angle % Math.PI
  if (a < 0) a += Math.PI
  return a
}

/** Migrate the legacy `split: 'forward'|'back'` field into a cut angle. */
export function legacyCutAngleFromSplit(split: 'forward' | 'back' | undefined | null): number {
  return split === 'back' ? CUT_DIAG_TL_BR : CUT_DIAG_BL_TR
}

/**
 * Tile-local UV (u, v) → scaled & rotated texture UV. Used by all three
 * overlay renderers (editor full rebuild, editor single-tile, client chunk).
 * Caller must pre-clamp scale via `Math.max(0.1, scale)` and pre-normalize
 * rotation via `((rotation % 4) + 4) % 4` — both are hoisted out of the
 * per-vertex loop at the call site.
 */
export function transformOverlayUV(u: number, v: number, rotationMod4: number, scaleClamped: number): [number, number] {
  const su = (u - 0.5) / scaleClamped + 0.5
  const sv = (v - 0.5) / scaleClamped + 0.5
  if (rotationMod4 === 1) return [-(sv - 0.5) + 0.5, (su - 0.5) + 0.5]
  if (rotationMod4 === 2) return [-(su - 0.5) + 0.5, -(sv - 0.5) + 0.5]
  if (rotationMod4 === 3) return [(sv - 0.5) + 0.5, -(su - 0.5) + 0.5]
  return [su, sv]
}

/**
 * Compute which half of the tile the given (u, v) lies in, for a cut at
 * `angle` radians through the tile center. The cut line direction is
 * (cos angle, sin angle); the normal that defines HALF_A is rotated +π/2
 * from the line direction.
 */
export function cutSideOf(u: number, v: number, angle: number): CutHalf {
  const a = normalizeCutAngle(angle)
  const nu = -Math.sin(a)
  const nv =  Math.cos(a)
  const d = (u - 0.5) * nu + (v - 0.5) * nv
  return d >= 0 ? 'A' : 'B'
}

// Shared corner objects — referenced by computeCutPolygons output rings
// instead of being re-allocated per call. Treat as immutable.
const CORNER_TL: UVPoint = Object.freeze({ u: 0, v: 0 }) as UVPoint
const CORNER_TR: UVPoint = Object.freeze({ u: 1, v: 0 }) as UVPoint
const CORNER_BR: UVPoint = Object.freeze({ u: 1, v: 1 }) as UVPoint
const CORNER_BL: UVPoint = Object.freeze({ u: 0, v: 1 }) as UVPoint
const CORNERS: readonly UVPoint[] = [CORNER_TL, CORNER_TR, CORNER_BR, CORNER_BL]

/**
 * Given a cut-line angle through the tile center, build the two polygons
 * (HALF_A and HALF_B) in tile-local UV space. Returned polygons are CCW.
 *
 * Also returns `cutEndpoints` — the two points where the cut line meets the
 * tile boundary — so the hover preview doesn't need to reverse-engineer
 * them by deduping vertices shared between halfA and halfB.
 *
 * For diagonal cuts that pass through corners exactly, those corners are
 * treated as the endpoints.
 */
export function computeCutPolygons(angle: number): CutPolygons {
  const a = normalizeCutAngle(angle)
  const nu = -Math.sin(a)
  const nv =  Math.cos(a)

  // Signed distance from cut line for each corner. Positive = HALF_A side.
  const sd0 = (-0.5) * nu + (-0.5) * nv  // TL
  const sd1 = ( 0.5) * nu + (-0.5) * nv  // TR
  const sd2 = ( 0.5) * nu + ( 0.5) * nv  // BR
  const sd3 = (-0.5) * nu + ( 0.5) * nv  // BL
  const sd = [sd0, sd1, sd2, sd3]

  const EPS = 1e-9
  const halfA: UVPoint[] = []
  const halfB: UVPoint[] = []
  const endpoints: UVPoint[] = []

  for (let i = 0; i < 4; i++) {
    const cur = CORNERS[i]
    const next = CORNERS[(i + 1) % 4]
    const dCur = sd[i]
    const dNext = sd[(i + 1) % 4]

    // Emit the current corner into its half (treat exactly-zero distance as
    // belonging to both halves so degenerate diagonal cases still close).
    if (dCur >= -EPS) halfA.push(cur)
    if (dCur <=  EPS) halfB.push(cur)
    if (Math.abs(dCur) <= EPS && endpoints.length < 2) endpoints.push(cur)

    // If this edge straddles the cut line, the intersection sits on the cut
    // and goes into BOTH halves' rings plus the endpoints list.
    const straddles = (dCur > EPS && dNext < -EPS) || (dCur < -EPS && dNext > EPS)
    if (straddles) {
      const t = dCur / (dCur - dNext)
      const ix: UVPoint = {
        u: cur.u + t * (next.u - cur.u),
        v: cur.v + t * (next.v - cur.v),
      }
      halfA.push(ix)
      halfB.push(ix)
      if (endpoints.length < 2) endpoints.push(ix)
    }
  }

  // Lines through the tile center always exit at exactly 2 boundary points.
  // Guard the cutEndpoints tuple shape if EPS comparisons ever drop one.
  while (endpoints.length < 2) endpoints.push({ u: 0.5, v: 0.5 })

  return { halfA, halfB, cutEndpoints: [endpoints[0], endpoints[1]] }
}

/**
 * Triangulate a convex polygon (3-5 vertices) by fanning from vertex 0.
 * Returns a flat list of vertex indices (3 per triangle) into the polygon.
 */
export function fanTriangulate(vertexCount: number): number[] {
  const out: number[] = []
  for (let i = 1; i < vertexCount - 1; i++) {
    out.push(0, i, i + 1)
  }
  return out
}

/**
 * Bilinearly interpolate a corner-valued quantity at tile-local UV.
 * Corner order matches MapData.getTileCornerHeights: TL=(0,0), TR=(1,0),
 * BL=(0,1), BR=(1,1).
 */
export function bilerpCorners(
  tl: number, tr: number, bl: number, br: number,
  u: number, v: number,
): number {
  const top = tl * (1 - u) + tr * u
  const bot = bl * (1 - u) + br * u
  return top * (1 - v) + bot * v
}
