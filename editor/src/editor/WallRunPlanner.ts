import { WallEdge } from '@projectrs/shared'

export type WallRunEdge = typeof WallEdge[keyof typeof WallEdge]

export interface TileEdgePoint {
  x: number
  z: number
  u?: number
  v?: number
  edge?: WallRunEdge
}

export interface WallRunPlacement {
  assetId: string
  layerId: string
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
}

export interface WallRunCollision {
  x: number
  z: number
  edge: WallRunEdge
  wallHeight?: number
}

export interface WallRunPlan {
  edge: WallRunEdge
  axis: 'x' | 'z'
  placements: WallRunPlacement[]
  collisions: WallRunCollision[]
}

export interface WallRunPlanOptions {
  assetId: string
  layerId: string
  start: TileEdgePoint
  end: Pick<TileEdgePoint, 'x' | 'z'>
  scale: number
  baseRotation: { x: number; y: number; z: number }
  autoRotate: boolean
  wallHeight?: number
  defaultWallHeight?: number
  heightAt: (x: number, z: number) => number
}

function normalizeEdge(edge: unknown): WallRunEdge | null {
  if (edge === WallEdge.N || edge === WallEdge.E || edge === WallEdge.S || edge === WallEdge.W) return edge
  return null
}

export function nearestWallEdge(point: TileEdgePoint): WallRunEdge {
  const u = point.u ?? 0.5
  const v = point.v ?? 0.5
  const distances = [
    { edge: WallEdge.W, value: u },
    { edge: WallEdge.E, value: 1 - u },
    { edge: WallEdge.N, value: v },
    { edge: WallEdge.S, value: 1 - v },
  ]
  distances.sort((a, b) => a.value - b.value)
  return distances[0].edge
}

export function wallEdgeAxis(edge: WallRunEdge): 'x' | 'z' {
  return edge === WallEdge.N || edge === WallEdge.S ? 'x' : 'z'
}

export function wallEdgeSnapPosition(x: number, z: number, edge: WallRunEdge): { x: number; z: number } {
  if (edge === WallEdge.W) return { x: x + 0.25, z: z + 0.5 }
  if (edge === WallEdge.E) return { x: x + 0.75, z: z + 0.5 }
  if (edge === WallEdge.N) return { x: x + 0.5, z: z + 0.25 }
  return { x: x + 0.5, z: z + 0.75 }
}

export function wallEdgeRotationY(edge: WallRunEdge): number {
  if (edge === WallEdge.E) return Math.PI / 2
  if (edge === WallEdge.S) return Math.PI
  if (edge === WallEdge.W) return -Math.PI / 2
  return 0
}

export function planWallRun(options: WallRunPlanOptions): WallRunPlan {
  const edge = normalizeEdge(options.start.edge) ?? nearestWallEdge(options.start)
  const axis = wallEdgeAxis(edge)
  const fixedX = Math.floor(options.start.x)
  const fixedZ = Math.floor(options.start.z)
  const startCoord = axis === 'x' ? fixedX : fixedZ
  const endCoord = axis === 'x' ? Math.floor(options.end.x) : Math.floor(options.end.z)
  const min = Math.min(startCoord, endCoord)
  const max = Math.max(startCoord, endCoord)
  const defaultWallHeight = options.defaultWallHeight ?? 1.8
  const storeWallHeight = typeof options.wallHeight === 'number'
    && Number.isFinite(options.wallHeight)
    && Math.abs(options.wallHeight - defaultWallHeight) > 0.0001

  const placements: WallRunPlacement[] = []
  const collisions: WallRunCollision[] = []
  for (let coord = min; coord <= max; coord++) {
    const tileX = axis === 'x' ? coord : fixedX
    const tileZ = axis === 'x' ? fixedZ : coord
    const snapped = wallEdgeSnapPosition(tileX, tileZ, edge)
    placements.push({
      assetId: options.assetId,
      layerId: options.layerId,
      position: { x: snapped.x, y: options.heightAt(tileX, tileZ), z: snapped.z },
      rotation: {
        x: options.baseRotation.x,
        y: options.autoRotate ? wallEdgeRotationY(edge) : options.baseRotation.y,
        z: options.baseRotation.z,
      },
      scale: { x: options.scale, y: options.scale, z: options.scale },
    })
    collisions.push({
      x: tileX,
      z: tileZ,
      edge,
      ...(storeWallHeight ? { wallHeight: options.wallHeight } : {}),
    })
  }

  return { edge, axis, placements, collisions }
}
