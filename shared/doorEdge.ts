import { WallEdge } from './types';

const DOOR_EDGE_EPS = 0.05;

export type DoorAxis = 'NS' | 'EW';

export interface DoorEdgeNeighbor {
  dx: number;
  dz: number;
  opposite: number;
}

export const DOOR_EDGE_NEIGHBOR: Record<number, DoorEdgeNeighbor> = {
  [WallEdge.N]: { dx: 0, dz: -1, opposite: WallEdge.S },
  [WallEdge.S]: { dx: 0, dz: 1, opposite: WallEdge.N },
  [WallEdge.E]: { dx: 1, dz: 0, opposite: WallEdge.W },
  [WallEdge.W]: { dx: -1, dz: 0, opposite: WallEdge.E },
};

export function rotationDeg(rotY: number): number {
  return ((Math.round((rotY * 180) / Math.PI) % 360) + 360) % 360;
}

export function doorAxisFromRotY(rotY: number): DoorAxis {
  const deg = rotationDeg(rotY);
  return deg === 0 || deg === 180 ? 'NS' : 'EW';
}

/** Edge derived from rotation alone — used as a fallback for swing-sign math
 *  where the door's authored facing matters more than the placement frac. */
export function doorClosedEdgeFromRotY(rotY: number): number {
  const deg = rotationDeg(rotY);
  if (deg === 0) return WallEdge.N;
  if (deg === 90) return WallEdge.E;
  if (deg === 180) return WallEdge.S;
  if (deg === 270) return WallEdge.W;
  if (deg < 45 || deg > 315) return WallEdge.N;
  if (deg < 135) return WallEdge.E;
  if (deg < 225) return WallEdge.S;
  return WallEdge.W;
}

/** Resolve which tile + edge bit a door's wall mask should occupy. Single
 *  source of truth — server (full precision) and client (0.1-precision after
 *  protocol round-trip) both call this and converge on the same physical
 *  edge via the neighbor logic on each side. */
export function doorEdgeFromPlacement(
  x: number,
  z: number,
  rotY: number,
): { tile: [number, number]; edge: number; axis: DoorAxis } {
  const tx = Math.floor(x);
  const tz = Math.floor(z);
  const fx = x - tx;
  const fz = z - tz;
  const axis = doorAxisFromRotY(rotY);
  if (axis === 'NS') {
    if (Math.abs(fz - 0.5) < DOOR_EDGE_EPS) {
      // Ambiguous: door centred in the tile. Default to N (door visual sits
      // on the tile's N edge). Editors should snap to integer Z to disambiguate.
      return { tile: [tx, tz], edge: WallEdge.N, axis };
    }
    return { tile: [tx, tz], edge: fz > 0.5 ? WallEdge.S : WallEdge.N, axis };
  }
  if (Math.abs(fx - 0.5) < DOOR_EDGE_EPS) {
    return { tile: [tx, tz], edge: WallEdge.W, axis };
  }
  return { tile: [tx, tz], edge: fx > 0.5 ? WallEdge.E : WallEdge.W, axis };
}
