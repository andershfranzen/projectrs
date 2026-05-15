import { TileType, WallEdge } from '@projectrs/shared';
import type { ChunkManager } from '../rendering/ChunkManager';

const INTERACTIVE_CATEGORIES = new Set([
  'tree', 'rock', 'fishingspot', 'furnace', 'cookingrange',
  'anvil', 'altar', 'door', 'chest',
]);

export interface MinimapObject { x: number; z: number; category: string; }

const TILE_COLORS: Record<number, [number, number, number]> = {
  [TileType.GRASS]: [0x3e, 0x8c, 0x2e],
  [TileType.DIRT]:  [0x8a, 0x68, 0x3c],
  [TileType.STONE]: [0x82, 0x7c, 0x72],
  [TileType.WATER]: [0x2c, 0x58, 0x8e],
  [TileType.SAND]:  [0xc4, 0xaa, 0x6a],
  [TileType.WOOD]:  [0x74, 0x52, 0x30],
  [TileType.MUD]:   [0x3e, 0x8c, 0x2e],
};
const ROOF_COLOR: [number, number, number] = [0x60, 0x40, 0x22];
const FLOOR_COLOR: [number, number, number] = [0x8a, 0x74, 0x52];

const VIEW_RADIUS = 22;
// Render buffer matches displaySize 1:1 for crisp pixels. Keep this in sync
// with the displaySize passed to `new Minimap(...)` in GameManager.
const RENDER_SIZE = 260;

export class Minimap {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private offCanvas: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private imageData: ImageData;

  private destX: number | null = null;
  private destZ: number | null = null;
  private destBlinkTimer: number = 0;

  private onClickMove: ((worldX: number, worldZ: number) => void) | null = null;

  private lastPlayerX: number = 0;
  private lastPlayerZ: number = 0;
  private hasLastPlayerPosition: boolean = false;
  private headingDx: number = 0;
  private headingDz: number = -1;
  private lastScale: number = 1;
  private lastAlpha: number = 0;

  private cachedFloorX: number = Number.NaN;
  private cachedFloorZ: number = Number.NaN;
  private cachedStartX: number = 0;
  private cachedStartZ: number = 0;

  private tileColorBuf: Uint8Array;
  private readonly tileSize: number;

  constructor(displaySize: number = RENDER_SIZE) {
    this.tileSize = VIEW_RADIUS * 2;

    this.canvas = document.createElement('canvas');
    this.canvas.width = RENDER_SIZE;
    this.canvas.height = RENDER_SIZE;
    // Fixed pixel size (matches RENDER_SIZE 1:1 — crisp, no scaling artifacts).
    // Smaller than the right column so it centers with horizontal margin.
    this.canvas.style.cssText = `
      width: ${displaySize}px; height: ${displaySize}px;
      display: block; margin: 0 auto; cursor: pointer;
      border: 4px solid #2c251e;
      border-radius: 50%;
      box-shadow:
        0 0 0 1px #090706,
        0 0 0 3px #5c5549,
        0 0 0 5px #18130f,
        inset 0 0 0 2px rgba(255,220,160,0.08),
        inset 0 0 13px rgba(0,0,0,0.72),
        2px 3px 5px rgba(0,0,0,0.42);
      background: #0c0a06;
      image-rendering: pixelated;
    `;

    this.ctx = this.canvas.getContext('2d', { alpha: false })!;
    const mount = document.getElementById('ui-right-column');
    (mount ?? document.body).appendChild(this.canvas);

    this.offCanvas = document.createElement('canvas');
    this.offCanvas.width = RENDER_SIZE;
    this.offCanvas.height = RENDER_SIZE;
    this.offCtx = this.offCanvas.getContext('2d')!;
    this.imageData = this.offCtx.createImageData(RENDER_SIZE, RENDER_SIZE);
    this.tileColorBuf = new Uint8Array(this.tileSize * this.tileSize * 4);

    this.canvas.addEventListener('click', (e) => this.handleClick(e));
  }

  setClickMoveHandler(handler: (worldX: number, worldZ: number) => void): void {
    this.onClickMove = handler;
  }

  invalidateTileCache(): void {
    this.cachedFloorX = Number.NaN;
    this.cachedFloorZ = Number.NaN;
  }

  setDestination(worldX: number, worldZ: number): void {
    this.destX = worldX;
    this.destZ = worldZ;
    this.destBlinkTimer = 0;
  }

  clearDestination(): void {
    this.destX = null;
    this.destZ = null;
  }

  dispose(): void {
    this.canvas.remove();
  }

  private handleClick(e: MouseEvent): void {
    if (!this.onClickMove) return;
    const rect = this.canvas.getBoundingClientRect();
    const scaleX = RENDER_SIZE / rect.width;
    const scaleY = RENDER_SIZE / rect.height;
    const px = (e.clientX - rect.left) * scaleX;
    const pz = (e.clientY - rect.top) * scaleY;
    const center = RENDER_SIZE / 2;

    const relX = -(px - center);
    const relZ = -(pz - center);
    const angle = this.lastAlpha + Math.PI / 2;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);

    const worldX = this.lastPlayerX + (relX * cosA - relZ * sinA) / this.lastScale;
    const worldZ = this.lastPlayerZ + (relX * sinA + relZ * cosA) / this.lastScale;
    this.onClickMove(worldX, worldZ);
  }

  update(
    playerX: number,
    playerZ: number,
    remotePlayers: { x: number; z: number }[],
    npcs: { x: number; z: number }[],
    chunkManager: ChunkManager,
    cameraAlpha: number = 0,
    worldObjects: MinimapObject[] = [],
    dt: number = 1 / 60,
  ): void {
    const tileSize = this.tileSize;
    const pxPerTile = RENDER_SIZE / tileSize;
    const floorX = Math.floor(playerX) - VIEW_RADIUS;
    const floorZ = Math.floor(playerZ) - VIEW_RADIUS;

    let startX: number;
    let startZ: number;

    if (floorX !== this.cachedFloorX || floorZ !== this.cachedFloorZ) {
      this.cachedFloorX = floorX;
      this.cachedFloorZ = floorZ;
      startX = floorX;
      startZ = floorZ;
      this.cachedStartX = startX;
      this.cachedStartZ = startZ;

      const queried = chunkManager.getTilesForMinimap(playerX, playerZ, VIEW_RADIUS);
      const tiles = queried.tiles;
      const walls = queried.walls;
      const roofs = queried.roofs;
      const textured = queried.textured;
      const voidTiles = queried.voidTiles;
      const overrideColors = queried.overrideColors;
      const hasOverride = queried.hasOverride;
      const tcBuf = this.tileColorBuf;

      const clamp = (v: number) => v < 0 ? 0 : v > 255 ? 255 : v | 0;
      const tileHash = (x: number, z: number): number => {
        const h = (x * 73856093) ^ (z * 19349663);
        return ((h & 0xff) / 255) * 6 - 3;
      };

      // Pre-fetch vertex heights into a grid for per-pixel hillshading
      const hGridW = tileSize + 1;
      const heights = new Float32Array(hGridW * hGridW);
      for (let vz = 0; vz < hGridW; vz++) {
        for (let vx = 0; vx < hGridW; vx++) {
          heights[vz * hGridW + vx] = chunkManager.getVertexHeight(startX + vx, startZ + vz);
        }
      }

      // Pass 1: base color per tile (tile type + subtle noise, NO height shading)
      for (let dz = 0; dz < tileSize; dz++) {
        for (let dx = 0; dx < tileSize; dx++) {
          const tIdx = dz * tileSize + dx;
          const cIdx = tIdx * 4;

          if (voidTiles[tIdx]) {
            tcBuf[cIdx] = 0; tcBuf[cIdx + 1] = 0; tcBuf[cIdx + 2] = 0; tcBuf[cIdx + 3] = 255;
            continue;
          }

          const tileType = tiles[tIdx];

          const wallMask = walls[tIdx];
          const isCollision = tileType === TileType.WALL
            || (wallMask & 5) === 5    // N+S opposing walls (thick wall interior)
            || (wallMask & 10) === 10; // E+W opposing walls

          const isRoofed = !isCollision && roofs[tIdx] === 1;
          const isTextured = !isCollision && textured[tIdx] === 1;
          // Color priority (lowest → highest): tile-type → FLOOR_COLOR (textured
          // but unsampled) → sampled override → roof → collision.
          let base: [number, number, number] = TILE_COLORS[tileType] ?? TILE_COLORS[TileType.GRASS];
          if (isTextured) base = FLOOR_COLOR;
          if (hasOverride[tIdx] === 1) {
            const oOff = tIdx * 3;
            base = [overrideColors[oOff], overrideColors[oOff + 1], overrideColors[oOff + 2]];
          }
          if (isRoofed) base = ROOF_COLOR;
          if (isCollision) base = TILE_COLORS[TileType.GRASS];
          const wx = startX + dx;
          const wz = startZ + dz;
          const noise = tileHash(wx, wz);

          if (tileType === TileType.WATER) {
            const wn = tileHash(wx * 3, wz * 7);
            tcBuf[cIdx]     = clamp(base[0] + wn * 0.5);
            tcBuf[cIdx + 1] = clamp(base[1] + wn * 0.3);
            tcBuf[cIdx + 2] = clamp(base[2] + wn * 0.2);
          } else {
            tcBuf[cIdx]     = clamp(base[0] + noise);
            tcBuf[cIdx + 1] = clamp(base[1] + noise);
            tcBuf[cIdx + 2] = clamp(base[2] + noise);
          }
          tcBuf[cIdx + 3] = 255;
        }
      }

      // Flatten vertex heights around collision tiles so hillshade doesn't create visible blocks
      for (let dz = 0; dz < tileSize; dz++) {
        for (let dx = 0; dx < tileSize; dx++) {
          const tIdx = dz * tileSize + dx;
          if (voidTiles[tIdx]) continue;
          const tileType = tiles[tIdx];
          const wallMask = walls[tIdx];
          if (tileType === TileType.WALL
            || (wallMask & 5) === 5
            || (wallMask & 10) === 10
          ) {
            let sum = 0, cnt = 0;
            for (let nz = -1; nz <= 1; nz++) {
              for (let nx = -1; nx <= 1; nx++) {
                const ndx = dx + nx, ndz = dz + nz;
                if (ndx < 0 || ndx >= tileSize || ndz < 0 || ndz >= tileSize) continue;
                const nIdx = ndz * tileSize + ndx;
                const nt = tiles[nIdx];
                const nw = walls[nIdx];
                if (nt !== TileType.WALL && (nw & 5) !== 5 && (nw & 10) !== 10) {
                  sum += heights[ndz * hGridW + ndx];
                  cnt++;
                }
              }
            }
            const avg = cnt > 0 ? sum / cnt : 0;
            heights[dz * hGridW + dx] = avg;
            heights[dz * hGridW + dx + 1] = avg;
            heights[(dz + 1) * hGridW + dx] = avg;
            heights[(dz + 1) * hGridW + dx + 1] = avg;
          }
        }
      }

      // Pass 2: per-pixel render — bilinear color blend + continuous hillshade
      const data = this.imageData.data;
      data.fill(0);

      const getTileColor = (tx: number, tz: number): number => {
        if (tx < 0 || tx >= tileSize || tz < 0 || tz >= tileSize) return -1;
        const idx = (tz * tileSize + tx) * 4;
        if (tcBuf[idx + 3] === 0) return -1;
        return idx;
      };

      for (let py = 0; py < RENDER_SIZE; py++) {
        // Color interpolation coordinates (centered on tiles)
        const colorFtZ = py / pxPerTile - 0.5;
        const cTz0 = Math.floor(colorFtZ);
        const cTz1 = cTz0 + 1;
        const cFz = colorFtZ - cTz0;

        // Height grid coordinates (pixel position in tile-space)
        const htZ = py / pxPerTile;
        const hTz = Math.floor(htZ);
        const hFz = htZ - hTz;
        const hTzClamped = hTz < 0 ? 0 : hTz >= tileSize ? tileSize - 1 : hTz;

        for (let px = 0; px < RENDER_SIZE; px++) {
          const colorFtX = px / pxPerTile - 0.5;
          const cTx0 = Math.floor(colorFtX);
          const cTx1 = cTx0 + 1;
          const cFx = colorFtX - cTx0;

          // Bilinear color blend from 4 nearest tile centers
          const i00 = getTileColor(cTx0, cTz0);
          const i10 = getTileColor(cTx1, cTz0);
          const i01 = getTileColor(cTx0, cTz1);
          const i11 = getTileColor(cTx1, cTz1);

          let r = 0, g = 0, b = 0, tw = 0;
          if (i00 >= 0) { const w = (1 - cFx) * (1 - cFz); r += tcBuf[i00] * w; g += tcBuf[i00 + 1] * w; b += tcBuf[i00 + 2] * w; tw += w; }
          if (i10 >= 0) { const w = cFx * (1 - cFz);       r += tcBuf[i10] * w; g += tcBuf[i10 + 1] * w; b += tcBuf[i10 + 2] * w; tw += w; }
          if (i01 >= 0) { const w = (1 - cFx) * cFz;       r += tcBuf[i01] * w; g += tcBuf[i01 + 1] * w; b += tcBuf[i01 + 2] * w; tw += w; }
          if (i11 >= 0) { const w = cFx * cFz;             r += tcBuf[i11] * w; g += tcBuf[i11 + 1] * w; b += tcBuf[i11 + 2] * w; tw += w; }

          if (tw <= 0) continue;

          const inv = 1 / tw;
          r *= inv; g *= inv; b *= inv;

          // Skip hillshade for water tiles
          const nearTx = Math.round(px / pxPerTile - 0.5);
          const nearTz = Math.round(py / pxPerTile - 0.5);
          const isWater = nearTx >= 0 && nearTx < tileSize && nearTz >= 0 && nearTz < tileSize
            && tiles[nearTz * tileSize + nearTx] === TileType.WATER;

          let hillshade = 0;
          if (!isWater) {
            const htX = px / pxPerTile;
            const hTx = Math.floor(htX);
            const hFx = htX - hTx;
            const hTxClamped = hTx < 0 ? 0 : hTx >= tileSize ? tileSize - 1 : hTx;

            const h00 = heights[hTzClamped * hGridW + hTxClamped];
            const h10 = heights[hTzClamped * hGridW + hTxClamped + 1];
            const h01 = heights[(hTzClamped + 1) * hGridW + hTxClamped];
            const h11 = heights[(hTzClamped + 1) * hGridW + hTxClamped + 1];

            const dhdx = (h10 - h00) * (1 - hFz) + (h11 - h01) * hFz;
            const dhdz = (h01 - h00) * (1 - hFx) + (h11 - h10) * hFx;

            hillshade = (-dhdx * 0.7 - dhdz * 0.7) * 30;
          }

          const pidx = (py * RENDER_SIZE + px) * 4;
          data[pidx]     = clamp(r + hillshade);
          data[pidx + 1] = clamp(g + hillshade);
          data[pidx + 2] = clamp(b + hillshade);
          data[pidx + 3] = 255;
        }
      }

      // Pass 3: wall lines (cream/white, RS2 style)
      const wallThick = Math.max(1, (pxPerTile * 0.22) | 0);
      for (let dz = 0; dz < tileSize; dz++) {
        for (let dx = 0; dx < tileSize; dx++) {
          const mask = walls[dz * tileSize + dx];
          if (!mask) continue;
          if (tiles[dz * tileSize + dx] === TileType.WALL) continue;
          if ((mask & 5) === 5 || (mask & 10) === 10) continue;
          const px0 = (dx * pxPerTile) | 0;
          const pz0 = (dz * pxPerTile) | 0;
          const px1 = ((dx + 1) * pxPerTile) | 0;
          const pz1 = ((dz + 1) * pxPerTile) | 0;
          const setW = (x: number, z: number) => {
            if (x < 0 || x >= RENDER_SIZE || z < 0 || z >= RENDER_SIZE) return;
            const idx = (z * RENDER_SIZE + x) * 4;
            data[idx] = 0xdc; data[idx + 1] = 0xd8; data[idx + 2] = 0xc8; data[idx + 3] = 255;
          };
          if (mask & WallEdge.N) for (let t = 0; t < wallThick; t++) for (let x = px0; x < px1; x++) setW(x, pz0 + t);
          if (mask & WallEdge.S) for (let t = 0; t < wallThick; t++) for (let x = px0; x < px1; x++) setW(x, pz1 - 1 - t);
          if (mask & WallEdge.W) for (let t = 0; t < wallThick; t++) for (let z = pz0; z < pz1; z++) setW(px0 + t, z);
          if (mask & WallEdge.E) for (let t = 0; t < wallThick; t++) for (let z = pz0; z < pz1; z++) setW(px1 - 1 - t, z);
        }
      }

      this.offCtx.putImageData(this.imageData, 0, 0);
    } else {
      startX = this.cachedStartX;
      startZ = this.cachedStartZ;
    }

    const scale = pxPerTile;
    const center = RENDER_SIZE / 2;

    const playerPxX = (playerX - startX) * scale;
    const playerPxZ = (playerZ - startZ) * scale;

    if (this.hasLastPlayerPosition) {
      const moveDx = playerX - this.lastPlayerX;
      const moveDz = playerZ - this.lastPlayerZ;
      if ((moveDx * moveDx + moveDz * moveDz) > 0.0001) {
        this.headingDx = moveDx;
        this.headingDz = moveDz;
      }
    } else {
      this.hasLastPlayerPosition = true;
    }
    this.lastPlayerX = playerX;
    this.lastPlayerZ = playerZ;
    this.lastScale = scale;
    this.lastAlpha = cameraAlpha;

    const ctx = this.ctx;
    ctx.fillStyle = '#0c0a06';
    ctx.fillRect(0, 0, RENDER_SIZE, RENDER_SIZE);

    ctx.save();
    ctx.translate(center, center);
    ctx.scale(-1, -1);
    ctx.rotate(-(cameraAlpha + Math.PI / 2));
    ctx.translate(-playerPxX, -playerPxZ);

    ctx.drawImage(this.offCanvas, 0, 0);

    // World objects — cyan dots (RS Classic style)
    ctx.fillStyle = '#00ffff';
    for (const obj of worldObjects) {
      if (!INTERACTIVE_CATEGORIES.has(obj.category)) continue;
      const relX = (obj.x - startX) * scale;
      const relZ = (obj.z - startZ) * scale;
      ctx.beginPath();
      ctx.arc(relX, relZ, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // NPCs: yellow
    ctx.fillStyle = '#e8e820';
    for (const npc of npcs) {
      ctx.fillRect((npc.x - startX) * scale - 2, (npc.z - startZ) * scale - 2.5, 4, 5);
    }

    // Remote players: white
    ctx.fillStyle = '#ffffff';
    for (const rp of remotePlayers) {
      ctx.fillRect((rp.x - startX) * scale - 2, (rp.z - startZ) * scale - 2.5, 4, 5);
    }

    // Destination: red flag
    if (this.destX !== null && this.destZ !== null) {
      this.destBlinkTimer += dt;
      if (Math.sin(this.destBlinkTimer * 6) > -0.3) {
        const dx = (this.destX - startX) * scale;
        const dz = (this.destZ - startZ) * scale;
        ctx.fillStyle = '#ff2020';
        ctx.fillRect(dx, dz - 8, 1.5, 9);
        ctx.beginPath();
        ctx.moveTo(dx + 1.5, dz - 8);
        ctx.lineTo(dx + 7, dz - 5);
        ctx.lineTo(dx + 1.5, dz - 2);
        ctx.closePath();
        ctx.fill();
      }
    }

    ctx.restore();

    // Player arrow (always centered)
    ctx.save();
    ctx.translate(center, center);
    const headingScreen = this.worldVectorToMinimapScreen(this.headingDx, this.headingDz, cameraAlpha);
    ctx.rotate(Math.atan2(headingScreen.x, -headingScreen.y));
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = '#000000';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, -7);
    ctx.lineTo(5, 5);
    ctx.lineTo(0, 2);
    ctx.lineTo(-5, 5);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();
  }

  private worldVectorToMinimapScreen(dx: number, dz: number, cameraAlpha: number): { x: number; y: number } {
    const angle = -(cameraAlpha + Math.PI / 2);
    const scaledX = -dx;
    const scaledY = -dz;
    const cosA = Math.cos(angle);
    const sinA = Math.sin(angle);
    return {
      x: scaledX * cosA - scaledY * sinA,
      y: scaledX * sinA + scaledY * cosA,
    };
  }
}
