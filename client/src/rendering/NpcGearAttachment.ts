import { Quaternion, Vector3 } from '@babylonjs/core/Maths/math.vector';
import type { TransformNode } from '@babylonjs/core/Meshes/transformNode';
import type { NpcGearSlotConfig } from '../data/NpcGearConfig';
import type { GearTemplate } from './CharacterEntity';

export function createNpcGearTemplateWithFit(template: GearTemplate, fit: NpcGearSlotConfig): GearTemplate {
  return {
    ...template,
    boneName: fit.boneName,
    localPosition: new Vector3(fit.localPosition.x, fit.localPosition.y, fit.localPosition.z),
    localRotation: new Vector3(fit.localRotation.x, fit.localRotation.y, fit.localRotation.z),
    scale: fit.scale,
    axisCorrection: fit.axisCorrection
      ? new Quaternion(fit.axisCorrection.x, fit.axisCorrection.y, fit.axisCorrection.z, fit.axisCorrection.w).normalize()
      : undefined,
  };
}

export function applyNpcGearFitToNode(node: TransformNode | null | undefined, fit: NpcGearSlotConfig): boolean {
  if (!node) return false;
  node.rotationQuaternion = null;
  node.position.set(fit.localPosition.x, fit.localPosition.y, fit.localPosition.z);
  node.rotation.set(fit.localRotation.x, fit.localRotation.y, fit.localRotation.z);
  node.scaling.set(fit.scale, fit.scale, fit.scale);
  return true;
}
