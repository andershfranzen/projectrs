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
