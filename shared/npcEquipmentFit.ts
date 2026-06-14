import { isEquipSlot, type EquipSlot } from './equipment';

export interface NpcEquipmentFitVector3 {
  x: number;
  y: number;
  z: number;
}

export interface NpcEquipmentFitOverride {
  /** Visual-only multiplier applied to the equipped model on this NPC slot. */
  scale?: number;
  /** Local offset after the model has been parented to its configured bone. */
  localPosition?: NpcEquipmentFitVector3;
  /** Local Euler rotation in radians after the model has been parented. */
  localRotation?: NpcEquipmentFitVector3;
}

export type NpcEquipmentFitOverrides = Partial<Record<EquipSlot, NpcEquipmentFitOverride>>;

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeVector3(value: unknown): NpcEquipmentFitVector3 | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const raw = value as Record<string, unknown>;
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  const z = finiteNumber(raw.z);
  if (x == null || y == null || z == null) return undefined;
  return { x, y, z };
}

export function normalizeNpcEquipmentFits(raw: unknown): NpcEquipmentFitOverrides | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: NpcEquipmentFitOverrides = {};

  for (const [slot, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!isEquipSlot(slot) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
    const src = value as Record<string, unknown>;
    const fit: NpcEquipmentFitOverride = {};

    const scale = finiteNumber(src.scale);
    if (scale != null && scale > 0) fit.scale = scale;

    const localPosition = normalizeVector3(src.localPosition);
    if (localPosition) fit.localPosition = localPosition;

    const localRotation = normalizeVector3(src.localRotation);
    if (localRotation) fit.localRotation = localRotation;

    if (Object.keys(fit).length > 0) out[slot] = fit;
  }

  return Object.keys(out).length > 0 ? out : null;
}

export function hasNpcEquipmentFits(raw: unknown): raw is NpcEquipmentFitOverrides {
  return normalizeNpcEquipmentFits(raw) !== null;
}
