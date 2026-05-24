'use client';

import { type PointerEvent as ReactPointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';

type TileCode = 'g' | 'd' | 'p' | 's' | 'r' | 'w' | 'm' | 'u';
type WorldMapObjectKind = 'building' | 'wall' | 'vegetation' | 'resource' | 'interactive' | 'decor';

interface WorldMapNpcSpawn {
  x: number;
  z: number;
  floor: number;
  npcId: number;
  name: string;
}

interface WorldMapObject {
  x: number;
  z: number;
  y: number;
  rotationY: number;
  assetId: string;
  kind: WorldMapObjectKind;
  size: number;
}

interface WorldMapWall {
  x: number;
  z: number;
  floor: number;
  edges: number;
}

interface WorldMapData {
  id: string;
  sourceMapId: string;
  name: string;
  width: number;
  height: number;
  chunkSize: number;
  waterLevel: number;
  spawnPoint: { x: number; z: number } | null;
  tileRows: string[];
  tileCounts: Record<TileCode, number>;
  objects: WorldMapObject[];
  walls: WorldMapWall[];
  objectCount: number;
  wallCount: number;
  buildingCount: number;
  npcSpawns: WorldMapNpcSpawn[];
  updatedAt: number;
}

interface WorldMapResponse {
  ok: true;
  generatedAt: number;
  map: WorldMapData;
}

interface ViewState {
  x: number;
  y: number;
  zoom: number;
}

interface HoverInfo {
  x: number;
  y: number;
  title: string;
  rows: string[];
}

interface HoverIndex {
  npcs: Map<string, WorldMapNpcSpawn[]>;
  objects: Map<string, WorldMapObject[]>;
  walls: Map<string, WorldMapWall[]>;
}

const MIN_ZOOM = 0.75;
const MAX_ZOOM = 16;
const VIEW_PADDING = 28;
const MAP_REFRESH_MS = 5 * 60_000;
const MAP_RENDER_SCALE = 4;
const HOVER_CELL_SIZE = 16;
const NPC_MARKER_RADIUS = 2.2;

const TILE_COLORS: Record<TileCode, [number, number, number, number]> = {
  g: [91, 138, 65, 255],
  d: [139, 111, 68, 255],
  p: [190, 157, 93, 255],
  s: [215, 194, 116, 255],
  r: [128, 126, 115, 255],
  w: [38, 119, 171, 255],
  m: [102, 87, 57, 255],
  u: [52, 49, 43, 255],
};

const OBJECT_COLORS: Record<WorldMapObjectKind, string> = {
  building: 'rgba(139, 98, 58, 0.36)',
  wall: 'rgba(246, 241, 228, 0.62)',
  vegetation: 'rgba(33, 100, 42, 0.42)',
  resource: 'rgba(196, 181, 145, 0.52)',
  interactive: 'rgba(230, 136, 66, 0.58)',
  decor: 'rgba(112, 86, 58, 0.3)',
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function mapPointFromEvent(event: ReactPointerEvent<HTMLElement>, view: ViewState): { x: number; z: number; screenX: number; screenY: number } {
  const rect = event.currentTarget.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;
  return {
    x: (screenX - view.x) / view.zoom,
    z: (screenY - view.y) / view.zoom,
    screenX,
    screenY,
  };
}

function isWorldMapChromeTarget(target: EventTarget | null): boolean {
  if (typeof Element === 'undefined' || !(target instanceof Element)) return false;
  return Boolean(target.closest('.world-map-mapbar, .world-map-legend-card, .world-map-tooltip'));
}

function distSq(aX: number, aZ: number, bX: number, bZ: number): number {
  const dx = aX - bX;
  const dz = aZ - bZ;
  return dx * dx + dz * dz;
}

function distanceToSegment(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const lenSq = dx * dx + dz * dz;
  if (lenSq <= 0) return Math.sqrt(distSq(px, pz, ax, az));
  const t = clamp(((px - ax) * dx + (pz - az) * dz) / lenSq, 0, 1);
  return Math.sqrt(distSq(px, pz, ax + dx * t, az + dz * t));
}

function drawDiamond(ctx: CanvasRenderingContext2D, x: number, z: number, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(x, z - radius);
  ctx.lineTo(x + radius, z);
  ctx.lineTo(x, z + radius);
  ctx.lineTo(x - radius, z);
  ctx.closePath();
}

function tileColorCss(code: TileCode): string {
  const color = TILE_COLORS[code] ?? TILE_COLORS.g;
  return `rgb(${color[0]}, ${color[1]}, ${color[2]})`;
}

function tileCodeAt(map: WorldMapData, x: number, z: number): TileCode {
  return (map.tileRows[z]?.[x] as TileCode | undefined) ?? 'g';
}

function hoverCellKey(cx: number, cz: number): string {
  return `${cx},${cz}`;
}

function addHoverCell<T extends { x: number; z: number }>(bucket: Map<string, T[]>, item: T): void {
  const cx = Math.floor(item.x / HOVER_CELL_SIZE);
  const cz = Math.floor(item.z / HOVER_CELL_SIZE);
  const key = hoverCellKey(cx, cz);
  const items = bucket.get(key);
  if (items) items.push(item);
  else bucket.set(key, [item]);
}

function nearbyHoverItems<T>(bucket: Map<string, T[]>, x: number, z: number, radius: number): T[] {
  const minCx = Math.floor((x - radius) / HOVER_CELL_SIZE);
  const maxCx = Math.floor((x + radius) / HOVER_CELL_SIZE);
  const minCz = Math.floor((z - radius) / HOVER_CELL_SIZE);
  const maxCz = Math.floor((z + radius) / HOVER_CELL_SIZE);
  const items: T[] = [];

  for (let cz = minCz; cz <= maxCz; cz++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      const cellItems = bucket.get(hoverCellKey(cx, cz));
      if (cellItems) items.push(...cellItems);
    }
  }

  return items;
}

function buildHoverIndex(map: WorldMapData): HoverIndex {
  const index: HoverIndex = {
    npcs: new Map(),
    objects: new Map(),
    walls: new Map(),
  };

  for (const spawn of map.npcSpawns) addHoverCell(index.npcs, spawn);
  for (const obj of map.objects) addHoverCell(index.objects, obj);
  for (const wall of map.walls) addHoverCell(index.walls, wall);
  return index;
}

function drawWorldMapTerrain(ctx: CanvasRenderingContext2D, map: WorldMapData): void {
  for (let z = 0; z < map.height; z++) {
    const row = map.tileRows[z] ?? '';
    let runCode: TileCode | null = null;
    let runStart = 0;

    for (let x = 0; x <= map.width; x++) {
      const code = x < map.width ? ((row[x] as TileCode | undefined) ?? 'g') : null;
      if (code === runCode) continue;

      if (runCode !== null) {
        ctx.fillStyle = tileColorCss(runCode);
        ctx.fillRect(runStart, z, x - runStart, 1);
      }

      runCode = code;
      runStart = x;
    }
  }

  ctx.save();
  ctx.strokeStyle = 'rgba(241, 226, 166, 0.42)';
  ctx.lineWidth = 0.18;
  ctx.beginPath();

  for (let z = 0; z < map.height; z++) {
    for (let x = 0; x < map.width; x++) {
      if (tileCodeAt(map, x, z) !== 'w') continue;

      if (x === 0 || tileCodeAt(map, x - 1, z) !== 'w') {
        ctx.moveTo(x, z);
        ctx.lineTo(x, z + 1);
      }
      if (x === map.width - 1 || tileCodeAt(map, x + 1, z) !== 'w') {
        ctx.moveTo(x + 1, z);
        ctx.lineTo(x + 1, z + 1);
      }
      if (z === 0 || tileCodeAt(map, x, z - 1) !== 'w') {
        ctx.moveTo(x, z);
        ctx.lineTo(x + 1, z);
      }
      if (z === map.height - 1 || tileCodeAt(map, x, z + 1) !== 'w') {
        ctx.moveTo(x, z + 1);
        ctx.lineTo(x + 1, z + 1);
      }
    }
  }

  ctx.stroke();
  ctx.restore();
}

function drawChunkGrid(ctx: CanvasRenderingContext2D, map: WorldMapData): void {
  const chunkSize = Math.max(1, Math.floor(map.chunkSize || 32));
  const maxX = map.width;
  const maxZ = map.height;

  ctx.save();
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.34)';
  ctx.lineWidth = 0.22;
  ctx.beginPath();

  for (let x = 0; x <= maxX; x += chunkSize) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, maxZ);
  }
  if (maxX % chunkSize !== 0) {
    ctx.moveTo(maxX, 0);
    ctx.lineTo(maxX, maxZ);
  }

  for (let z = 0; z <= maxZ; z += chunkSize) {
    ctx.moveTo(0, z);
    ctx.lineTo(maxX, z);
  }
  if (maxZ % chunkSize !== 0) {
    ctx.moveTo(0, maxZ);
    ctx.lineTo(maxX, maxZ);
  }

  ctx.stroke();

  ctx.fillStyle = 'rgba(255, 255, 255, 0.62)';
  ctx.font = '700 3.5px Arial, Helvetica, sans-serif';
  ctx.textBaseline = 'top';
  for (let z = 0; z < maxZ; z += chunkSize) {
    for (let x = 0; x < maxX; x += chunkSize) {
      ctx.fillText(`${Math.floor(x / chunkSize)},${Math.floor(z / chunkSize)}`, x + 1.2, z + 1);
    }
  }

  ctx.restore();
}

function drawNpcSpawn(ctx: CanvasRenderingContext2D, spawn: WorldMapNpcSpawn): void {
  ctx.save();
  ctx.fillStyle = '#f2d45c';
  ctx.strokeStyle = '#1b1005';
  ctx.lineWidth = 0.9;
  drawDiamond(ctx, spawn.x, spawn.z, NPC_MARKER_RADIUS);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawWallDash(ctx: CanvasRenderingContext2D, x: number, z: number, rotationY: number, length: number): void {
  const half = length / 2;
  const dx = Math.sin(rotationY) * half;
  const dz = Math.cos(rotationY) * half;
  ctx.beginPath();
  ctx.moveTo(x - dx, z - dz);
  ctx.lineTo(x + dx, z + dz);
  ctx.stroke();
}

function drawWorldObject(ctx: CanvasRenderingContext2D, obj: WorldMapObject): void {
  if (obj.kind === 'wall') {
    ctx.save();
    ctx.strokeStyle = OBJECT_COLORS.wall;
    ctx.lineWidth = 0.24;
    ctx.lineCap = 'round';
    drawWallDash(ctx, obj.x, obj.z, obj.rotationY, clamp(obj.size * 1.7, 0.9, 3.2));
    ctx.restore();
    return;
  }

  const size = obj.kind === 'building'
    ? clamp(obj.size * 0.68, 0.42, 1.7)
    : clamp(obj.size * 0.72, 0.42, 1.85);
  const half = size / 2;
  ctx.save();
  ctx.fillStyle = OBJECT_COLORS[obj.kind];
  ctx.strokeStyle = obj.kind === 'building' ? 'rgba(40, 26, 14, 0.22)' : 'rgba(12, 12, 10, 0.24)';
  ctx.lineWidth = obj.kind === 'building' ? 0.22 : 0.25;

  if (obj.kind === 'vegetation') {
    ctx.beginPath();
    ctx.arc(obj.x, obj.z, half, 0, Math.PI * 2);
    ctx.fill();
  } else if (obj.kind === 'resource') {
    drawDiamond(ctx, obj.x, obj.z, half);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(obj.x - half, obj.z - half, size, size);
    if (obj.kind === 'building' || obj.kind === 'interactive') {
      ctx.strokeRect(obj.x - half, obj.z - half, size, size);
    }
  }

  ctx.restore();
}

function drawWorldMapWall(ctx: CanvasRenderingContext2D, wall: WorldMapWall): void {
  const x = wall.x;
  const z = wall.z;
  ctx.save();
  ctx.strokeStyle = wall.floor === 0 ? 'rgba(246, 241, 228, 0.68)' : 'rgba(246, 241, 228, 0.4)';
  ctx.lineWidth = wall.floor === 0 ? 0.28 : 0.22;
  ctx.lineCap = 'square';
  ctx.beginPath();
  if (wall.edges & 1) {
    ctx.moveTo(x, z);
    ctx.lineTo(x + 1, z);
  }
  if (wall.edges & 2) {
    ctx.moveTo(x + 1, z);
    ctx.lineTo(x + 1, z + 1);
  }
  if (wall.edges & 4) {
    ctx.moveTo(x, z + 1);
    ctx.lineTo(x + 1, z + 1);
  }
  if (wall.edges & 8) {
    ctx.moveTo(x, z);
    ctx.lineTo(x, z + 1);
  }
  ctx.stroke();
  ctx.restore();
}

export function WorldMapViewer() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<ViewState>({ x: 0, y: 0, zoom: 1 });
  const dragRef = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const lastFitKeyRef = useRef('');

  const [map, setMap] = useState<WorldMapData | null>(null);
  const [status, setStatus] = useState('Loading World Map');
  const [view, setView] = useState<ViewState>({ x: 0, y: 0, zoom: 1 });
  const [isPanning, setIsPanning] = useState(false);
  const [showObjects, setShowObjects] = useState(true);
  const [showWalls, setShowWalls] = useState(true);
  const [showNpcSpawns, setShowNpcSpawns] = useState(true);
  const [showChunks, setShowChunks] = useState(false);
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | null>(null);
  const hoverIndex = useMemo(() => (map ? buildHoverIndex(map) : null), [map]);

  const clampView = useCallback((candidate: ViewState): ViewState => {
    const viewport = viewportRef.current;
    if (!viewport || !map) return candidate;

    const rect = viewport.getBoundingClientRect();
    const zoom = clamp(candidate.zoom, MIN_ZOOM, MAX_ZOOM);
    const scaledWidth = map.width * zoom;
    const scaledHeight = map.height * zoom;

    let x = candidate.x;
    let y = candidate.y;

    if (scaledWidth + VIEW_PADDING * 2 <= rect.width) {
      x = (rect.width - scaledWidth) / 2;
    } else {
      x = clamp(x, rect.width - scaledWidth - VIEW_PADDING, VIEW_PADDING);
    }

    if (scaledHeight + VIEW_PADDING * 2 <= rect.height) {
      y = (rect.height - scaledHeight) / 2;
    } else {
      y = clamp(y, rect.height - scaledHeight - VIEW_PADDING, VIEW_PADDING);
    }

    return { x, y, zoom };
  }, [map]);

  const updateView = useCallback((candidate: ViewState) => {
    const next = clampView(candidate);
    viewRef.current = next;
    setView(next);
  }, [clampView]);

  const fitMap = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !map) return;

    const rect = viewport.getBoundingClientRect();
    const fitZoom = clamp(
      Math.min(
        (rect.width - VIEW_PADDING * 2) / map.width,
        (rect.height - VIEW_PADDING * 2) / map.height,
      ),
      MIN_ZOOM,
      MAX_ZOOM,
    );

    updateView({
      zoom: fitZoom,
      x: (rect.width - map.width * fitZoom) / 2,
      y: (rect.height - map.height * fitZoom) / 2,
    });
  }, [map, updateView]);

  const zoomAt = useCallback((clientX: number, clientY: number, nextZoom: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    const current = viewRef.current;
    const zoom = clamp(nextZoom, MIN_ZOOM, MAX_ZOOM);
    const worldX = (clientX - rect.left - current.x) / current.zoom;
    const worldY = (clientY - rect.top - current.y) / current.zoom;

    updateView({
      zoom,
      x: clientX - rect.left - worldX * zoom,
      y: clientY - rect.top - worldY * zoom,
    });
  }, [updateView]);

  const zoomFromCenter = useCallback((factor: number) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const rect = viewport.getBoundingClientRect();
    zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, viewRef.current.zoom * factor);
  }, [zoomAt]);

  const findHoverInfo = useCallback((x: number, z: number, screenX: number, screenY: number): HoverInfo | null => {
    if (!map || !hoverIndex) return null;
    const tooltipX = screenX + 16;
    const tooltipY = screenY + 16;
    const hitRadius = Math.max(3, 8 / viewRef.current.zoom);

    if (showNpcSpawns) {
      const radius = Math.max(5, hitRadius);
      for (const spawn of nearbyHoverItems(hoverIndex.npcs, x, z, radius)) {
        if (distSq(x, z, spawn.x, spawn.z) <= radius * radius) {
          return {
            x: tooltipX,
            y: tooltipY,
            title: spawn.name,
            rows: [`NPC spawn`, `Tile ${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}`, `Floor ${spawn.floor}`],
          };
        }
      }
    }

    if (showObjects) {
      let best: { obj: WorldMapObject; distance: number } | null = null;
      for (const obj of nearbyHoverItems(hoverIndex.objects, x, z, Math.max(hitRadius, 4))) {
        const radius = Math.max(hitRadius, obj.size * 1.25);
        const distance = distSq(x, z, obj.x, obj.z);
        if (distance > radius * radius) continue;
        if (!best || distance < best.distance) best = { obj, distance };
      }
      if (best) {
        const obj = best.obj;
        return {
          x: tooltipX,
          y: tooltipY,
          title: obj.assetId,
          rows: [`${obj.kind[0].toUpperCase()}${obj.kind.slice(1)}`, `Tile ${obj.x.toFixed(1)}, ${obj.z.toFixed(1)}`, `Height ${obj.y.toFixed(1)}`],
        };
      }
    }

    if (showWalls) {
      const edgeHitRadius = Math.max(0.65, 4 / viewRef.current.zoom);
      for (const wall of nearbyHoverItems(hoverIndex.walls, x, z, edgeHitRadius + 2)) {
        const edges: Array<[string, number, number, number, number]> = [];
        if (wall.edges & 1) edges.push(['North edge', wall.x, wall.z, wall.x + 1, wall.z]);
        if (wall.edges & 2) edges.push(['East edge', wall.x + 1, wall.z, wall.x + 1, wall.z + 1]);
        if (wall.edges & 4) edges.push(['South edge', wall.x, wall.z + 1, wall.x + 1, wall.z + 1]);
        if (wall.edges & 8) edges.push(['West edge', wall.x, wall.z, wall.x, wall.z + 1]);
        for (const [edgeName, ax, az, bx, bz] of edges) {
          if (distanceToSegment(x, z, ax, az, bx, bz) <= edgeHitRadius) {
            return {
              x: tooltipX,
              y: tooltipY,
              title: edgeName,
              rows: [`Wall edge`, `Tile ${wall.x}, ${wall.z}`, `Floor ${wall.floor}`],
            };
          }
        }
      }
    }

    if (showChunks && x >= 0 && z >= 0 && x < map.width && z < map.height) {
      const chunkSize = Math.max(1, Math.floor(map.chunkSize || 32));
      const chunkX = Math.floor(x / chunkSize);
      const chunkZ = Math.floor(z / chunkSize);
      const startX = chunkX * chunkSize;
      const startZ = chunkZ * chunkSize;
      const endX = Math.min(map.width - 1, startX + chunkSize - 1);
      const endZ = Math.min(map.height - 1, startZ + chunkSize - 1);
      return {
        x: tooltipX,
        y: tooltipY,
        title: `Chunk ${chunkX},${chunkZ}`,
        rows: [`Tiles ${startX}-${endX}, ${startZ}-${endZ}`],
      };
    }

    return null;
  }, [hoverIndex, map, showChunks, showNpcSpawns, showObjects, showWalls]);

  useEffect(() => {
    let cancelled = false;

    const loadMap = () => {
      fetch('/api/world-map', { cache: 'no-store' })
        .then((res) => {
          if (!res.ok) throw new Error(`Map request failed (${res.status})`);
          return res.json() as Promise<WorldMapResponse>;
        })
        .then((payload) => {
          if (cancelled) return;
          setMap(payload.map);
          setStatus('');
        })
        .catch((err) => {
          if (!cancelled) setStatus(err instanceof Error ? err.message : 'Unable to load World Map');
        });
    };

    loadMap();
    const timer = window.setInterval(loadMap, MAP_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    const currentMap = map;
    const canvas = canvasRef.current;
    if (!currentMap || !canvas) return;

    const pixelWidth = currentMap.width * MAP_RENDER_SCALE;
    const pixelHeight = currentMap.height * MAP_RENDER_SCALE;

    canvas.width = pixelWidth;
    canvas.height = pixelHeight;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, pixelWidth, pixelHeight);
    ctx.setTransform(MAP_RENDER_SCALE, 0, 0, MAP_RENDER_SCALE, 0, 0);
    drawWorldMapTerrain(ctx, currentMap);

    if (showObjects) {
      for (const obj of currentMap.objects) drawWorldObject(ctx, obj);
    }

    if (showWalls) {
      for (const wall of currentMap.walls) drawWorldMapWall(ctx, wall);
    }

    if (showChunks) {
      drawChunkGrid(ctx, currentMap);
    }

    if (showNpcSpawns) {
      for (const spawn of currentMap.npcSpawns) drawNpcSpawn(ctx, spawn);
    }

    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }, [map, showChunks, showNpcSpawns, showObjects, showWalls]);

  useEffect(() => {
    if (!map) return;
    const key = `${map.width}x${map.height}`;
    if (lastFitKeyRef.current === key) {
      updateView(viewRef.current);
      return;
    }

    lastFitKeyRef.current = key;
    const frame = window.requestAnimationFrame(fitMap);
    return () => window.cancelAnimationFrame(frame);
  }, [fitMap, map, updateView]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const observer = new ResizeObserver(() => {
      if (lastFitKeyRef.current) updateView(viewRef.current);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [updateView]);

  return (
    <section className="world-map-shell" aria-label="World Map">
      <div className="world-map-canvas-panel">
        <div
          ref={viewportRef}
          className={isPanning ? 'world-map-viewport is-panning' : 'world-map-viewport'}
          onWheel={(event) => {
            if (isWorldMapChromeTarget(event.target)) return;
            event.preventDefault();
            const factor = Math.exp(-event.deltaY * 0.0012);
            zoomAt(event.clientX, event.clientY, viewRef.current.zoom * factor);
          }}
          onPointerDown={(event) => {
            if (event.button !== 0) return;
            if (isWorldMapChromeTarget(event.target)) return;
            dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
            event.currentTarget.setPointerCapture(event.pointerId);
            setHoverInfo(null);
            setIsPanning(true);
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current;
            if (drag && drag.pointerId === event.pointerId) {
              const dx = event.clientX - drag.x;
              const dy = event.clientY - drag.y;
              dragRef.current = { ...drag, x: event.clientX, y: event.clientY };
              const current = viewRef.current;
              updateView({ ...current, x: current.x + dx, y: current.y + dy });
              setHoverInfo(null);
              return;
            }

            const point = mapPointFromEvent(event, viewRef.current);
            setHoverInfo(findHoverInfo(point.x, point.z, point.screenX, point.screenY));
          }}
          onPointerUp={(event) => {
            if (dragRef.current?.pointerId === event.pointerId) dragRef.current = null;
            setIsPanning(false);
          }}
          onPointerCancel={() => {
            dragRef.current = null;
            setIsPanning(false);
            setHoverInfo(null);
          }}
          onPointerLeave={() => {
            dragRef.current = null;
            setIsPanning(false);
            setHoverInfo(null);
          }}
        >
          <canvas
            ref={canvasRef}
            className="world-map-canvas"
            style={map ? {
              width: `${map.width}px`,
              height: `${map.height}px`,
              transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.zoom})`,
            } : undefined}
          />

          {status ? <div className="world-map-status">{status}</div> : null}

          <div className="world-map-mapbar" onPointerDown={(event) => event.stopPropagation()}>
            <div className="world-map-title">
              <h1>World Map</h1>
            </div>
            <div className="world-map-controls" aria-label="Map controls">
              <button type="button" title="Zoom out" aria-label="Zoom out" onClick={() => zoomFromCenter(0.82)}>-</button>
              <span>{view.zoom.toFixed(1)}x</span>
              <button type="button" title="Zoom in" aria-label="Zoom in" onClick={() => zoomFromCenter(1.22)}>+</button>
              <button type="button" className="world-map-fit" onClick={fitMap}>Fit</button>
            </div>
          </div>

          {hoverInfo ? (
            <div className="world-map-tooltip" style={{ left: `${hoverInfo.x}px`, top: `${hoverInfo.y}px` }}>
              <strong>{hoverInfo.title}</strong>
              {hoverInfo.rows.map((row) => <span key={row}>{row}</span>)}
            </div>
          ) : null}

          <div className="world-map-legend-card" aria-label="Map legend" onPointerDown={(event) => event.stopPropagation()}>
            <div className="world-map-marker-legend">
              <label><input type="checkbox" checked={showObjects} onChange={(event) => setShowObjects(event.target.checked)} /> <span className="world-map-marker object" /> Objects</label>
              <label><input type="checkbox" checked={showWalls} onChange={(event) => setShowWalls(event.target.checked)} /> <span className="world-map-marker wall-line" /> Walls</label>
              <label><input type="checkbox" checked={showNpcSpawns} onChange={(event) => setShowNpcSpawns(event.target.checked)} /> <span className="world-map-marker npc" /> NPCs</label>
              <label><input type="checkbox" checked={showChunks} onChange={(event) => setShowChunks(event.target.checked)} /> <span className="world-map-marker chunk-grid" /> Chunks</label>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
