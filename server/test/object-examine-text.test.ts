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
    'Rice Plant': 'Patiently becoming dinner.',
    'Potato Plant': 'Patiently becoming dinner.',
    'Cauliflower Plant': 'Patiently becoming dinner.',
    'Wheat Plant': 'Patiently becoming dinner.',
  };

  for (const [name, examineText] of Object.entries(expectedText)) {
    expect(byName.get(name)?.examineText).toBe(examineText);
  }
});

test('selected scenery stations keep their easter egg examine text', () => {
  const objects = JSON.parse(readFileSync('server/data/objects.json', 'utf8')) as Array<{
    name: string;
    examineText?: string;
  }>;
  const byName = new Map(objects.map(obj => [obj.name, obj]));

  expect(byName.get('Well')?.examineText).toBe('The water reflects someone who should probably get back to work.');
  expect(byName.get('Pottery Wheel')?.examineText).toBe('The wheel spins clay into pottery and patience into regret.');
});
