import { expect, test } from 'bun:test';
import { mergeObjectActionLabels } from './objectActions';

test('mergeObjectActionLabels inserts instance actions before examine', () => {
  expect(mergeObjectActionLabels(['Fill', 'Examine'], ['Throw sketch'])).toEqual([
    'Fill',
    'Throw sketch',
    'Examine',
  ]);
});

test('mergeObjectActionLabels skips duplicate and blank instance actions', () => {
  expect(mergeObjectActionLabels(['Fill', 'Examine'], ['Fill', '', '  ', 'Use'])).toEqual([
    'Fill',
    'Use',
    'Examine',
  ]);
});
