import type { PlacedObjectInteraction, PlacedObjectSayLine } from './types';

export const SIGN_READ_ACTION = 'Read';
export const MAX_SIGN_TEXT_LENGTH = 1000;
export const MAX_SIGN_TEXT_LINE_LENGTH = 140;
export const MAX_SIGN_TEXT_LINES = 8;
export const SIGN_TEXT_LINE_DELAY_SECONDS = 3;

export interface PlacedObjectSignTextSource {
  signText?: string;
  interactions?: PlacedObjectInteraction[];
}

export function normalizeSignText(value: unknown): string {
  if (typeof value !== 'string') return '';

  const normalized = value
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')
    .slice(0, MAX_SIGN_TEXT_LENGTH)
    .trim();

  return normalized;
}

function pushWrappedSignLine(lines: string[], line: string): void {
  let remaining = line;
  while (remaining.length > 0 && lines.length < MAX_SIGN_TEXT_LINES) {
    if (remaining.length <= MAX_SIGN_TEXT_LINE_LENGTH) {
      lines.push(remaining);
      return;
    }

    const softBreak = remaining.lastIndexOf(' ', MAX_SIGN_TEXT_LINE_LENGTH);
    const breakAt = softBreak >= 40 ? softBreak : MAX_SIGN_TEXT_LINE_LENGTH;
    const next = remaining.slice(0, breakAt).trim();
    if (next) lines.push(next);
    remaining = remaining.slice(breakAt).trim();
  }
}

export function signTextToSaySequence(value: unknown): PlacedObjectSayLine[] {
  const text = normalizeSignText(value);
  if (!text) return [];

  const lines: string[] = [];
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    pushWrappedSignLine(lines, line);
    if (lines.length >= MAX_SIGN_TEXT_LINES) break;
  }

  return lines.map((line, index) => ({
    text: line,
    ...(index > 0 ? { delaySeconds: index * SIGN_TEXT_LINE_DELAY_SECONDS } : {}),
  }));
}

function withSignSayFields(
  interaction: PlacedObjectInteraction,
  sequence: PlacedObjectSayLine[],
): PlacedObjectInteraction {
  const next: PlacedObjectInteraction = { ...interaction, action: SIGN_READ_ACTION };
  delete next.say;
  delete next.saySequence;

  if (sequence.length === 1) next.say = sequence[0].text;
  else next.saySequence = sequence;

  return next;
}

function hasInteractionConditions(interaction: PlacedObjectInteraction): boolean {
  return !!interaction.condition || (Array.isArray(interaction.conditions) && interaction.conditions.length > 0);
}

function isLegacySignTextExamineInteraction(interaction: PlacedObjectInteraction, signText: string): boolean {
  if (interaction?.action?.trim() !== 'Examine') return false;
  if (normalizeSignText(interaction.message) !== signText) return false;
  if (typeof interaction.say === 'string' && interaction.say.trim()) return false;
  if (Array.isArray(interaction.saySequence) && interaction.saySequence.length > 0) return false;
  if (hasInteractionConditions(interaction)) return false;
  if (Array.isArray(interaction.effects) && interaction.effects.length > 0) return false;
  if (interaction.depleteObject === true) return false;
  if (interaction.depleteRespawnTicks != null) return false;
  return true;
}

export function placedObjectInteractionsWithSignText(
  source: PlacedObjectSignTextSource,
): PlacedObjectInteraction[] | undefined {
  const signText = normalizeSignText(source.signText);
  const interactions = (Array.isArray(source.interactions) ? source.interactions : [])
    .filter(interaction => !signText || !isLegacySignTextExamineInteraction(interaction, signText));
  const sequence = signTextToSaySequence(signText);
  if (sequence.length === 0) return interactions.length > 0 ? interactions : undefined;

  let hasReadInteraction = false;
  let hasUnconditionalReadInteraction = false;
  const withSignText = interactions.map(interaction => {
    if (interaction?.action?.trim() !== SIGN_READ_ACTION) return interaction;
    hasReadInteraction = true;
    if (!hasInteractionConditions(interaction)) hasUnconditionalReadInteraction = true;
    return withSignSayFields(interaction, sequence);
  });

  if (hasReadInteraction) {
    if (hasUnconditionalReadInteraction) return withSignText;
    return [...withSignText, withSignSayFields({ action: SIGN_READ_ACTION }, sequence)];
  }

  const readInteraction = withSignSayFields({ action: SIGN_READ_ACTION }, sequence);
  return [readInteraction, ...interactions];
}
