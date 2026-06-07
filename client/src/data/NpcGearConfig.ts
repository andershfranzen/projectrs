import type { NpcDef } from '../../../shared/types';
import type { NpcEquipmentFitOverride } from '../../../shared/npcEquipmentFit';
import { resolveNpcModelSourceId } from './NpcConfig';

export interface NpcGearSlotConfig {
  boneName: string;
  axisCorrection?: { x: number; y: number; z: number; w: number };
  localPosition: { x: number; y: number; z: number };
  localRotation: { x: number; y: number; z: number };
  scale: number;
  centerOrigin?: boolean;
  sourceBoneName?: string;
}

export interface NpcGearConfig {
  slots: Partial<Record<string, NpcGearSlotConfig>>;
}

export const NPC_MODEL_GEAR_CONFIG: Record<number, NpcGearConfig> = {
  15: {
    slots: {
      head: {
        boneName: 'Head',
        axisCorrection: { x: 0.732112, y: 0, z: 0.000001, w: 0.681184 },
        localPosition: { x: 0, y: 0.12, z: -0.25 },
        localRotation: { x: 0, y: 0, z: 0 },
        scale: 1,
        centerOrigin: true,
        sourceBoneName: 'mixamorig:Head',
      },
    },
  },
};

export function resolveNpcGearSlotConfig(
  defId: number,
  def: Pick<NpcDef, 'id' | 'modelNpcId'> | null | undefined,
  slotName: string,
): NpcGearSlotConfig | null {
  const sourceId = resolveNpcModelSourceId(defId, def);
  return NPC_MODEL_GEAR_CONFIG[sourceId]?.slots[slotName] ?? null;
}

export function mergeNpcGearSlotFit(
  base: NpcGearSlotConfig,
  override: NpcEquipmentFitOverride | null | undefined,
): NpcGearSlotConfig {
  if (!override) return base;
  return {
    ...base,
    localPosition: override.localPosition ?? base.localPosition,
    localRotation: override.localRotation ?? base.localRotation,
    scale: override.scale ?? base.scale,
  };
}
