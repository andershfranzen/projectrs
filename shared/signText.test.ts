import { expect, test } from 'bun:test';
import {
  MAX_SIGN_TEXT_LINE_LENGTH,
  SIGN_READ_ACTION,
  normalizeSignText,
  placedObjectInteractionsWithSignText,
  signTextToSaySequence,
} from './signText';

test('normalizeSignText trims blank lines and normalizes whitespace', () => {
  expect(normalizeSignText('  North   gate  \n\n  Mine\troad  ')).toBe('North gate\nMine road');
});

test('signTextToSaySequence wraps long sign text into delayed overhead lines', () => {
  const text = `first ${'word '.repeat(40)}last`;
  const sequence = signTextToSaySequence(text);

  expect(sequence.length).toBeGreaterThan(1);
  expect(sequence[0].delaySeconds).toBeUndefined();
  expect(sequence[1].delaySeconds).toBe(3);
  expect(sequence.every(line => line.text.length <= MAX_SIGN_TEXT_LINE_LENGTH)).toBe(true);
});

test('placedObjectInteractionsWithSignText adds a Read interaction before custom effects', () => {
  const interactions = placedObjectInteractionsWithSignText({
    signText: 'Beware the mines.',
    interactions: [{ action: 'Search', message: 'Nothing else is written here.' }],
  });

  expect(interactions).toEqual([
    { action: SIGN_READ_ACTION, say: 'Beware the mines.' },
    { action: 'Search', message: 'Nothing else is written here.' },
  ]);
});

test('placedObjectInteractionsWithSignText merges sign text into existing Read effect', () => {
  const interactions = placedObjectInteractionsWithSignText({
    signText: 'Only the worthy may pass.',
    interactions: [{ action: SIGN_READ_ACTION, message: 'You read the old sign.' }],
  });

  expect(interactions).toEqual([
    { action: SIGN_READ_ACTION, message: 'You read the old sign.', say: 'Only the worthy may pass.' },
  ]);
});

test('placedObjectInteractionsWithSignText keeps conditioned Read effects readable', () => {
  const interactions = placedObjectInteractionsWithSignText({
    signText: 'The old road is washed out.',
    interactions: [{
      action: SIGN_READ_ACTION,
      message: 'A hidden mark appears beneath the text.',
      condition: { type: 'questStarted', questId: 'old-road' },
    }],
  });

  expect(interactions).toEqual([
    {
      action: SIGN_READ_ACTION,
      message: 'A hidden mark appears beneath the text.',
      condition: { type: 'questStarted', questId: 'old-road' },
      say: 'The old road is washed out.',
    },
    { action: SIGN_READ_ACTION, say: 'The old road is washed out.' },
  ]);
});

test('placedObjectInteractionsWithSignText removes legacy examine message duplicates', () => {
  const interactions = placedObjectInteractionsWithSignText({
    signText: 'North road.\nSouth mine.',
    interactions: [{ action: 'Examine', message: 'North road.\nSouth mine.' }],
  });

  expect(interactions).toEqual([
    { action: SIGN_READ_ACTION, saySequence: [
      { text: 'North road.' },
      { text: 'South mine.', delaySeconds: 3 },
    ] },
  ]);
});

test('placedObjectInteractionsWithSignText preserves custom examine effects', () => {
  const interactions = placedObjectInteractionsWithSignText({
    signText: 'North road.',
    interactions: [{
      action: 'Examine',
      message: 'North road.',
      effects: [{ type: 'setQuestStage', questId: 'road-sign', stage: 1 }],
    }],
  });

  expect(interactions).toEqual([
    { action: SIGN_READ_ACTION, say: 'North road.' },
    {
      action: 'Examine',
      message: 'North road.',
      effects: [{ type: 'setQuestStage', questId: 'road-sign', stage: 1 }],
    },
  ]);
});
