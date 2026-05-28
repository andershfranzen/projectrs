// Character appearance customization — shared between client and server

/**
 * A player's appearance: indices into the color palettes below.
 * Stored in the DB as JSON, synced to other players via PLAYER_SYNC.
 */
export interface PlayerAppearance {
  /** 0 = default/male body, 1 = female body. */
  bodyType: number;
  shirtColor: number;
  pantsColor: number;
  shoesColor: number;
  hairColor: number;
  beltColor: number;
  skinColor: number;
  hairStyle: number;
}

/** RGB triplets (0-1 linear) — index maps to PlayerAppearance.*Color fields */
export const SHIRT_COLORS: [number, number, number][] = [
  [0.032, 0.052, 0.123],  // 0  dark blue (default)
  [0.015, 0.080, 0.025],  // 1  forest green
  [0.120, 0.010, 0.010],  // 2  crimson
  [0.080, 0.020, 0.090],  // 3  purple
  [0.100, 0.060, 0.010],  // 4  brown
  [0.020, 0.080, 0.090],  // 5  teal
  [0.110, 0.080, 0.010],  // 6  gold
  [0.060, 0.060, 0.065],  // 7  charcoal
  [0.130, 0.130, 0.130],  // 8  light grey
  [0.010, 0.010, 0.010],  // 9  black
  [0.140, 0.060, 0.010],  // 10 orange
  [0.090, 0.010, 0.050],  // 11 magenta
  [0.500, 0.500, 0.500],  // 12 white
  [0.060, 0.020, 0.080],  // 13 dark purple
  [0.010, 0.040, 0.080],  // 14 navy
  [0.120, 0.010, 0.060],  // 15 pink
];

export const PANTS_COLORS: [number, number, number][] = [
  [0.443, 0.404, 0.404],  // 0  light grey (default)
  [0.180, 0.120, 0.070],  // 1  brown
  [0.032, 0.052, 0.123],  // 2  dark blue
  [0.020, 0.050, 0.020],  // 3  dark green
  [0.060, 0.060, 0.065],  // 4  charcoal
  [0.010, 0.010, 0.010],  // 5  black
  [0.100, 0.050, 0.020],  // 6  tan
  [0.100, 0.010, 0.010],  // 7  dark red
  [0.200, 0.180, 0.160],  // 8  khaki
  [0.050, 0.020, 0.060],  // 9  dark purple
  [0.140, 0.140, 0.140],  // 10 silver
  [0.070, 0.050, 0.010],  // 11 olive
  [0.500, 0.500, 0.500],  // 12 white
];

export const SHOES_COLORS: [number, number, number][] = [
  [0.057, 0.052, 0.054],  // 0  near black (default)
  [0.080, 0.040, 0.015],  // 1  dark brown
  [0.140, 0.090, 0.050],  // 2  tan
  [0.030, 0.030, 0.050],  // 3  dark navy
  [0.050, 0.020, 0.020],  // 4  dark red
  [0.020, 0.040, 0.020],  // 5  dark green
  [0.100, 0.100, 0.100],  // 6  grey
  [0.010, 0.010, 0.010],  // 7  black
  [0.400, 0.400, 0.400],  // 8  white
];

/** Belt color index 0 = "No Belt" (matches shirt color). Handled in applyAppearance. */
export const BELT_NO_BELT = 0;

export const BELT_COLORS: [number, number, number][] = [
  [0.000, 0.000, 0.000],  // 0  No Belt (placeholder — replaced by shirt color at runtime)
  [0.182, 0.006, 0.006],  // 1  dark red
  [0.080, 0.040, 0.015],  // 2  dark brown
  [0.010, 0.010, 0.010],  // 3  black
  [0.060, 0.060, 0.065],  // 4  charcoal
  [0.110, 0.080, 0.010],  // 5  gold
  [0.020, 0.050, 0.020],  // 6  dark green
  [0.032, 0.052, 0.123],  // 7  dark blue
  [0.140, 0.090, 0.050],  // 8  tan
  [0.500, 0.500, 0.500],  // 9  white
];

export const SKIN_COLORS: [number, number, number][] = [
  [0.343, 0.213, 0.104],  // 0  default tan (matches authored Skin material)
  [0.560, 0.380, 0.260],  // 1  fair
  [0.420, 0.270, 0.150],  // 2  light brown
  [0.260, 0.150, 0.080],  // 3  brown
  [0.150, 0.080, 0.050],  // 4  dark brown
  [0.090, 0.045, 0.030],  // 5  very dark
  [0.500, 0.290, 0.180],  // 6  golden
  [0.380, 0.220, 0.130],  // 7  olive
];

export const HAIR_COLORS: [number, number, number][] = [
  [0.130, 0.063, 0.028],  // 0  brown (default)
  [0.180, 0.140, 0.050],  // 1  blonde
  [0.010, 0.010, 0.010],  // 2  black
  [0.120, 0.030, 0.010],  // 3  auburn
  [0.200, 0.080, 0.020],  // 4  ginger
  [0.150, 0.150, 0.150],  // 5  grey
  [0.080, 0.025, 0.025],  // 6  dark red
  [0.060, 0.040, 0.020],  // 7  dark brown
  [0.450, 0.450, 0.450],  // 8  white
  [0.250, 0.200, 0.080],  // 9  light blonde
];

export const HAIR_STYLE_COUNT = 15;       // M_hair_1 … M_hair_15 (0 = bald)
export const BODY_TYPE_NAMES: string[] = ['Male', 'Female'];
export const BODY_TYPE_COUNT = BODY_TYPE_NAMES.length;
export const APPEARANCE_WIRE_FIELD_COUNT = 8;
export const FEMALE_BODY_TYPE = 1;
export const FEMALE_HAIR_STYLE_CHOICES: readonly number[] = [10, 11, 12, 13, 14];
export const DEFAULT_HAIR_STYLE_BY_BODY_TYPE: readonly number[] = [1, 10];
const ALL_HAIR_STYLE_CHOICES: readonly number[] = Array.from({ length: HAIR_STYLE_COUNT + 1 }, (_, i) => i);

/** Display labels parallel to each palette. Indices match the palette arrays
 *  above. Used by the character creator stepper to show the picked color's
 *  name. Kept here so adding a palette entry forces a name update at the same
 *  site. */
export const SHIRT_COLOR_NAMES: string[] = [
  'Dark Blue', 'Forest Green', 'Crimson', 'Purple',
  'Brown', 'Teal', 'Gold', 'Charcoal',
  'Light Grey', 'Black', 'Orange', 'Magenta',
  'White', 'Dark Purple', 'Navy', 'Pink',
];
export const PANTS_COLOR_NAMES: string[] = [
  'Light Grey', 'Brown', 'Dark Blue', 'Dark Green',
  'Charcoal', 'Black', 'Tan', 'Dark Red',
  'Khaki', 'Dark Purple', 'Silver', 'Olive', 'White',
];
export const SHOES_COLOR_NAMES: string[] = [
  'Near Black', 'Dark Brown', 'Tan', 'Dark Navy',
  'Dark Red', 'Dark Green', 'Grey', 'Black', 'White',
];
export const BELT_COLOR_NAMES: string[] = [
  'No Belt', 'Dark Red', 'Dark Brown', 'Black', 'Charcoal',
  'Gold', 'Dark Green', 'Dark Blue', 'Tan', 'White',
];
export const SKIN_COLOR_NAMES: string[] = [
  'Tan', 'Fair', 'Light Brown', 'Brown',
  'Dark Brown', 'Very Dark', 'Golden', 'Olive',
];
export const HAIR_COLOR_NAMES: string[] = [
  'Brown', 'Blonde', 'Black', 'Auburn', 'Ginger',
  'Grey', 'Dark Red', 'Dark Brown', 'White', 'Light Blonde',
];

/** Hair styles: 0 = bald, 1..HAIR_STYLE_COUNT = M_hair_N. Names are generic.
 *  Female styles are stored as their authored mesh ids (10..14), but shown to
 *  players as a compact 1-based list so the UI doesn't look like styles 1..9
 *  are broken. */
export function hairStyleName(idx: number, bodyType: number = 0): string {
  if (bodyType === FEMALE_BODY_TYPE) {
    const femaleIdx = FEMALE_HAIR_STYLE_CHOICES.indexOf(idx);
    if (femaleIdx >= 0) return `Style ${femaleIdx + 1}`;
  }
  if (idx === 0) return 'Bald';
  return `Style ${idx}`;
}

export function hairStyleChoicesForBodyType(bodyType: number): readonly number[] {
  return bodyType === FEMALE_BODY_TYPE ? FEMALE_HAIR_STYLE_CHOICES : ALL_HAIR_STYLE_CHOICES;
}

export function normalizeBodyType(bodyType: unknown): number {
  return Number.isInteger(bodyType) && (bodyType as number) >= 0 && (bodyType as number) < BODY_TYPE_COUNT
    ? bodyType as number
    : 0;
}

export function normalizeHairStyleForBodyType(bodyType: number, hairStyle: unknown): number {
  const choices = hairStyleChoicesForBodyType(bodyType);
  if (Number.isInteger(hairStyle) && choices.includes(hairStyle as number)) return hairStyle as number;
  return DEFAULT_HAIR_STYLE_BY_BODY_TYPE[bodyType] ?? choices[0] ?? 0;
}

export const DEFAULT_APPEARANCE: PlayerAppearance = {
  bodyType: 0,
  shirtColor: 0,
  pantsColor: 0,
  shoesColor: 0,
  hairColor: 0,
  beltColor: 1,
  skinColor: 0,
  hairStyle: 1,
};

/** Validate that all indices are within palette range */
export function isValidAppearance(a: PlayerAppearance): boolean {
  return (
    Number.isInteger(a.bodyType) && a.bodyType >= 0 && a.bodyType < BODY_TYPE_COUNT &&
    Number.isInteger(a.shirtColor) && a.shirtColor >= 0 && a.shirtColor < SHIRT_COLORS.length &&
    Number.isInteger(a.pantsColor) && a.pantsColor >= 0 && a.pantsColor < PANTS_COLORS.length &&
    Number.isInteger(a.shoesColor) && a.shoesColor >= 0 && a.shoesColor < SHOES_COLORS.length &&
    Number.isInteger(a.hairColor)  && a.hairColor >= 0  && a.hairColor < HAIR_COLORS.length &&
    Number.isInteger(a.beltColor)  && a.beltColor >= 0  && a.beltColor < BELT_COLORS.length &&
    Number.isInteger(a.skinColor)  && a.skinColor >= 0  && a.skinColor < SKIN_COLORS.length &&
    hairStyleChoicesForBodyType(a.bodyType).includes(a.hairStyle)
  );
}

/** Shallow equality on every PlayerAppearance field. */
export function appearanceEquals(a: PlayerAppearance | null, b: PlayerAppearance | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.bodyType === b.bodyType
    && a.shirtColor === b.shirtColor
    && a.pantsColor === b.pantsColor
    && a.shoesColor === b.shoesColor
    && a.hairColor === b.hairColor
    && a.beltColor === b.beltColor
    && a.skinColor === b.skinColor
    && a.hairStyle === b.hairStyle;
}

/** Fill in missing fields from older saved appearances (backwards compat) */
export function normalizeAppearance(a: Partial<PlayerAppearance>): PlayerAppearance {
  const bodyType = normalizeBodyType(a.bodyType);
  return {
    bodyType,
    shirtColor: a.shirtColor ?? 0,
    pantsColor: a.pantsColor ?? 0,
    shoesColor: a.shoesColor ?? 0,
    hairColor:  a.hairColor ?? 0,
    beltColor:  a.beltColor ?? 0,
    skinColor:  a.skinColor ?? 0,
    hairStyle:  normalizeHairStyleForBodyType(bodyType, a.hairStyle),
  };
}

/** Field order used by SET_APPEARANCE and appearance sync packets. */
export function appearanceToWireValues(a: PlayerAppearance): number[] {
  return [
    a.shirtColor,
    a.pantsColor,
    a.shoesColor,
    a.hairColor,
    a.beltColor,
    a.skinColor,
    a.hairStyle,
    a.bodyType,
  ];
}

export function appearanceFromWireValues(values: readonly number[], offset: number = 0): PlayerAppearance {
  return {
    shirtColor: values[offset] ?? 0,
    pantsColor: values[offset + 1] ?? 0,
    shoesColor: values[offset + 2] ?? 0,
    hairColor: values[offset + 3] ?? 0,
    beltColor: values[offset + 4] ?? 0,
    skinColor: values[offset + 5] ?? 0,
    hairStyle: values[offset + 6] ?? 1,
    bodyType: values[offset + 7] ?? 0,
  };
}

/**
 * Material name → appearance slot mapping.
 * When a GLB is loaded, materials matching these names get recolored.
 * Names are matched case-insensitively, with optional .001 suffix stripped.
 */
/** Color slots that map to GLB material names */
export type AppearanceColorSlot = 'shirtColor' | 'pantsColor' | 'shoesColor' | 'hairColor' | 'beltColor' | 'skinColor';

export const APPEARANCE_MATERIAL_MAP: Record<AppearanceColorSlot, string[]> = {
  shirtColor: ['Shirt', 'shirt openings', 'mat_4550'],
  pantsColor: ['pants'],
  shoesColor: ['socks'],
  hairColor:  ['Hair_1'],
  beltColor:  ['belt'],
  skinColor:  ['Skin'],
};

/** Get the palette array for a given color slot */
export function getPalette(slot: AppearanceColorSlot): [number, number, number][] {
  switch (slot) {
    case 'shirtColor': return SHIRT_COLORS;
    case 'pantsColor': return PANTS_COLORS;
    case 'shoesColor': return SHOES_COLORS;
    case 'hairColor':  return HAIR_COLORS;
    case 'beltColor':  return BELT_COLORS;
    case 'skinColor':  return SKIN_COLORS;
  }
}
