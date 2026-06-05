import { expect, test } from 'bun:test';
import { readFileSync } from 'fs';

test('object definitions with Examine have authored examine text', () => {
  const objects = JSON.parse(readFileSync('server/data/objects.json', 'utf8')) as Array<{
    id: number;
    name: string;
    actions?: string[];
    examineText?: string;
  }>;

  const missing = objects
    .filter(obj => obj.actions?.includes('Examine'))
    .filter(obj => !obj.examineText?.trim())
    .map(obj => `${obj.id}:${obj.name}`);

  expect(missing).toEqual([]);
});

test('harvestable vegetation has intentional examine text', () => {
  const objects = JSON.parse(readFileSync('server/data/objects.json', 'utf8')) as Array<{
    name: string;
    examineText?: string;
  }>;
  const byName = new Map(objects.map(obj => [obj.name, obj]));

  const expectedText: Record<string, string> = {
    'Tree': 'A broad village tree, rough-barked and heavy with branches. It should yield plain logs.',
    'Oak Tree': 'A stout oak with a thick trunk and stubborn grain. Good wood for stronger bows and boards.',
    'Willow Tree': 'A willow tree trailing soft green branches. Its flexible wood is prized by careful fletchers.',
    'Dead Tree': 'A dead tree, grey and splintered. The dry branches look ready to snap under an axe.',
    'Maple Tree': 'A maple with a warm-coloured trunk and close, clean grain. The logs should carve neatly.',
    'Yew Tree': 'An old yew with dark needles and dense heartwood. A patient woodcutter could make something fine from it.',
    'Rice Plant': 'Slender rice stalks hang heavy with pale grains. Harvest them gently before the field scatters.',
    'Potato Plant': 'A low potato plant with healthy leaves. The useful part is hidden in the soil below.',
    'Cauliflower Plant': 'Broad leaves cradle a pale cauliflower head. It looks ready to pull before it toughens.',
    'Wheat Plant': 'A small stand of ripe wheat, dry and golden at the tips. It should thresh into useful grain.',
  };

  for (const [name, examineText] of Object.entries(expectedText)) {
    expect(byName.get(name)?.examineText).toBe(examineText);
  }
});
