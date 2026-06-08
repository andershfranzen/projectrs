import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { VertexBuffer } from '@babylonjs/core/Buffers/buffer'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Material } from '@babylonjs/core/Materials/material'
import { Color3 } from '@babylonjs/core/Maths/math.color'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import type { Scene } from '@babylonjs/core/scene'
import { clamp, groundColor, getNoiseExtra, getSlopeShade, getVertexAO as sharedGetVertexAO, getVertexWaterProximity as sharedGetVertexWaterProximity, computeCutPolygons, fanTriangulate, bilerpCorners, transformOverlayUV, fullTileRingForSplit, DEFAULT_CUT_ANGLE, pushWaterFlowQuadUvs, waterFlowUvTransform, waterFlowUvFromTransform, applyWaterEdgeMudTint, applyTorchlightTint, hasTorchlightPaint, visualGroundForTorchlight, bilerpRGB, buildTorchlightInfluenceGrid, sampleTorchlightInfluenceGrid, maxTorchlightInfluenceForTile, TORCHLIGHT_GLOW_RADIUS_TILES, TORCHLIGHT_GLOW_SUBDIVISIONS, WATER_TEXTURE_ALPHA, SURFACE_WATER_ALPHA, WATER_TEXTURE_TINT, SURFACE_WATER_TEXTURE_TINT, WATER_FALLBACK_TINT, SURFACE_WATER_FALLBACK_TINT, WATER_SURFACE_VERTEX_COLOR, SURFACE_WATER_VERTEX_COLOR, WATER_UV_SCALE } from '@projectrs/shared'
import type { RGB, GroundType, UVPoint, WaterFlowUvTransform, TorchlightInfluenceGrid, TorchlightPaintTile } from '@projectrs/shared'
import type { MapData, TexturePlane } from './MapData'
import type { TextureEntry } from '../assets-system/TextureRegistry'

function colorMultiplyScalar(c: RGB, s: number): void {
  c.r *= s; c.g *= s; c.b *= s
}

function rgbToColor3(c: RGB): Color3 {
  return new Color3(c.r, c.g, c.b)
}

function pushVertex(vertices: number[], colors: number[], uvs: number[], x: number, y: number, z: number, color: RGB, u: number, v: number): void {
  vertices.push(x, y, z)
  colors.push(color.r, color.g, color.b, 1.0)
  uvs.push(u, v)
}

function shouldRenderWater(map: MapData, x: number, z: number): boolean {
  if (typeof map.shouldRenderWaterTile === 'function') {
    return map.shouldRenderWaterTile(x, z)
  }
  return map.isWaterTile(x, z)
}

function getWaterFlowTransform(map: MapData, x: number, z: number, cache: Map<string, WaterFlowUvTransform>): WaterFlowUvTransform {
  const chunkX = Math.floor(x / 64)
  const chunkZ = Math.floor(z / 64)
  const key = `${chunkX},${chunkZ}`
  let transform = cache.get(key)
  if (!transform) {
    transform = waterFlowUvTransform(map.getChunkWaterFlow(chunkX, chunkZ), WATER_UV_SCALE)
    cache.set(key, transform)
  }
  return transform
}

function pushWaterUvs(map: MapData, x: number, z: number, uvs: number[], cache: Map<string, WaterFlowUvTransform>): void {
  pushWaterFlowQuadUvs(uvs, x, z, getWaterFlowTransform(map, x, z, cache), 'tl-tr-bl-br')
}

function appendSurfaceWaterTile(
  map: MapData,
  x: number,
  z: number,
  vertices: number[],
  colors: number[],
  uvs: number[],
  indices: number[],
  base: number,
  cache: Map<string, WaterFlowUvTransform>,
): number {
  const tile = map.getTile(x, z)
  const waterA = !!tile?.waterSurface
  const waterB = !!tile?.waterSurfaceB
  if (!waterA && !waterB) return base

  const h = map.getTileCornerHeights(x, z)
  const LIFT = 0.05
  const wc = SURFACE_WATER_VERTEX_COLOR
  const transform = getWaterFlowTransform(map, x, z, cache)

  const addRing = (ring: readonly UVPoint[]): void => {
    if (ring.length < 3) return
    const b = base
    for (const p of ring) {
      const wx = x + p.u
      const wz = z + p.v
      const wy = bilerpCorners(h.tl, h.tr, h.bl, h.br, p.u, p.v) + LIFT
      const [u, v] = waterFlowUvFromTransform(wx, wz, transform)
      vertices.push(wx, wy, wz)
      colors.push(wc.r, wc.g, wc.b, 1)
      uvs.push(u, v)
    }
    const tris = fanTriangulate(ring.length)
    for (const i of tris) indices.push(b + i)
    base += ring.length
  }

  if (waterA && waterB) {
    addRing(fullTileRingForSplit(tile?.split))
    return base
  }

  const { halfA, halfB } = computeCutPolygons(tile?.textureCutAngle ?? DEFAULT_CUT_ANGLE, tile?.textureCutOffset ?? 0)
  if (waterA) addRing(halfA)
  if (waterB) addRing(halfB)

  return base
}

function getVertexWaterProximity(map: MapData, vx: number, vz: number): number {
  return sharedGetVertexWaterProximity(vx, vz, (tx, tz) => _cvShouldRenderWater(map, tx, tz))
}

function getVertexCliffStrength(map: MapData, vx: number, vz: number): number {
  const h = map.getVertexHeight(vx, vz)
  let maxDiff = 0
  for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]] as [number, number][]) {
    const nx = vx + dx, nz = vz + dz
    if (nx < 0 || nx > map.width || nz < 0 || nz > map.height) continue
    const diff = Math.abs(h - map.getVertexHeight(nx, nz))
    if (diff > maxDiff) maxDiff = diff
  }
  return clamp((maxDiff - 0.9) / 1.1, 0, 1)
}

function getVertexSlopeShade(map: MapData, vx: number, vz: number): number {
  const sharingTiles: [number, number][] = [
    [vx - 1, vz - 1],
    [vx,     vz - 1],
    [vx - 1, vz    ],
    [vx,     vz    ]
  ]

  let total = 0
  let count = 0
  for (const [tx, tz] of sharingTiles) {
    if (!map.getTile(tx, tz)) continue
    total += getSlopeShade(map.getTileCornerHeights(tx, tz))
    count++
  }

  return count > 0 ? total / count : 1.0
}

function getVertexAO(map: MapData, vx: number, vz: number): number {
  return sharedGetVertexAO(vx, vz, map.width, map.height, (x, z) => map.getVertexHeight(x, z))
}

function rawTileHasTorchlightPaint(map: MapData, x: number, z: number): boolean {
  const tile = map.getTile(x, z)
  return hasTorchlightPaint(tile?.ground as GroundType | undefined, tile?.groundB as GroundType | null | undefined)
}

let _torchlightIndexMap: MapData | null = null
let _torchlightIndexW = 0
let _torchlightIndexH = 0
let _torchlightPaint: Int8Array | null = null
let _torchlightCount = 0

function rebuildTorchlightPaintIndex(map: MapData): void {
  _torchlightIndexMap = map
  _torchlightIndexW = map.width
  _torchlightIndexH = map.height
  _torchlightPaint = new Int8Array(map.width * map.height)
  _torchlightCount = 0
  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      if (!rawTileHasTorchlightPaint(map, x, z)) continue
      _torchlightPaint[z * map.width + x] = 1
      _torchlightCount++
    }
  }
}

function ensureTorchlightPaintIndex(map: MapData): void {
  if (_torchlightIndexMap !== map || _torchlightIndexW !== map.width || _torchlightIndexH !== map.height || !_torchlightPaint) {
    rebuildTorchlightPaintIndex(map)
  }
}

function updateTorchlightPaintIndexRegion(map: MapData, x1: number, z1: number, x2: number, z2: number): void {
  ensureTorchlightPaintIndex(map)
  if (!_torchlightPaint) return
  const rx1 = Math.max(0, x1)
  const rz1 = Math.max(0, z1)
  const rx2 = Math.min(map.width - 1, x2)
  const rz2 = Math.min(map.height - 1, z2)
  for (let z = rz1; z <= rz2; z++) {
    for (let x = rx1; x <= rx2; x++) {
      const idx = z * map.width + x
      const prev = _torchlightPaint[idx] === 1
      const next = rawTileHasTorchlightPaint(map, x, z)
      if (prev === next) continue
      _torchlightPaint[idx] = next ? 1 : 0
      _torchlightCount += next ? 1 : -1
    }
  }
}

function collectTorchlightPaintTilesForRegion(map: MapData, startX: number, startZ: number, endX: number, endZ: number): TorchlightPaintTile[] {
  ensureTorchlightPaintIndex(map)
  if (!_torchlightPaint || _torchlightCount <= 0) return []
  const pad = Math.ceil(TORCHLIGHT_GLOW_RADIUS_TILES)
  const rx1 = Math.max(0, startX - pad)
  const rz1 = Math.max(0, startZ - pad)
  const rx2 = Math.min(map.width - 1, endX + pad - 1)
  const rz2 = Math.min(map.height - 1, endZ + pad - 1)
  const out: TorchlightPaintTile[] = []
  for (let z = rz1; z <= rz2; z++) {
    for (let x = rx1; x <= rx2; x++) {
      if (_torchlightPaint[z * map.width + x] !== 1) continue
      out.push({ x, z })
    }
  }
  return out
}

function buildTorchlightGridForRegion(map: MapData, startX: number, startZ: number, endX: number, endZ: number): TorchlightInfluenceGrid | null {
  return buildTorchlightInfluenceGrid(
    startX,
    startZ,
    endX,
    endZ,
    collectTorchlightPaintTilesForRegion(map, startX, startZ, endX, endZ),
  )
}

function torchlightInfluenceAt(worldX: number, worldZ: number): number {
  return sampleTorchlightInfluenceGrid(_vcTorchlightGrid, worldX, worldZ)
}

function pushTorchlightSubdividedTile(
  vertices: number[],
  colors: number[],
  uvs: number[],
  indices: number[],
  base: number,
  h: CornerH,
  x: number,
  z: number,
  cTL: RGB,
  cTR: RGB,
  cBL: RGB,
  cBR: RGB,
): number {
  const steps = TORCHLIGHT_GLOW_SUBDIVISIONS
  const row = steps + 1

  for (let vz = 0; vz <= steps; vz++) {
    const v = vz / steps
    for (let ux = 0; ux <= steps; ux++) {
      const u = ux / steps
      const color = bilerpRGB(cTL, cTR, cBL, cBR, u, v)
      applyTorchlightTint(color, torchlightInfluenceAt(x + u, z + v))
      pushVertex(vertices, colors, uvs, x + u, bilerpCorners(h.tl, h.tr, h.bl, h.br, u, v), z + v, color, u, v)
    }
  }

  for (let vz = 0; vz < steps; vz++) {
    for (let ux = 0; ux < steps; ux++) {
      const tl = base + vz * row + ux
      const tr = tl + 1
      const bl = base + (vz + 1) * row + ux
      const br = bl + 1
      indices.push(tl, tr, bl, tr, br, bl)
    }
  }

  return row * row
}

function getCornerBlendedColor(map: MapData, cornerX: number, cornerZ: number, shade: number): RGB {
  const sharingTiles: [number, number][] = [
    [cornerX - 1, cornerZ - 1],
    [cornerX,     cornerZ - 1],
    [cornerX - 1, cornerZ    ],
    [cornerX,     cornerZ    ]
  ]

  let r = 0, g = 0, b = 0, noise = 0, totalWeight = 0
  for (const [nx, nz] of sharingTiles) {
    if (!map.getTile(nx, nz)) continue
    const tile = map.getTile(nx, nz)
    const type = visualGroundForTorchlight(
      (tile?.ground || map.defaultGround) as GroundType,
      (tile?.groundB || null) as GroundType | null,
    )
    if (type === 'void') continue
    if (type === 'road') continue
    const w = 1.0
    const c = groundColor(type, 1.0)
    r += c.r * w; g += c.g * w; b += c.b * w
    noise += getNoiseExtra(type, cornerX, cornerZ) * w
    totalWeight += w
  }

  if (totalWeight === 0) return groundColor('grass', shade)
  const s = shade + noise / totalWeight
  return { r: (r / totalWeight) * s, g: (g / totalWeight) * s, b: (b / totalWeight) * s }
}

// --- Per-rebuild vertex cache ---
let _vcCols = 0
let _vcWaterProx: Float32Array | null = null
let _vcCliffStr: Float32Array | null = null
let _vcAO: Float32Array | null = null
let _vcSlopeShade: Float32Array | null = null
let _vcRenderWater: Int8Array | null = null
let _vcTorchlightGrid: TorchlightInfluenceGrid | null = null

function _initVertexCache(
  map: MapData,
  region: { startX: number; startZ: number; endX: number; endZ: number } = {
    startX: 0,
    startZ: 0,
    endX: map.width,
    endZ: map.height,
  },
  forceTorchlightIndex = false,
): void {
  const size = (map.width + 1) * (map.height + 1)
  _vcCols       = map.width + 1
  _vcWaterProx  = new Float32Array(size).fill(-1)
  _vcCliffStr   = new Float32Array(size).fill(-1)
  _vcAO         = new Float32Array(size).fill(-1)
  _vcSlopeShade = new Float32Array(size).fill(-1)
  _vcRenderWater = new Int8Array(map.width * map.height).fill(-1)
  if (forceTorchlightIndex) rebuildTorchlightPaintIndex(map)
  else ensureTorchlightPaintIndex(map)
  _vcTorchlightGrid = buildTorchlightGridForRegion(map, region.startX, region.startZ, region.endX, region.endZ)
}

function _cvShouldRenderWater(map: MapData, x: number, z: number): boolean {
  if (x < 0 || z < 0 || x >= map.width || z >= map.height) return false
  if (!_vcRenderWater) return shouldRenderWater(map, x, z)
  const i = z * map.width + x
  const cached = _vcRenderWater[i]
  if (cached >= 0) return cached === 1
  const result = shouldRenderWater(map, x, z)
  _vcRenderWater[i] = result ? 1 : 0
  return result
}

function _cvWaterProx(map: MapData, vx: number, vz: number): number {
  const i = vz * _vcCols + vx
  if (_vcWaterProx![i] < 0) _vcWaterProx![i] = getVertexWaterProximity(map, vx, vz)
  return _vcWaterProx![i]
}
function _cvCliffStr(map: MapData, vx: number, vz: number): number {
  const i = vz * _vcCols + vx
  if (_vcCliffStr![i] < 0) _vcCliffStr![i] = getVertexCliffStrength(map, vx, vz)
  return _vcCliffStr![i]
}
function _cvAO(map: MapData, vx: number, vz: number): number {
  const i = vz * _vcCols + vx
  if (_vcAO![i] < 0) _vcAO![i] = getVertexAO(map, vx, vz)
  return _vcAO![i]
}
function _cvSlopeShade(map: MapData, vx: number, vz: number): number {
  const i = vz * _vcCols + vx
  if (_vcSlopeShade![i] < 0) _vcSlopeShade![i] = getVertexSlopeShade(map, vx, vz)
  return _vcSlopeShade![i]
}

// --- Persistent land mesh for partial height-only updates ---
let _landMesh: Mesh | null = null
let _landPosBuf: Float32Array | null = null
let _landColBuf: Float32Array | null = null
let _landTileOff: Int32Array | null = null
let _landMapW = 0
let _landMapH = 0

interface CornerH { tl: number; tr: number; bl: number; br: number }

function addTileGeometry(
  vertices: number[], colors: number[], uvs: number[], indices: number[],
  base: number, tileType: GroundType, h: CornerH, x: number, z: number,
  map: MapData, shadowInf: number[][] | null,
): number {
  const shadeTL = _cvSlopeShade(map, x,     z    )
  const shadeTR = _cvSlopeShade(map, x + 1, z    )
  const shadeBL = _cvSlopeShade(map, x,     z + 1)
  const shadeBR = _cvSlopeShade(map, x + 1, z + 1)
  const slopeShade = (shadeTL + shadeTR + shadeBL + shadeBR) / 4

  const tile = map.getTile(x, z)
  const rawGroundBType = (tile?.groundB || null) as GroundType | null
  const isTorchlightPaint = hasTorchlightPaint(tileType, rawGroundBType)
  const renderTileType = visualGroundForTorchlight(tileType, rawGroundBType)
  const groundBType = rawGroundBType && !isTorchlightPaint ? rawGroundBType : null
  const splitDir = tile?.split || 'forward'

  let cTL: RGB, cTR: RGB, cBL: RGB, cBR: RGB
  if (renderTileType === 'road') {
    const noise = getNoiseExtra('road', x + 0.5, z + 0.5)
    cTL = groundColor('road', Math.max(shadeTL + noise, 0.5))
    cTR = groundColor('road', Math.max(shadeTR + noise, 0.5))
    cBL = groundColor('road', Math.max(shadeBL + noise, 0.5))
    cBR = groundColor('road', Math.max(shadeBR + noise, 0.5))
  } else {
    cTL = getCornerBlendedColor(map, x,     z,     shadeTL)
    cTR = getCornerBlendedColor(map, x + 1, z,     shadeTR)
    cBL = getCornerBlendedColor(map, x,     z + 1, shadeBL)
    cBR = getCornerBlendedColor(map, x + 1, z + 1, shadeBR)
  }

  if (renderTileType !== 'water') {
    const wLevel = map.getTileWaterLevel(x, z)

    const proxTL = _cvWaterProx(map, x,     z    )
    const proxTR = _cvWaterProx(map, x + 1, z    )
    const proxBL = _cvWaterProx(map, x,     z + 1)
    const proxBR = _cvWaterProx(map, x + 1, z + 1)

    applyWaterEdgeMudTint(cTL, proxTL)
    applyWaterEdgeMudTint(cTR, proxTR)
    applyWaterEdgeMudTint(cBL, proxBL)
    applyWaterEdgeMudTint(cBR, proxBR)

    const applyDepth = (c: RGB, vertH: number): void => {
      const depth = clamp((wLevel - vertH) / 2.5, 0, 1)
      if (depth <= 0) return
      c.r *= 1 - depth * 0.60
      c.g *= 1 - depth * 0.45
      c.b *= 1 - depth * 0.20
    }
    applyDepth(cTL, h.tl)
    applyDepth(cTR, h.tr)
    applyDepth(cBL, h.bl)
    applyDepth(cBR, h.br)
  }

  if (renderTileType !== 'water') {
    const applyCliffTint = (c: RGB, t: number): void => {
      if (t <= 0) return
      c.r *= 1 + t * 0.04
      c.g *= 1 - t * 0.08
      c.b *= 1 - t * 0.16
    }
    applyCliffTint(cTL, _cvCliffStr(map, x,     z    ))
    applyCliffTint(cTR, _cvCliffStr(map, x + 1, z    ))
    applyCliffTint(cBL, _cvCliffStr(map, x,     z + 1))
    applyCliffTint(cBR, _cvCliffStr(map, x + 1, z + 1))
  }

  if (renderTileType !== 'water') {
    colorMultiplyScalar(cTL, _cvAO(map, x,     z    ))
    colorMultiplyScalar(cTR, _cvAO(map, x + 1, z    ))
    colorMultiplyScalar(cBL, _cvAO(map, x,     z + 1))
    colorMultiplyScalar(cBR, _cvAO(map, x + 1, z + 1))
  }

  const shadowableType = renderTileType === 'grass' || renderTileType === 'dirt' || renderTileType === 'path'
  if (shadowableType && shadowInf) {
    colorMultiplyScalar(cTL, shadowInf[z    ][x    ])
    colorMultiplyScalar(cTR, shadowInf[z    ][x + 1])
    colorMultiplyScalar(cBL, shadowInf[z + 1][x    ])
    colorMultiplyScalar(cBR, shadowInf[z + 1][x + 1])
  }

  if (groundBType && groundBType !== renderTileType) {
    const noiseA = getNoiseExtra(renderTileType, x + 0.25, z + 0.25)
    const noiseB = getNoiseExtra(groundBType, x + 0.75, z + 0.75)
    const cA = groundColor(renderTileType, Math.max(slopeShade + noiseA, 0.5))
    const cB = groundColor(groundBType, Math.max(slopeShade + noiseB, 0.5))
    const avgAO = (_cvAO(map, x, z) + _cvAO(map, x+1, z) + _cvAO(map, x, z+1) + _cvAO(map, x+1, z+1)) / 4
    const shadowableA = renderTileType === 'grass' || renderTileType === 'dirt' || renderTileType === 'path'
    const shadowableB = groundBType === 'grass' || groundBType === 'dirt' || groundBType === 'path'
    const avgShadow = shadowInf
      ? (shadowInf[z][x] + shadowInf[z][x+1] + shadowInf[z+1][x] + shadowInf[z+1][x+1]) / 4
      : 1.0
    colorMultiplyScalar(cA, avgAO * (shadowableA && shadowInf ? avgShadow : 1.0))
    colorMultiplyScalar(cB, avgAO * (shadowableB && shadowInf ? avgShadow : 1.0))
    const splitGlow = torchlightInfluenceAt(x + 0.5, z + 0.5)
    applyTorchlightTint(cA, splitGlow)
    applyTorchlightTint(cB, splitGlow)

    if (splitDir === 'forward') {
      pushVertex(vertices, colors, uvs, x,     h.tl, z,     cA, 0, 0)
      pushVertex(vertices, colors, uvs, x + 1, h.tr, z,     cA, 1, 0)
      pushVertex(vertices, colors, uvs, x,     h.bl, z + 1, cA, 0, 1)
      pushVertex(vertices, colors, uvs, x + 1, h.tr, z,     cB, 1, 0)
      pushVertex(vertices, colors, uvs, x + 1, h.br, z + 1, cB, 1, 1)
      pushVertex(vertices, colors, uvs, x,     h.bl, z + 1, cB, 0, 1)
    } else {
      pushVertex(vertices, colors, uvs, x,     h.tl, z,     cA, 0, 0)
      pushVertex(vertices, colors, uvs, x + 1, h.tr, z,     cA, 1, 0)
      pushVertex(vertices, colors, uvs, x + 1, h.br, z + 1, cA, 1, 1)
      pushVertex(vertices, colors, uvs, x,     h.tl, z,     cB, 0, 0)
      pushVertex(vertices, colors, uvs, x + 1, h.br, z + 1, cB, 1, 1)
      pushVertex(vertices, colors, uvs, x,     h.bl, z + 1, cB, 0, 1)
    }

    indices.push(base + 0, base + 1, base + 2, base + 3, base + 4, base + 5)
    return 6
  }

  const torchMax = maxTorchlightInfluenceForTile(_vcTorchlightGrid, x, z)
  if (renderTileType !== 'water' && torchMax > 0.001) {
    return pushTorchlightSubdividedTile(
      vertices, colors, uvs, indices,
      base, h, x, z,
      cTL, cTR, cBL, cBR,
    )
  }

  pushVertex(vertices, colors, uvs, x,     h.tl, z,     cTL, 0, 0)
  pushVertex(vertices, colors, uvs, x + 1, h.tr, z,     cTR, 1, 0)
  pushVertex(vertices, colors, uvs, x,     h.bl, z + 1, cBL, 0, 1)
  pushVertex(vertices, colors, uvs, x + 1, h.br, z + 1, cBR, 1, 1)

  if (splitDir === 'forward') {
    indices.push(base + 0, base + 1, base + 2, base + 1, base + 3, base + 2)
  } else {
    indices.push(base + 0, base + 1, base + 3, base + 0, base + 3, base + 2)
  }
  return 4
}

function createMeshFromArrays(
  name: string, positions: number[], colors4: number[] | null,
  uvs: number[] | null, indices: number[], scene: Scene, updatable = false,
): Mesh {
  const mesh = new Mesh(name, scene)
  const vertexData = new VertexData()
  vertexData.positions = positions
  vertexData.indices = indices
  if (colors4 && colors4.length > 0) vertexData.colors = colors4
  if (uvs && uvs.length > 0) vertexData.uvs = uvs
  const normals: number[] = []
  VertexData.ComputeNormals(positions, indices, normals)
  vertexData.normals = normals
  vertexData.applyToMesh(mesh, updatable)
  mesh.hasVertexAlpha = false
  return mesh
}

interface LambertOpts {
  backFaceCulling?: boolean
  alpha?: number
  zOffset?: number
  diffuseColor?: Color3
  diffuseTexture?: Texture
}

function createLambertMaterial(name: string, scene: Scene, opts: LambertOpts = {}): StandardMaterial {
  const mat = new StandardMaterial(name, scene)
  mat.specularColor = new Color3(0, 0, 0)
  mat.backFaceCulling = opts.backFaceCulling !== undefined ? opts.backFaceCulling : true
  if (opts.alpha !== undefined) {
    mat.alpha = opts.alpha
    if (opts.alpha < 1) mat.transparencyMode = Material.MATERIAL_ALPHABLEND
  }
  if (opts.zOffset !== undefined) mat.zOffset = opts.zOffset
  if (opts.diffuseColor) mat.diffuseColor = opts.diffuseColor
  if (opts.diffuseTexture) mat.diffuseTexture = opts.diffuseTexture
  return mat
}

export function buildTerrainMeshes(map: MapData, waterTexture: Texture | null, shadowInf: number[][] | null, scene: Scene): TransformNode {
  _initVertexCache(map, { startX: 0, startZ: 0, endX: map.width, endZ: map.height }, true)
  const waterFlowTransformCache = new Map<string, WaterFlowUvTransform>()

  const landVertices: number[] = []
  const landColors: number[] = []
  const landUVs: number[] = []
  const landIndices: number[] = []

  const waterVertices: number[] = []
  const waterColors: number[] = []
  const waterUVs: number[] = []
  const waterIndices: number[] = []

  let landBase = 0
  let waterBase = 0

  const newTileOff = new Int32Array(map.width * map.height)

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      newTileOff[z * map.width + x] = landBase
      if (!map.isTileInActiveChunk(x, z)) continue
      const h = map.getTileCornerHeights(x, z)
      const landType = map.getBaseGroundType(x, z) as GroundType
      if (landType === 'void') continue

      landBase += addTileGeometry(
        landVertices, landColors, landUVs, landIndices,
        landBase, landType, h, x, z, map, shadowInf
      )

      if (_cvShouldRenderWater(map, x, z)) {
        const wY = map.getTileWaterLevel(x, z) + 0.02
        const wc = WATER_SURFACE_VERTEX_COLOR
        waterVertices.push(x, wY, z,  x+1, wY, z,  x, wY, z+1,  x+1, wY, z+1)
        waterColors.push(wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1)
        pushWaterUvs(map, x, z, waterUVs, waterFlowTransformCache)
        waterIndices.push(waterBase, waterBase+2, waterBase+1, waterBase+2, waterBase+3, waterBase+1)
        waterBase += 4
      }
    }
  }

  // Surface water pass (rice paddies, flooded fields)
  const swVertices: number[] = []
  const swColors: number[] = []
  const swUVs: number[] = []
  const swIndices: number[] = []
  let swBase = 0

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      if (!map.isTileInActiveChunk(x, z)) continue
      const tile = map.getTile(x, z)
      if (tile?.ground === 'void') continue
      swBase = appendSurfaceWaterTile(map, x, z, swVertices, swColors, swUVs, swIndices, swBase, waterFlowTransformCache)
    }
  }

  const group = new TransformNode('terrain-group', scene)
  group.setEnabled(false)

  _landTileOff = newTileOff
  _landMapW    = map.width
  _landMapH    = map.height
  _landPosBuf  = new Float32Array(landVertices)
  _landColBuf  = new Float32Array(landColors)

  if (landVertices.length > 0) {
    const landMesh = createMeshFromArrays('terrain-land', landVertices, landColors, landUVs, landIndices, scene, true)
    const landMat = createLambertMaterial('terrain-land-mat', scene, { backFaceCulling: false })
    landMat.emissiveColor = new Color3(0.2, 0.2, 0.2)
    landMesh.material = landMat
    // convertToFlatShadedMesh used to run here for the per-face normals look,
    // but it un-indexes the mesh (multiplies vertex count ~3×) and the cached
    // _landPosBuf / _landColBuf / _landTileOff in this module still describe
    // the original indexed layout. The fast-path updateTerrainLandHeights then
    // wrote the small buffer through updateVerticesData, GPU vertex count >
    // buffer length, and most tiles ended up with stale or zeroed data — the
    // "every other tile missing" checkerboard the user reported on paint.
    // Picking the mesh after that also threw RangeError in Babylon's
    // _generatePointsArray when it tried to read back the inconsistent vertex
    // buffer. With smooth-shaded normals the terrain still reads the per-tile
    // vertex colors as distinct "facets" because adjacent tiles use different
    // base shades. If the flat-shaded silhouette is wanted later, bake the
    // un-indexed layout into landVertices/landIndices at build time so the
    // cached buffers match the GPU layout.
    landMesh.isPickable = false
    landMesh.parent = group
    _landMesh = landMesh
  }

  if (waterVertices.length > 0) {
    const waterMesh = createMeshFromArrays('terrain-water', waterVertices, waterColors, waterUVs, waterIndices, scene)
    const waterMat = createLambertMaterial('terrain-water-mat', scene, {
      backFaceCulling: false,
      alpha: WATER_TEXTURE_ALPHA,
      zOffset: -1,
      diffuseColor: waterTexture ? rgbToColor3(WATER_TEXTURE_TINT) : rgbToColor3(WATER_FALLBACK_TINT),
    })
    if (waterTexture) {
      waterTexture.wrapU = Texture.WRAP_ADDRESSMODE
      waterTexture.wrapV = Texture.WRAP_ADDRESSMODE
      waterMat.diffuseTexture = waterTexture
    }
    waterMesh.material = waterMat
    waterMesh.hasVertexAlpha = false
    waterMesh.isPickable = false
    waterMesh.parent = group
  }

  if (swVertices.length > 0) {
    const swMesh = createMeshFromArrays('terrain-surface-water', swVertices, swColors, swUVs, swIndices, scene)
    let swTex: Texture | null = null
    if (waterTexture) {
      swTex = waterTexture.clone()
      swTex.wrapU = Texture.WRAP_ADDRESSMODE
      swTex.wrapV = Texture.WRAP_ADDRESSMODE
    }
    const swMat = createLambertMaterial('terrain-sw-mat', scene, {
      backFaceCulling: false,
      alpha: SURFACE_WATER_ALPHA,
      zOffset: -2,
      diffuseColor: swTex ? rgbToColor3(SURFACE_WATER_TEXTURE_TINT) : rgbToColor3(SURFACE_WATER_FALLBACK_TINT),
    })
    if (swTex) swMat.diffuseTexture = swTex
    swMesh.material = swMat
    swMesh.hasVertexAlpha = false
    swMesh.isPickable = false
    swMesh.parent = group
  }

  return group
}

export function buildWaterMeshes(map: MapData, waterTexture: Texture | null, scene: Scene): TransformNode {
  const group = new TransformNode('terrain-water-group', scene)
  group.setEnabled(false)
  const waterFlowTransformCache = new Map<string, WaterFlowUvTransform>()

  const waterVertices: number[] = []
  const waterColors: number[] = []
  const waterUVs: number[] = []
  const waterIndices: number[] = []
  let waterBase = 0

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      if (!map.isTileInActiveChunk(x, z)) continue
      if (map.getBaseGroundType(x, z) === 'void') continue
      if (!shouldRenderWater(map, x, z)) continue
      const wY = map.getTileWaterLevel(x, z) + 0.02
      const wc = WATER_SURFACE_VERTEX_COLOR
      waterVertices.push(x, wY, z,  x+1, wY, z,  x, wY, z+1,  x+1, wY, z+1)
      waterColors.push(wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1, wc.r, wc.g, wc.b, 1)
      pushWaterUvs(map, x, z, waterUVs, waterFlowTransformCache)
      waterIndices.push(waterBase, waterBase+2, waterBase+1, waterBase+2, waterBase+3, waterBase+1)
      waterBase += 4
    }
  }

  if (waterVertices.length > 0) {
    const mesh = createMeshFromArrays('terrain-water', waterVertices, waterColors, waterUVs, waterIndices, scene)
    if (waterTexture) {
      waterTexture.wrapU = Texture.WRAP_ADDRESSMODE
      waterTexture.wrapV = Texture.WRAP_ADDRESSMODE
    }
    const mat = createLambertMaterial('terrain-water-mat', scene, {
      backFaceCulling: false,
      alpha: WATER_TEXTURE_ALPHA,
      zOffset: -1,
      diffuseColor: waterTexture ? rgbToColor3(WATER_TEXTURE_TINT) : rgbToColor3(WATER_FALLBACK_TINT),
    })
    if (waterTexture) mat.diffuseTexture = waterTexture
    mesh.material = mat
    mesh.hasVertexAlpha = false
    mesh.isPickable = false
    mesh.parent = group
  }

  const swVertices: number[] = [], swColors: number[] = [], swUVs: number[] = [], swIndices: number[] = []
  let swBase = 0
  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      if (!map.isTileInActiveChunk(x, z)) continue
      const tile = map.getTile(x, z)
      if (tile?.ground === 'void') continue
      swBase = appendSurfaceWaterTile(map, x, z, swVertices, swColors, swUVs, swIndices, swBase, waterFlowTransformCache)
    }
  }

  if (swVertices.length > 0) {
    const mesh = createMeshFromArrays('terrain-surface-water', swVertices, swColors, swUVs, swIndices, scene)
    let swTex: Texture | null = null
    if (waterTexture) {
      swTex = waterTexture.clone()
      swTex.wrapU = Texture.WRAP_ADDRESSMODE
      swTex.wrapV = Texture.WRAP_ADDRESSMODE
    }
    const mat = createLambertMaterial('terrain-sw-mat', scene, {
      backFaceCulling: false,
      alpha: SURFACE_WATER_ALPHA,
      zOffset: -2,
      diffuseColor: swTex ? rgbToColor3(SURFACE_WATER_TEXTURE_TINT) : rgbToColor3(SURFACE_WATER_FALLBACK_TINT),
    })
    if (swTex) mat.diffuseTexture = swTex
    mesh.material = mat
    mesh.hasVertexAlpha = false
    mesh.isPickable = false
    mesh.parent = group
  }

  return group
}

export function buildCliffMeshes(map: MapData, scene: Scene): Mesh | null {
  const vertices: number[] = []
  const indices: number[] = []
  const colors: number[] = []
  let base = 0

  function cliffColor(topY: number, bottomY: number): RGB {
    const drop = Math.max(0, topY - bottomY)
    const shade = clamp(0.92 - drop * 0.12, 0.42, 0.92)
    return { r: 0.37 * shade, g: 0.29 * shade, b: 0.12 * shade }
  }

  function pushColoredQuad(a: number[], b: number[], c: number[], d: number[], color: RGB): void {
    vertices.push(...a, ...b, ...c, ...d)
    for (let i = 0; i < 4; i++) {
      colors.push(color.r, color.g, color.b, 1.0)
    }
    indices.push(
      base + 0, base + 2, base + 1,
      base + 2, base + 3, base + 1
    )
    base += 4
  }

  function addVerticalFace(x1: number, z1: number, top1: number, top2: number, bottom1: number, bottom2: number, isXAxisFace: boolean): void {
    const eps = 0.01
    const color = cliffColor((top1 + top2) * 0.5, (bottom1 + bottom2) * 0.5)

    if (isXAxisFace) {
      pushColoredQuad(
        [x1, top1, z1],
        [x1, top2, z1 + 1],
        [x1, bottom1 + eps, z1],
        [x1, bottom2 + eps, z1 + 1],
        color
      )
    } else {
      pushColoredQuad(
        [x1, top1, z1],
        [x1 + 1, top2, z1],
        [x1, bottom1 + eps, z1],
        [x1 + 1, bottom2 + eps, z1],
        color
      )
    }
  }

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      if (!map.isTileInActiveChunk(x, z)) continue
      const h = map.getTileCornerHeights(x, z)
      const wLevel = map.getTileWaterLevel(x, z)

      const rightTile = map.getTile(x + 1, z)
      if (rightTile) {
        const rh = map.getTileCornerHeights(x + 1, z)
        const aTop1 = h.tr, aTop2 = h.br
        const bTop1 = rh.tl, bTop2 = rh.bl
        const avgA = (aTop1 + aTop2) * 0.5
        const avgB = (bTop1 + bTop2) * 0.5
        if (Math.abs(avgA - avgB) > 0.01 && Math.max(avgA, avgB) > wLevel) {
          if (avgA > avgB) {
            addVerticalFace(x + 1, z, aTop1, aTop2, bTop1, bTop2, true)
          } else {
            addVerticalFace(x + 1, z, bTop1, bTop2, aTop1, aTop2, true)
          }
        }
      }

      const downTile = map.getTile(x, z + 1)
      if (downTile) {
        const dh = map.getTileCornerHeights(x, z + 1)
        const aTop1 = h.bl, aTop2 = h.br
        const bTop1 = dh.tl, bTop2 = dh.tr
        const avgA = (aTop1 + aTop2) * 0.5
        const avgB = (bTop1 + bTop2) * 0.5
        if (Math.abs(avgA - avgB) > 0.01 && Math.max(avgA, avgB) > wLevel) {
          if (avgA > avgB) {
            addVerticalFace(x, z + 1, aTop1, aTop2, bTop1, bTop2, false)
          } else {
            addVerticalFace(x, z + 1, bTop1, bTop2, aTop1, aTop2, false)
          }
        }
      }
    }
  }

  if (vertices.length === 0) return null

  const mesh = createMeshFromArrays('cliffs', vertices, colors, null, indices, scene)
  const mat = createLambertMaterial('cliffs-mat', scene, { backFaceCulling: false })
  mesh.material = mat
  mesh.hasVertexAlpha = true
  mesh.isPickable = false
  mesh.setEnabled(false)
  return mesh
}


export function updateTerrainLandHeights(map: MapData, shadowInf: number[][] | null, x1: number, z1: number, x2: number, z2: number): boolean {
  // Fast-path is incompatible with convertToFlatShadedMesh: that call un-
  // indexes the mesh (~3× the vertex count) so each face can carry its own
  // normal, but our cached _landPosBuf / _landColBuf / _landTileOff still
  // describe the original indexed layout. Writing the small buffers through
  // updateVerticesData only refreshes the first ~1/3 of the GPU vertices —
  // the rest stay stale, which renders as a checkerboard "every other tile
  // missing" pattern after a paint. Detect the size mismatch and bail to the
  // full rebuild path, which builds a fresh mesh with consistent state.
  if (_landMesh) {
    const meshVerts = _landMesh.getTotalVertices();
    const bufVerts = _landPosBuf ? _landPosBuf.length / 3 : 0;
    if (meshVerts !== bufVerts) return false;
  }
  if (!_landMesh || !_landTileOff || _landMapW !== map.width || _landMapH !== map.height) return false

  const margin = Math.ceil(TORCHLIGHT_GLOW_RADIUS_TILES)
  const rx1 = Math.max(0, x1 - margin)
  const rz1 = Math.max(0, z1 - margin)
  const rx2 = Math.min(map.width - 1, x2 + margin)
  const rz2 = Math.min(map.height - 1, z2 + margin)

  updateTorchlightPaintIndexRegion(map, x1, z1, x2, z2)
  _initVertexCache(map, { startX: rx1, startZ: rz1, endX: rx2 + 1, endZ: rz2 + 1 })

  const tmpV: number[] = [], tmpC: number[] = [], tmpU: number[] = [], tmpI: number[] = []

  for (let z = rz1; z <= rz2; z++) {
    for (let x = rx1; x <= rx2; x++) {
      if (!map.isTileInActiveChunk(x, z)) continue
      const off = _landTileOff[z * map.width + x]
      const h = map.getTileCornerHeights(x, z)
      const landType = map.getBaseGroundType(x, z) as GroundType

      const tileIdx = z * map.width + x
      const nextOff = (tileIdx + 1 < map.width * map.height) ? _landTileOff[tileIdx + 1] : (_landPosBuf!.length / 3)
      const allocatedVerts = nextOff - off

      tmpV.length = 0; tmpC.length = 0; tmpU.length = 0; tmpI.length = 0
      const vertCount = addTileGeometry(tmpV, tmpC, tmpU, tmpI, 0, landType, h, x, z, map, shadowInf)

      if (vertCount !== allocatedVerts) return false

      const posBase = off * 3
      for (let i = 0; i < vertCount * 3; i++) {
        _landPosBuf![posBase + i] = tmpV[i]
      }
      const colBase = off * 4
      for (let i = 0; i < vertCount * 4; i++) {
        _landColBuf![colBase + i] = tmpC[i]
      }
    }
  }

  _landMesh.updateVerticesData(VertexBuffer.PositionKind, _landPosBuf!)
  _landMesh.updateVerticesData(VertexBuffer.ColorKind, _landColBuf!)
  return true
}

/**
 * Get or create the shared StandardMaterial for a texture overlay. Per-scene
 * cache — without it, a 256×256 map with 30% painted tiles allocates ~20K
 * materials on every rebuild, and per-tile dispose() leaks the materials.
 *
 * `emissiveLevel` controls the matte-on-terrain look: full-rebuild path uses
 * 0.45 (richer baked-in lighting), single-tile incremental rebuild uses 0.18
 * (dimmer to match the surrounding terrain shading). Keep the caches separate
 * if you need both levels live at the same scene — the cache key is just the
 * texture id and would alias otherwise.
 */
export function getOrCreateOverlayMaterial(
  textureId: string,
  textureRegistry: TextureEntry[],
  textureCache: Map<string, Texture>,
  scene: Scene,
  materialCache: Map<string, StandardMaterial>,
  emissiveLevel: number,
): StandardMaterial | null {
  let mat = materialCache.get(textureId)
  if (mat) return mat
  const textureInfo = textureRegistry.find((t) => t.id === textureId)
  if (!textureInfo) return null
  const texture = textureCache.get(textureInfo.id)
  if (!texture) return null
  texture.wrapU = Texture.WRAP_ADDRESSMODE
  texture.wrapV = Texture.WRAP_ADDRESSMODE
  mat = new StandardMaterial(`texoverlay_mat_${textureId}`, scene)
  mat.diffuseTexture = texture
  mat.diffuseColor = new Color3(0.82, 0.82, 0.82)
  mat.emissiveTexture = texture
  mat.emissiveColor = new Color3(emissiveLevel, emissiveLevel, emissiveLevel)
  mat.specularColor = new Color3(0, 0, 0)
  mat.useAlphaFromDiffuseTexture = true
  mat.transparencyMode = 1
  mat.backFaceCulling = false
  mat.zOffset = -2
  materialCache.set(textureId, mat)
  return mat
}

/**
 * Build all texture overlay meshes for the map. `materialCache` is shared
 * across rebuilds so materials are created once per distinct texture rather
 * than once per tile. See [[getOrCreateOverlayMaterial]].
 *
 * `meshesByTile`, when provided, is populated with `${x},${z}` → Mesh[] so
 * that incremental single-tile rebuilds (editor's updateTileTextureOverlay)
 * can dispose just the affected meshes in O(1) instead of scanning the
 * entire overlay group's children.
 */
export function buildTextureOverlays(
  map: MapData,
  textureRegistry: TextureEntry[],
  textureCache: Map<string, Texture>,
  scene: Scene,
  materialCache: Map<string, StandardMaterial> = new Map(),
  meshesByTile?: Map<string, Mesh[]>,
): TransformNode {
  const group = new TransformNode('texture-overlays', scene)
  group.setEnabled(false)

  const getMaterial = (textureId: string): StandardMaterial | null =>
    getOrCreateOverlayMaterial(textureId, textureRegistry, textureCache, scene, materialCache, 0.45)

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      if (!map.isTileInActiveChunk(x, z)) continue
      const tile = map.getTile(x, z)
      if (tile?.ground === 'void') continue
      if (!tile || (!tile.textureId && !tile.textureIdB)) continue

      const h = map.getTileCornerHeights(x, z)
      const overlayOffset = 0.008

      const addPolygon = (
        textureId: string,
        rotation: number,
        scale: number,
        worldUV: boolean,
        ring: readonly UVPoint[],
      ): void => {
        if (ring.length < 3) return
        const mat = getMaterial(textureId)
        if (!mat) return

        const positions: number[] = []
        const uvs: number[] = []
        const s = Math.max(0.1, scale)
        const r = ((rotation % 4) + 4) % 4
        for (const p of ring) {
          const wx = x + p.u
          const wz = z + p.v
          const wy = bilerpCorners(h.tl, h.tr, h.bl, h.br, p.u, p.v) + overlayOffset
          positions.push(wx, wy, wz)
          if (worldUV) {
            uvs.push(wx / s, wz / s)
          } else {
            const [tu, tv] = transformOverlayUV(p.u, p.v, r, s)
            uvs.push(tu, tv)
          }
        }
        const indices = fanTriangulate(ring.length)

        const mesh = createMeshFromArrays(`texoverlay_${x}_${z}`, positions, null, uvs, indices, scene)
        mesh.material = mat
        mesh.isPickable = false
        mesh.parent = group
        if (meshesByTile) {
          const key = `${x},${z}`
          let list = meshesByTile.get(key)
          if (!list) { list = []; meshesByTile.set(key, list) }
          list.push(mesh)
        }
      }

      if (tile.textureHalfMode) {
        const { halfA, halfB } = computeCutPolygons(tile.textureCutAngle, tile.textureCutOffset ?? 0)
        if (tile.textureId) addPolygon(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, halfA)
        if (tile.textureIdB) addPolygon(tile.textureIdB, tile.textureRotationB, tile.textureScaleB, false, halfB)
      } else if (tile.textureId) {
        addPolygon(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, fullTileRingForSplit(tile.split))
      }
    }
  }

  return group
}

function texturePlaneTintKey(tint: { r: number; g: number; b: number }): string {
  return `${tint.r.toFixed(3)},${tint.g.toFixed(3)},${tint.b.toFixed(3)}`
}

function getOrCreateTexturePlaneMaterial(
  planeId: string,
  textureId: string,
  repeat: number,
  rotation: number,
  tint: { r: number; g: number; b: number },
  suffix: string,
  textureRegistry: TextureEntry[],
  textureCache: Map<string, Texture>,
  scene: Scene,
  materialCache?: Map<string, StandardMaterial>,
): StandardMaterial | null {
  const info = textureRegistry.find((t) => t.id === textureId)
  if (!info) return null
  const src = textureCache.get(info.id)
  if (!src) return null

  const scale = repeat || 1
  const rot = rotation || 0
  const key = `${textureId}|${scale}|${rot}|${texturePlaneTintKey(tint)}|${suffix}`
  const cached = materialCache?.get(key)
  if (cached) return cached

  const tex = src.clone()
  tex.wrapU = Texture.WRAP_ADDRESSMODE
  tex.wrapV = Texture.WRAP_ADDRESSMODE
  tex.uScale = 1 / scale
  tex.vScale = 1 / scale
  tex.wAng = rot * Math.PI / 2
  tex.hasAlpha = true

  const mat = new StandardMaterial(`texplane_mat_${materialCache ? key : `${planeId}_${suffix}`}`, scene)
  mat.diffuseTexture = tex
  mat.emissiveTexture = tex
  mat.useAlphaFromDiffuseTexture = true
  mat.diffuseColor = new Color3(0, 0, 0)
  mat.emissiveColor = new Color3(tint.r, tint.g, tint.b)
  mat.specularColor = new Color3(0, 0, 0)
  mat.transparencyMode = 1
  mat.alphaCutOff = 0.05
  mat.zOffset = -1
  mat.freeze()
  materialCache?.set(key, mat)
  return mat
}

export function buildSingleTexturePlane(
  plane: TexturePlane,
  textureRegistry: TextureEntry[],
  textureCache: Map<string, Texture>,
  scene: Scene,
  _isSelected: boolean = false,
  materialCache?: Map<string, StandardMaterial>,
): Mesh | null {
  const textureInfo = textureRegistry.find((t) => t.id === plane.textureId)
  if (!textureInfo) return null

  const textureSrc = textureCache.get(textureInfo.id)
  if (!textureSrc) return null

  const tint = plane.tintColor || { r: 1, g: 1, b: 1 }

  const makeMaterial = (textureId: string, repeat: number, rotation: number, suffix: string) =>
    getOrCreateTexturePlaneMaterial(plane.id, textureId, repeat, rotation, tint, suffix, textureRegistry, textureCache, scene, materialCache)

  if (plane.textureHalfMode) {
    const root = new TransformNode(`texplane_${plane.id}`, scene)
    root.position.set(plane.position?.x ?? 0, plane.position?.y ?? 0, plane.position?.z ?? 0)
    root.rotation.set(plane.rotation?.x ?? 0, plane.rotation?.y ?? 0, plane.rotation?.z ?? 0)
    root.scaling.set(plane.scale?.x ?? 1, plane.scale?.y ?? 1, plane.scale?.z ?? 1)
    root.metadata = { texturePlane: plane }

    const makeHalfMesh = (textureId: string | null | undefined, repeat: number, rotation: number, ring: { u: number; v: number }[], suffix: string) => {
      if (!textureId || ring.length < 3) return
      const mat = makeMaterial(textureId, repeat, rotation, suffix)
      if (!mat) return
      const positions: number[] = []
      const uvs: number[] = []
      for (const p of ring) {
        positions.push((p.u - 0.5) * Math.max(0.01, plane.width || 1), (p.v - 0.5) * Math.max(0.01, plane.height || 1), 0)
        uvs.push(p.u, p.v)
      }
      const indices = fanTriangulate(ring.length)
      const mesh = createMeshFromArrays(`texplane_${plane.id}_${suffix}`, positions, null, uvs, indices, scene)
      mesh.material = mat
      mesh.renderingGroupId = 0
      mesh.metadata = { texturePlane: plane, texturePlaneRoot: root }
      mesh.parent = root
      mesh.freezeWorldMatrix()
    }

    const { halfA } = computeCutPolygons(plane.textureCutAngle ?? Math.PI / 4)
    makeHalfMesh(plane.textureId, plane.uvRepeat || 1, plane.texRotation || 0, halfA, 'a')
    root.freezeWorldMatrix()
    return root as unknown as Mesh
  }

  const scale = plane.uvRepeat || 1

  const mesh = MeshBuilder.CreatePlane(`texplane_${plane.id}`, {
    width: Math.max(0.01, plane.width || 1),
    height: Math.max(0.01, plane.height || 1),
    sideOrientation: Mesh.DOUBLESIDE
  }, scene)

  const mat = getOrCreateTexturePlaneMaterial(plane.id, plane.textureId, scale, plane.texRotation || 0, tint, 'full', textureRegistry, textureCache, scene, materialCache)
  if (!mat) {
    mesh.dispose()
    return null
  }
  mesh.material = mat

  mesh.position.set(plane.position?.x ?? 0, plane.position?.y ?? 0, plane.position?.z ?? 0)
  mesh.rotation.set(plane.rotation?.x ?? 0, plane.rotation?.y ?? 0, plane.rotation?.z ?? 0)
  mesh.scaling.set(plane.scale?.x ?? 1, plane.scale?.y ?? 1, plane.scale?.z ?? 1)
  mesh.renderingGroupId = 0
  mesh.metadata = { texturePlane: plane }
  mesh.freezeWorldMatrix()

  return mesh
}

export function buildTexturePlanes(map: MapData, textureRegistry: TextureEntry[], textureCache: Map<string, Texture>, scene: Scene, materialCache?: Map<string, StandardMaterial>): TransformNode {
  const group = new TransformNode('texture-planes', scene)
  group.setEnabled(false)

  for (const plane of map.texturePlanes) {
    const mesh = buildSingleTexturePlane(plane, textureRegistry, textureCache, scene, false, materialCache)
    if (mesh) mesh.parent = group
  }

  return group
}
