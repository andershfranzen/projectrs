import { DEFAULT_CUT_ANGLE, DEFAULT_WATER_FLOW, defaultGroundForMap, legacyCutAngleFromSplit, normalizeCutAngle, normalizeWaterFlow } from '@projectrs/shared'
import type { GroundType, WaterFlow } from '@projectrs/shared'

export interface Tile {
  ground: string
  groundB: string | null
  split: 'forward' | 'back'
  textureId: string | null
  textureRotation: number
  textureScale: number
  textureWorldUV: boolean
  textureHalfMode: boolean
  textureIdB: string | null
  textureRotationB: number
  textureScaleB: number
  /**
   * Cut-line angle (radians, [0, π) — undirected) for the texture overlay's
   * half-paint. Independent of `split`. 0=horizontal, π/4=TL-BR diag,
   * π/2=vertical, 3π/4=BL-TR diag.
   */
  textureCutAngle: number
  /** Signed half-paint cut offset in tile UV units. Positive makes half A larger. */
  textureCutOffset: number
  waterPainted: boolean
  waterSurface: boolean
  waterSurfaceB: boolean
}

export interface CornerHeights {
  tl: number
  tr: number
  bl: number
  br: number
}

export interface TexturePlane {
  id: string
  textureId: string
  width: number
  height: number
  vertical: boolean
  doubleSided: boolean
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number }
  scale: { x: number; y: number; z: number }
  uvRepeat: number
  texRotation: number
  textureHalfMode?: boolean
  textureCutAngle?: number
  tintColor?: { r: number; g: number; b: number }
  noRoof?: boolean
  bridge?: boolean
}

export type MapType = 'overworld' | 'dungeon'

export interface MapDataJSON {
  width: number
  height: number
  mapType: string
  defaultGround?: GroundType
  worldOffset: { x: number; z: number }
  waterLevel: number
  chunkWaterLevels: Record<string, number>
  chunkWaterFlows: Record<string, WaterFlow>
  selectedTexturePlaneId: string | null
  texturePlanes: TexturePlane[]
  tiles: Tile[][]
  heights: number[][]
  terrainGeneration: number
  activeChunks: string[]
}

const CHUNK = 64

function createDefaultTile(defaultGround: GroundType = 'grass'): Tile {
  return {
    ground: defaultGround,
    groundB: null,
    split: 'forward',
    textureId: null,
    textureRotation: 0,
    textureScale: 1,
    textureWorldUV: false,
    textureHalfMode: false,
    textureIdB: null,
    textureRotationB: 0,
    textureScaleB: 1,
    textureCutAngle: DEFAULT_CUT_ANGLE,
    textureCutOffset: 0,
    waterPainted: false,
    waterSurface: false,
    waterSurfaceB: false
  }
}

export class MapData {
  width: number
  height: number
  terrainGeneration: number
  mapType: MapType
  defaultGround: GroundType
  worldOffset: { x: number; z: number }
  waterLevel: number
  chunkWaterLevels: Record<string, number>
  chunkWaterFlows: Record<string, WaterFlow>
  texturePlanes: TexturePlane[]
  selectedTexturePlaneId: string | null
  activeChunks: Set<string>
  tiles: Tile[][]
  heights: number[][]

  constructor(width: number, height: number, defaultGround: GroundType = 'grass') {
    this.width = width
    this.height = height

    this.terrainGeneration = 0   // incremented on terrain/tile/height changes -- used by undo to skip rebuilds
    this.mapType = 'overworld'
    this.defaultGround = defaultGround
    this.worldOffset = { x: 0, z: 0 }
    this.waterLevel = -2.5
    this.chunkWaterLevels = {}
    this.chunkWaterFlows = {}
    this.texturePlanes = []
    this.selectedTexturePlaneId = null
    this.activeChunks = new Set<string>()
    // Initialize all chunks within bounds as active
    for (let cz = 0; cz < Math.ceil(height / CHUNK); cz++) {
      for (let cx = 0; cx < Math.ceil(width / CHUNK); cx++) {
        this.activeChunks.add(`${cx},${cz}`)
      }
    }

    this.tiles = []
    for (let z = 0; z < height; z++) {
      const row: Tile[] = []
      for (let x = 0; x < width; x++) {
        row.push(createDefaultTile(this.defaultGround))
      }
      this.tiles.push(row)
    }

    this.heights = []
    for (let z = 0; z <= height; z++) {
      const row: number[] = []
      for (let x = 0; x <= width; x++) {
        row.push(0)
      }
      this.heights.push(row)
    }
  }

  isChunkActive(cx: number, cz: number): boolean {
    return this.activeChunks.has(`${cx},${cz}`)
  }

  isTileInActiveChunk(x: number, z: number): boolean {
    return this.activeChunks.has(`${Math.floor(x / 64)},${Math.floor(z / 64)}`)
  }

  getTile(x: number, z: number): Tile | null {
    if (x < 0 || z < 0 || x >= this.width || z >= this.height) return null
    return this.tiles[z][x]
  }

  getVertexHeight(x: number, z: number): number {
    if (x < 0 || z < 0 || x > this.width || z > this.height) return 0
    return this.heights[z][x]
  }

  setVertexHeight(x: number, z: number, value: number): void {
    if (x < 0 || z < 0 || x > this.width || z > this.height) return
    this.heights[z][x] = value
    this.terrainGeneration++
  }

  adjustVertexHeight(x: number, z: number, delta: number): void {
    if (x < 0 || z < 0 || x > this.width || z > this.height) return
    this.heights[z][x] += delta
    this.terrainGeneration++
  }

  getTileCornerHeights(x: number, z: number): CornerHeights {
    if (!this.getTile(x, z)) {
      return { tl: 0, tr: 0, bl: 0, br: 0 }
    }

    return {
      tl: this.getVertexHeight(x, z),
      tr: this.getVertexHeight(x + 1, z),
      bl: this.getVertexHeight(x, z + 1),
      br: this.getVertexHeight(x + 1, z + 1)
    }
  }

  getAverageTileHeight(x: number, z: number): number {
    const h = this.getTileCornerHeights(x, z)
    return (h.tl + h.tr + h.bl + h.br) / 4
  }

  getBaseGroundType(x: number, z: number): string {
    const tile = this.getTile(x, z)
    if (!tile) return this.defaultGround
    return tile.ground || this.defaultGround
  }

  getChunkWaterLevel(chunkX: number, chunkZ: number): number {
    const key = `${chunkX},${chunkZ}`
    return Object.prototype.hasOwnProperty.call(this.chunkWaterLevels, key)
      ? this.chunkWaterLevels[key]
      : this.waterLevel
  }

  setChunkWaterLevel(chunkX: number, chunkZ: number, level: number): void {
    this.chunkWaterLevels[`${chunkX},${chunkZ}`] = level
  }

  clearChunkWaterLevel(chunkX: number, chunkZ: number): void {
    delete this.chunkWaterLevels[`${chunkX},${chunkZ}`]
  }

  getTileWaterLevel(x: number, z: number): number {
    const chunkX = Math.floor(x / 64)
    const chunkZ = Math.floor(z / 64)
    return this.getChunkWaterLevel(chunkX, chunkZ)
  }

  getChunkWaterFlow(chunkX: number, chunkZ: number): WaterFlow {
    const key = `${chunkX},${chunkZ}`
    return Object.prototype.hasOwnProperty.call(this.chunkWaterFlows, key)
      ? normalizeWaterFlow(this.chunkWaterFlows[key])
      : { ...DEFAULT_WATER_FLOW }
  }

  setChunkWaterFlow(chunkX: number, chunkZ: number, flow: Partial<WaterFlow>): void {
    const normalized = normalizeWaterFlow(flow)
    const defaultFlow = normalizeWaterFlow(DEFAULT_WATER_FLOW)
    const key = `${chunkX},${chunkZ}`
    if (Math.abs(normalized.x - defaultFlow.x) < 0.0001 && Math.abs(normalized.z - defaultFlow.z) < 0.0001) {
      delete this.chunkWaterFlows[key]
      return
    }
    this.chunkWaterFlows[key] = normalized
  }

  clearChunkWaterFlow(chunkX: number, chunkZ: number): void {
    delete this.chunkWaterFlows[`${chunkX},${chunkZ}`]
  }

  getTileWaterFlow(x: number, z: number): WaterFlow {
    const chunkX = Math.floor(x / 64)
    const chunkZ = Math.floor(z / 64)
    return this.getChunkWaterFlow(chunkX, chunkZ)
  }

  shouldRenderWaterTile(x: number, z: number): boolean {
    const tile = this.getTile(x, z)
    if (!tile) return false

    if (tile.waterPainted) return true

    const h = this.getTileCornerHeights(x, z)
    const minH = Math.min(h.tl, h.tr, h.bl, h.br)

    return minH <= this.getTileWaterLevel(x, z)
  }

  getEffectiveGroundType(x: number, z: number): string {
    const tile = this.getTile(x, z)
    if (!tile) return 'grass'
    return this.shouldRenderWaterTile(x, z) ? 'water' : tile.ground
  }

  isWaterTile(x: number, z: number): boolean {
    return this.shouldRenderWaterTile(x, z)
  }

  raiseTile(x: number, z: number, amount: number = 0.25): void {
    if (!this.getTile(x, z)) return
    this.adjustVertexHeight(x, z, amount)
    this.adjustVertexHeight(x + 1, z, amount)
    this.adjustVertexHeight(x, z + 1, amount)
    this.adjustVertexHeight(x + 1, z + 1, amount)
  }

  lowerTile(x: number, z: number, amount: number = 0.25): void {
    if (!this.getTile(x, z)) return
    this.adjustVertexHeight(x, z, -amount)
    this.adjustVertexHeight(x + 1, z, -amount)
    this.adjustVertexHeight(x, z + 1, -amount)
    this.adjustVertexHeight(x + 1, z + 1, -amount)
  }

  flattenTile(x: number, z: number): void {
    if (!this.getTile(x, z)) return

    const avg = this.getAverageTileHeight(x, z)
    this.setVertexHeight(x, z, avg)
    this.setVertexHeight(x + 1, z, avg)
    this.setVertexHeight(x, z + 1, avg)
    this.setVertexHeight(x + 1, z + 1, avg)
  }

  flattenTileToHeight(x: number, z: number, height: number): void {
    if (!this.getTile(x, z)) return

    this.setVertexHeight(x, z, height)
    this.setVertexHeight(x + 1, z, height)
    this.setVertexHeight(x, z + 1, height)
    this.setVertexHeight(x + 1, z + 1, height)
  }

  paintTile(x: number, z: number, groundType: string): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.ground = groundType
    tile.groundB = null
    if (groundType !== 'water') tile.waterPainted = false
    this.terrainGeneration++
  }

  paintTileFirst(x: number, z: number, groundType: string): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    if (tile.groundB === null) tile.groundB = tile.ground
    tile.ground = groundType
    if (groundType !== 'water') tile.waterPainted = false
    this.terrainGeneration++
  }

  paintTileSecond(x: number, z: number, groundType: string): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.groundB = groundType
    this.terrainGeneration++
  }

  paintWaterTile(x: number, z: number): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.waterPainted = true
    this.terrainGeneration++
  }

  clearWaterPaint(x: number, z: number): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.waterPainted = false
    this.terrainGeneration++
  }

  clearGroundPaint(x: number, z: number, groundType: string = 'grass'): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.ground = groundType
    tile.groundB = null
    tile.waterPainted = false
    this.terrainGeneration++
  }

  paintWaterSurface(x: number, z: number): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.waterSurface = true
    tile.waterSurfaceB = true
    this.terrainGeneration++
  }

  clearWaterSurface(x: number, z: number): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.waterSurface = false
    tile.waterSurfaceB = false
    this.terrainGeneration++
  }

  paintWaterSurfaceHalf(x: number, z: number, half: 'A' | 'B'): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    if (half === 'A') tile.waterSurface = true
    else tile.waterSurfaceB = true
    this.terrainGeneration++
  }

  clearWaterSurfaceHalf(x: number, z: number, half: 'A' | 'B'): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    if (half === 'A') tile.waterSurface = false
    else tile.waterSurfaceB = false
    this.terrainGeneration++
  }

  paintTextureTile(x: number, z: number, textureId: string, rotation: number = 0, scale: number = 1, worldUV: boolean = false): void {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureId = textureId
    tile.textureRotation = rotation
    tile.textureScale = scale
    tile.textureWorldUV = worldUV
    tile.textureHalfMode = false
    tile.textureIdB = null
    tile.textureRotationB = 0
    tile.textureScaleB = 1
    tile.textureCutOffset = 0
  }

  paintTextureTileFirst(x: number, z: number, textureId: string, rotation: number = 0, scale: number = 1): void {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureId = textureId
    tile.textureRotation = rotation
    tile.textureScale = scale
    tile.textureHalfMode = true
  }

  paintTextureTileSecond(x: number, z: number, textureId: string, rotation: number = 0, scale: number = 1): void {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureIdB = textureId
    tile.textureRotationB = rotation
    tile.textureScaleB = scale
    tile.textureHalfMode = true
  }

  /** Set the half-paint cut-line angle (radians). Normalizes to [0, π). */
  setTextureCutAngle(x: number, z: number, angle: number): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.textureCutAngle = normalizeCutAngle(angle)
  }

  /** Set signed half-paint cut offset. Positive makes textureId/half A larger. */
  setTextureCutOffset(x: number, z: number, offset: number): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.textureCutOffset = Math.max(-0.45, Math.min(0.45, Number.isFinite(offset) ? offset : 0))
  }

  clearTextureTile(x: number, z: number): void {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureId = null
    tile.textureRotation = 0
    tile.textureScale = 1
    tile.textureHalfMode = false
    tile.textureIdB = null
    tile.textureRotationB = 0
    tile.textureScaleB = 1
    tile.textureCutOffset = 0
  }

  clearTextureTileFirst(x: number, z: number): void {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureId = null
    tile.textureRotation = 0
    tile.textureScale = 1
    // If the other half is also empty, drop half-mode entirely so the tile
    // returns to a clean state (no stale cut angle, ready for full paint).
    if (!tile.textureIdB) tile.textureHalfMode = false
  }

  clearTextureTileSecond(x: number, z: number): void {
    const tile = this.getTile(x, z)
    if (!tile) return

    tile.textureIdB = null
    tile.textureRotationB = 0
    tile.textureScaleB = 1
    if (!tile.textureId) tile.textureHalfMode = false
  }

  flipTileSplit(x: number, z: number): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    tile.split = tile.split === 'forward' ? 'back' : 'forward'
    this.terrainGeneration++
  }

  setTileSplit(x: number, z: number, direction: 'forward' | 'back'): void {
    const tile = this.getTile(x, z)
    if (!tile) return
    if (tile.split !== direction) {
      tile.split = direction
      this.terrainGeneration++
    }
  }

  addTexturePlane(textureId: string, x: number, y: number, z: number, width: number = 1, height: number = 1, vertical: boolean = true): TexturePlane {
    const plane: TexturePlane = {
      id: `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      textureId,
      width,
      height,
      vertical,
      doubleSided: true,
      position: { x, y, z },
      rotation: vertical
        ? { x: 0, y: 0, z: 0 }
        : { x: -Math.PI / 2, y: 0, z: 0 },
      scale: { x: 1, y: 1, z: 1 },
      uvRepeat: 1,
      texRotation: 0
    }

    this.texturePlanes.push(plane)
    return plane
  }

  resize(newWidth: number, newHeight: number, offsetX: number = 0, offsetZ: number = 0): MapData {
    const next = new MapData(newWidth, newHeight, this.defaultGround)
    next.mapType = this.mapType
    next.defaultGround = this.defaultGround
    next.worldOffset = { ...this.worldOffset }
    next.waterLevel = this.waterLevel
    // Shift chunk water level keys by the offset
    next.chunkWaterLevels = {}
    next.chunkWaterFlows = {}
    if (offsetX !== 0 || offsetZ !== 0) {
      for (const [key, val] of Object.entries(this.chunkWaterLevels)) {
        const [kx, kz] = key.split(',').map(Number)
        next.chunkWaterLevels[`${kx + Math.floor(offsetX / CHUNK)},${kz + Math.floor(offsetZ / CHUNK)}`] = val
      }
      for (const [key, val] of Object.entries(this.chunkWaterFlows)) {
        const [kx, kz] = key.split(',').map(Number)
        next.chunkWaterFlows[`${kx + Math.floor(offsetX / CHUNK)},${kz + Math.floor(offsetZ / CHUNK)}`] = normalizeWaterFlow(val)
      }
    } else {
      Object.assign(next.chunkWaterLevels, this.chunkWaterLevels)
      Object.assign(next.chunkWaterFlows, this.chunkWaterFlows)
    }
    next.texturePlanes = JSON.parse(JSON.stringify(this.texturePlanes))
    next.selectedTexturePlaneId = this.selectedTexturePlaneId

    // Carry over active chunks with offset
    const coxChunks = Math.floor(offsetX / CHUNK)
    const cozChunks = Math.floor(offsetZ / CHUNK)
    next.activeChunks = new Set<string>()
    for (const key of this.activeChunks) {
      const [cx, cz] = key.split(',').map(Number)
      next.activeChunks.add(`${cx + coxChunks},${cz + cozChunks}`)
    }

    // Offset texture planes by the resize shift
    if (offsetX !== 0 || offsetZ !== 0) {
      for (const tp of next.texturePlanes) {
        if (tp.position) {
          if (tp.position.x != null) tp.position.x += offsetX
          if (tp.position.z != null) tp.position.z += offsetZ
        }
      }
    }

    for (let sz = 0; sz < this.height; sz++) {
      const dz = sz + offsetZ
      if (dz < 0 || dz >= newHeight) continue
      for (let sx = 0; sx < this.width; sx++) {
        const dx = sx + offsetX
        if (dx < 0 || dx >= newWidth) continue
        next.tiles[dz][dx] = JSON.parse(JSON.stringify(this.tiles[sz][sx]))
      }
    }

    for (let sz = 0; sz <= this.height; sz++) {
      const dz = sz + offsetZ
      if (dz < 0 || dz > newHeight) continue
      for (let sx = 0; sx <= this.width; sx++) {
        const dx = sx + offsetX
        if (dx < 0 || dx > newWidth) continue
        next.heights[dz][dx] = this.heights[sz][sx]
      }
    }

    return next
  }

  toJSON(): MapDataJSON {
    return {
      width: this.width,
      height: this.height,
      mapType: this.mapType,
      defaultGround: this.defaultGround,
      worldOffset: { ...this.worldOffset },
      waterLevel: this.waterLevel,
      chunkWaterLevels: { ...this.chunkWaterLevels },
      chunkWaterFlows: { ...this.chunkWaterFlows },
      selectedTexturePlaneId: this.selectedTexturePlaneId,
      texturePlanes: this.texturePlanes,
      tiles: this.tiles,
      heights: this.heights,
      terrainGeneration: this.terrainGeneration,
      activeChunks: [...this.activeChunks]
    }
  }

  static fromJSON(data: Partial<MapDataJSON> & { width: number; height: number }): MapData {
    const map = new MapData(data.width, data.height, defaultGroundForMap(data))

    map.mapType = data.mapType === 'dungeon' ? 'dungeon' : 'overworld'
    map.defaultGround = defaultGroundForMap(map)
    map.worldOffset = {
      x: typeof data.worldOffset?.x === 'number' ? data.worldOffset.x : 0,
      z: typeof data.worldOffset?.z === 'number' ? data.worldOffset.z : 0
    }
    map.waterLevel = typeof data.waterLevel === 'number' ? data.waterLevel : -2.5
    map.chunkWaterLevels = (data.chunkWaterLevels && typeof data.chunkWaterLevels === 'object')
      ? { ...data.chunkWaterLevels }
      : {}
    map.chunkWaterFlows = {}
    if (data.chunkWaterFlows && typeof data.chunkWaterFlows === 'object') {
      const defaultFlow = normalizeWaterFlow(DEFAULT_WATER_FLOW)
      for (const [key, flow] of Object.entries(data.chunkWaterFlows)) {
        const normalized = normalizeWaterFlow(flow)
        const isDefault = Math.abs(normalized.x - defaultFlow.x) < 0.0001
          && Math.abs(normalized.z - defaultFlow.z) < 0.0001
        if (!isDefault) map.chunkWaterFlows[key] = normalized
      }
    }
    map.selectedTexturePlaneId = data.selectedTexturePlaneId || null
    map.texturePlanes = Array.isArray(data.texturePlanes)
      ? JSON.parse(JSON.stringify(data.texturePlanes))
      : []

    if (Array.isArray(data.tiles)) {
      for (let z = 0; z < map.height; z++) {
        for (let x = 0; x < map.width; x++) {
          const src = data.tiles?.[z]?.[x]
          if (!src) continue

          const cutAngle = typeof (src as any).textureCutAngle === 'number'
            ? (src as any).textureCutAngle
            : legacyCutAngleFromSplit(src.split)

          map.tiles[z][x] = {
            ground: src.ground || map.defaultGround,
            groundB: src.groundB || null,
            split: src.split || 'forward',
            textureId: src.textureId || null,
            textureRotation: src.textureRotation || 0,
            textureScale: src.textureScale || 1,
            textureWorldUV: !!src.textureWorldUV,
            textureHalfMode: !!src.textureHalfMode,
            textureIdB: src.textureIdB || null,
            textureRotationB: src.textureRotationB || 0,
            textureScaleB: src.textureScaleB || 1,
            textureCutAngle: cutAngle,
            textureCutOffset: typeof (src as any).textureCutOffset === 'number' ? (src as any).textureCutOffset : 0,
            waterPainted: !!src.waterPainted || src.ground === 'water',
            waterSurface: !!src.waterSurface,
            waterSurfaceB: typeof (src as any).waterSurfaceB === 'boolean'
              ? !!(src as any).waterSurfaceB
              : !!src.waterSurface
          }
        }
      }
    }

    if (Array.isArray(data.heights)) {
      for (let z = 0; z <= map.height; z++) {
        for (let x = 0; x <= map.width; x++) {
          map.heights[z][x] = data.heights?.[z]?.[x] ?? 0
        }
      }
    } else {
      for (let z = 0; z < map.height; z++) {
        for (let x = 0; x < map.width; x++) {
          const src = (data.tiles as any)?.[z]?.[x]
          if (!src?.corners) continue

          map.heights[z][x] = src.corners.tl ?? map.heights[z][x]
          map.heights[z][x + 1] = src.corners.tr ?? map.heights[z][x + 1]
          map.heights[z + 1][x] = src.corners.bl ?? map.heights[z + 1][x]
          map.heights[z + 1][x + 1] = src.corners.br ?? map.heights[z + 1][x + 1]
        }
      }
    }

    map.terrainGeneration = data.terrainGeneration ?? 0

    // Restore active chunks (default: all chunks active for backwards compat)
    if (Array.isArray(data.activeChunks)) {
      map.activeChunks = new Set(data.activeChunks)
    }

    return map
  }
}
