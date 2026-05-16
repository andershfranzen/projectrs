/**
 * Geometry for the texture-overlay half-paint cut.
 *
 * The cut is a single LINE through the tile center (u=0.5, v=0.5) at an
 * arbitrary angle. The line is undirected, so cut angles are normalized to
 * [0, π). The two halves are deterministic: HALF_A is the side whose normal
 * points in the direction (cos(angle+π/2), sin(angle+π/2)); HALF_B is the
 * other side. For the legacy splits:
 *   - π/4   (TL-BR line)  → HALF_A is the upper-right triangle (TR side)
 *   - 3π/4  (BL-TR line)  → HALF_A is the upper-left triangle (TL side)
 * This matches the old "first/second" assignments after the inversion fix,
 * so existing maps render in the same orientation.
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
}

/** Normalize a cut angle into [0, π). */
export function normalizeCutAngle(angle: number): number {
  let a = angle % Math.PI
  if (a < 0) a += Math.PI
  return a
}

/**
 * Compute which half of the tile the given (u, v) lies in, for a cut at
 * `angle` radians through the tile center. The cut line direction is
 * (cos angle, sin angle); the normal that defines HALF_A is rotated +π/2
 * from the line direction.
 */
export function cutSideOf(u: number, v: number, angle: number): CutHalf {
  const a = normalizeCutAngle(angle)
  // Normal to the cut line, pointing into HALF_A.
  const nu = -Math.sin(a)
  const nv =  Math.cos(a)
  const d = (u - 0.5) * nu + (v - 0.5) * nv
  return d >= 0 ? 'A' : 'B'
}

/**
 * Given a cut-line angle through the tile center, build the two polygons
 * (HALF_A and HALF_B) in tile-local UV space. Returned polygons are CCW.
 *
 * The line always passes through (0.5, 0.5) so it exits the tile through
 * exactly two opposite OR two adjacent edges depending on angle. Either
 * way it intersects the boundary at exactly two points (the diagonal
 * cases hit corners; that still resolves to two valid points).
 */
export function computeCutPolygons(angle: number): CutPolygons {
  const a = normalizeCutAngle(angle)
  const cosA = Math.cos(a)
  const sinA = Math.sin(a)

  // Tile corners in UV, CCW order starting from TL:
  // TL(0,0), TR(1,0), BR(1,1), BL(0,1)
  const corners: UVPoint[] = [
    { u: 0, v: 0 },
    { u: 1, v: 0 },
    { u: 1, v: 1 },
    { u: 0, v: 1 },
  ]

  // Signed distance from cut line for each corner. Positive = HALF_A side.
  // The cut-line normal is (-sin a, cos a).
  const nu = -sinA
  const nv =  cosA
  const sd = corners.map((c) => (c.u - 0.5) * nu + (c.v - 0.5) * nv)

  const EPS = 1e-9
  const halfA: UVPoint[] = []
  const halfB: UVPoint[] = []

  for (let i = 0; i < 4; i++) {
    const cur = corners[i]
    const next = corners[(i + 1) % 4]
    const dCur = sd[i]
    const dNext = sd[(i + 1) % 4]

    // Emit the current corner into its half (treat exactly-zero distance as
    // belonging to both halves so degenerate diagonal cases still close).
    if (dCur >= -EPS) halfA.push(cur)
    if (dCur <=  EPS) halfB.push(cur)

    // If this edge straddles the cut line, compute the intersection and
    // emit it to BOTH halves (it sits on the cut).
    const straddles = (dCur > EPS && dNext < -EPS) || (dCur < -EPS && dNext > EPS)
    if (straddles) {
      const t = dCur / (dCur - dNext) // in (0, 1)
      const ix: UVPoint = {
        u: cur.u + t * (next.u - cur.u),
        v: cur.v + t * (next.v - cur.v),
      }
      halfA.push(ix)
      halfB.push(ix)
    }
  }

  return { halfA, halfB }
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
 * Corner order matches: TL=u=0,v=0; TR=u=1,v=0; BL=u=0,v=1; BR=u=1,v=1.
 */
export function bilerpCorners(
  tl: number, tr: number, bl: number, br: number,
  u: number, v: number,
): number {
  const top = tl * (1 - u) + tr * u
  const bot = bl * (1 - u) + br * u
  return top * (1 - v) + bot * v
}
