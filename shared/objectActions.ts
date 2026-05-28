export function mergeObjectActionLabels(
  baseActions: readonly string[],
  interactionActions: readonly string[] | undefined,
): readonly string[] {
  if (!interactionActions || interactionActions.length === 0) return baseActions;

  let merged: string[] | null = null;
  let insertAt = baseActions.indexOf('Examine');
  if (insertAt < 0) insertAt = baseActions.length;

  for (const rawAction of interactionActions ?? []) {
    const action = rawAction.trim();
    if (!action || baseActions.includes(action) || (merged !== null && merged.includes(action))) continue;
    if (merged === null) merged = [...baseActions];
    merged.splice(insertAt, 0, action);
    insertAt++;
  }

  return merged ?? baseActions;
}
