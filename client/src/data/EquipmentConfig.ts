export interface GearOverride {
  boneName?: string;
  localPosition?: { x: number; y: number; z: number };
  localRotation?: { x: number; y: number; z: number };
  scale?: number;
  centerOrigin?: boolean;
  file?: string;
}

export const EQUIP_SLOT_BONES: Record<string, { boneName: string; localPosition: { x: number; y: number; z: number }; localRotation: { x: number; y: number; z: number }; scale: number }> = {
  weapon:  { boneName: 'mixamorig:RightHand',    localPosition: { x: -0.16, y: 0.095, z: 0.02 }, localRotation: { x: -1.5, y: 0.05, z: -1.6 }, scale: 0.8 },
  shield:  { boneName: 'mixamorig:LeftForeArm',  localPosition: { x: -0.08, y: -0.15, z: 0 },    localRotation: { x: 0, y: Math.PI, z: 0 }, scale: 0.85 },
  head:    { boneName: 'mixamorig:Head',          localPosition: { x: 0, y: 0.08, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  body:    { boneName: 'mixamorig:Spine2',        localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  legs:    { boneName: 'mixamorig:Hips',          localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  feet:    { boneName: 'mixamorig:RightFoot',     localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  hands:   { boneName: 'mixamorig:RightHand',     localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  neck:    { boneName: 'mixamorig:Neck',          localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  ring:    { boneName: 'mixamorig:LeftHand',      localPosition: { x: 0, y: 0, z: 0 },    localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
  cape:    { boneName: 'mixamorig:Spine1',        localPosition: { x: 0, y: -0.1, z: -0.1 }, localRotation: { x: 0, y: 0, z: 0 }, scale: 1 },
};

export const EQUIP_SLOT_NAMES = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape'];

export const METAL_TIER_THUMBNAIL_COLOR = {
  bronze: [0.45, 0.28, 0.12],
  iron: [0.48, 0.48, 0.50],
  steel: [0.75, 0.78, 0.82],
  mithril: [0.12, 0.22, 0.40],
  blackBronze: [0.05, 0.05, 0.07],
} satisfies Record<string, [number, number, number]>;

export const TOOL_TIER_METAL_COLOR: Record<number, [number, number, number]> = {
  // Axes
  31: METAL_TIER_THUMBNAIL_COLOR.bronze, // Bronze Axe
  32: METAL_TIER_THUMBNAIL_COLOR.iron, // Iron Axe
  36: METAL_TIER_THUMBNAIL_COLOR.steel, // Steel Axe
  37: METAL_TIER_THUMBNAIL_COLOR.mithril, // Mithril Axe
  38: METAL_TIER_THUMBNAIL_COLOR.blackBronze, // Black Axe
  // Pickaxes
  33: METAL_TIER_THUMBNAIL_COLOR.bronze, // Bronze Pickaxe
  53: METAL_TIER_THUMBNAIL_COLOR.iron, // Iron Pickaxe
  54: METAL_TIER_THUMBNAIL_COLOR.steel, // Steel Pickaxe
  55: METAL_TIER_THUMBNAIL_COLOR.mithril, // Mithril Pickaxe
  56: METAL_TIER_THUMBNAIL_COLOR.blackBronze, // Black Bronze Pickaxe
};
