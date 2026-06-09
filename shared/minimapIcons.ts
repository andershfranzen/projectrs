export const MINIMAP_ICON_BASE_PATH = '/minimap/icons/';

export interface MinimapMarker {
  id: string;
  icon: string;
  x: number;
  z: number;
  floor?: number;
  label?: string;
  size?: number;
}

export function isValidMinimapIconFilename(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  if (value.length < 5 || value.length > 96) return false;
  if (value.includes('/') || value.includes('\\') || value.includes('\0')) return false;
  if (value.includes('..')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_. -]*\.(?:png|webp)$/i.test(value);
}

export function minimapIconUrl(icon: unknown): string | null {
  if (!isValidMinimapIconFilename(icon)) return null;
  return `${MINIMAP_ICON_BASE_PATH}${encodeURIComponent(icon)}`;
}

export function normalizeMinimapMarker(value: unknown, mapWidth?: number, mapHeight?: number): MinimapMarker | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const x = Number(raw.x);
  const z = Number(raw.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  if (mapWidth !== undefined && (x < 0 || x > mapWidth)) return null;
  if (mapHeight !== undefined && (z < 0 || z > mapHeight)) return null;

  const icon = String(raw.icon ?? '').trim();
  if (!isValidMinimapIconFilename(icon)) return null;

  const id = typeof raw.id === 'string' && raw.id.trim()
    ? raw.id.trim().slice(0, 64)
    : `marker_${Math.round(x * 100)}_${Math.round(z * 100)}_${icon}`;
  const marker: MinimapMarker = { id, icon, x, z };

  const floor = Number(raw.floor);
  if (Number.isInteger(floor) && floor >= 0 && floor <= 15) marker.floor = floor;

  if (typeof raw.label === 'string' && raw.label.trim()) {
    marker.label = raw.label.trim().slice(0, 80);
  }

  const size = Number(raw.size);
  if (Number.isFinite(size) && size > 0) marker.size = Math.max(8, Math.min(32, Math.round(size)));

  return marker;
}

export function normalizeMinimapMarkers(value: unknown, mapWidth?: number, mapHeight?: number): MinimapMarker[] {
  if (!Array.isArray(value)) return [];
  const markers: MinimapMarker[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    const marker = normalizeMinimapMarker(item, mapWidth, mapHeight);
    if (!marker || seen.has(marker.id)) continue;
    seen.add(marker.id);
    markers.push(marker);
  }
  return markers;
}
