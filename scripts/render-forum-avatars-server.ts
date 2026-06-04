import { existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import sharp from 'sharp';
import { GameDatabase } from '../server/src/Database';
import type { ForumAvatarBakeTarget } from '../server/src/Database';
import type { ItemDef } from '../shared/types';
import { HAIR_COLORS, SKIN_COLORS, SHIRT_COLORS } from '../shared/appearance';

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const direct = Bun.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? null : null;
}

function rgb(triplet: [number, number, number] | undefined, boost = 1): string {
  const [r, g, b] = triplet ?? [0.25, 0.18, 0.12];
  return `rgb(${Math.round(Math.min(1, r * boost) * 255)},${Math.round(Math.min(1, g * boost) * 255)},${Math.round(Math.min(1, b * boost) * 255)})`;
}

function escapeXml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[char] ?? char));
}

function helmetColor(item: ItemDef | undefined): string {
  const name = item?.name.toLowerCase() ?? '';
  if (name.includes('black bronze')) return '#0c0301';
  if (name.includes('bronze')) return '#8d5f30';
  if (name.includes('iron')) return '#9ca2a6';
  if (name.includes('steel')) return '#bfc7cc';
  if (name.includes('mithril')) return '#5fa8a9';
  if (name.includes('wizard') || name.includes('blue')) return '#1f4f9a';
  if (name.includes('witch')) return '#26202f';
  if (name.includes('hood')) return '#4b3423';
  if (name.includes('leather') || name.includes('coif')) return '#6f4324';
  if (name.includes('hat')) return '#5b4a32';
  return '#8d9499';
}

function renderHelmet(item: ItemDef | undefined, mode: ItemDef['headRenderMode'] | undefined): string {
  if (!item) return '';
  const fill = helmetColor(item);
  const stroke = '#151515';
  if (mode === 'hat') {
    return `
      <path d="M29 48 C42 37 71 33 95 45 L88 54 C68 48 48 49 33 58 Z" fill="${fill}" stroke="${stroke}" stroke-width="4"/>
      <path d="M48 38 C50 18 73 14 82 38 C72 43 59 43 48 38 Z" fill="${fill}" stroke="${stroke}" stroke-width="4"/>
    `;
  }
  if (mode === 'hairTuck') {
    return `<path d="M32 49 C39 24 79 18 96 42 C91 58 76 62 55 58 C45 57 36 55 32 49 Z" fill="${fill}" stroke="${stroke}" stroke-width="4"/>`;
  }
  return `
    <path d="M30 55 C33 27 64 15 91 32 C103 42 100 66 87 82 C72 74 51 70 35 77 C31 70 29 63 30 55 Z" fill="${fill}" stroke="${stroke}" stroke-width="4"/>
    <path d="M40 57 C54 52 75 52 91 57" fill="none" stroke="#eef3f5" stroke-opacity="0.45" stroke-width="4"/>
    <path d="M43 70 L87 72 L84 82 L45 80 Z" fill="#111" opacity="0.78"/>
  `;
}

function renderAvatarSvg(target: ForumAvatarBakeTarget, item: ItemDef | undefined): string {
  const skin = rgb(SKIN_COLORS[target.appearance.skinColor], 1.85);
  const skinShade = rgb(SKIN_COLORS[target.appearance.skinColor], 1.15);
  const hair = rgb(HAIR_COLORS[target.appearance.hairColor], 1.35);
  const shirt = rgb(SHIRT_COLORS[target.appearance.shirtColor], 1.5);
  const mode = item?.headRenderMode;
  const showHair = !item || mode === 'hat' || mode === 'hairTuck';
  const showFace = !item || mode === 'hat' || mode === 'hairTuck';
  const initial = escapeXml(target.username.slice(0, 1).toUpperCase());

  return `
    <svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">
      <defs>
        <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
          <feDropShadow dx="0" dy="3" stdDeviation="2" flood-color="#000" flood-opacity="0.55"/>
        </filter>
        <linearGradient id="rim" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0" stop-color="#37251b"/>
          <stop offset="1" stop-color="#090706"/>
        </linearGradient>
      </defs>
      <rect x="5" y="5" width="118" height="118" rx="10" fill="url(#rim)" stroke="#6b5542" stroke-width="3"/>
      <circle cx="64" cy="60" r="49" fill="#15110e" opacity="0.92"/>
      <g filter="url(#shadow)">
        <path d="M33 119 C38 92 51 80 70 80 C89 80 101 93 105 119 Z" fill="${shirt}" stroke="#151515" stroke-width="4"/>
        ${showHair ? `<path d="M32 56 C34 30 58 18 82 28 C96 35 99 55 91 70 C83 48 58 43 38 63 Z" fill="${hair}" stroke="#151515" stroke-width="4"/>` : ''}
        ${showFace ? `
          <path d="M39 58 C42 34 65 25 84 37 C98 47 94 78 78 91 C61 101 41 84 39 58 Z" fill="${skin}" stroke="#151515" stroke-width="4"/>
          <path d="M80 42 C94 53 91 78 76 90 C84 72 85 56 80 42 Z" fill="${skinShade}" opacity="0.55"/>
          <ellipse cx="61" cy="60" rx="4" ry="5" fill="#111"/>
          <path d="M72 58 C76 57 80 58 83 61" fill="none" stroke="#111" stroke-width="3" stroke-linecap="round"/>
          <path d="M68 69 L63 75 L72 76" fill="none" stroke="#7a4a2d" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>
          <path d="M56 83 C63 87 72 87 80 82" fill="none" stroke="#472719" stroke-width="3" stroke-linecap="round"/>
        ` : `
          <text x="64" y="82" text-anchor="middle" font-family="Georgia,serif" font-size="44" font-weight="700" fill="#b63b2c">${initial}</text>
        `}
        ${renderHelmet(item, mode)}
      </g>
    </svg>
  `;
}

const rootDir = resolve(import.meta.dir, '..');
const dbPath = argValue('--db') || Bun.env.PROJECTRS_DB_PATH || resolve('projectrs.db');
const runtimeDataDir = Bun.env.PROJECTRS_RUNTIME_DATA_DIR ? resolve(Bun.env.PROJECTRS_RUNTIME_DATA_DIR) : resolve(rootDir, 'server/data');
const outDir = argValue('--out-dir') || Bun.env.FORUM_AVATAR_DIR || resolve(runtimeDataDir, 'forum-avatars');
const itemsPath = argValue('--items') || resolve(rootDir, 'server/data/items.json');
const onlyMissing = !Bun.argv.includes('--all');

const db = new GameDatabase(dbPath);
try {
  const items = await Bun.file(itemsPath).json() as ItemDef[];
  const itemById = new Map(items.map((item) => [item.id, item]));
  const targets = db.listForumAvatarBakeTargets();
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  let baked = 0;
  const errors: string[] = [];

  for (const target of targets) {
    const outPath = resolve(outDir, `${target.accountId}-${target.hash}.webp`);
    if (onlyMissing && existsSync(outPath)) continue;
    try {
      const svg = renderAvatarSvg(target, target.headItemId ? itemById.get(target.headItemId) : undefined);
      await sharp(Buffer.from(svg)).webp({ quality: 88, effort: 4 }).toFile(outPath);
      baked++;
    } catch (error) {
      errors.push(`${target.username}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  console.log(`[forum-avatar-render] baked ${baked}/${targets.length}`);
  for (const error of errors) console.warn(`[forum-avatar-render] ${error}`);
  if (errors.length > 0) process.exitCode = 1;
} finally {
  db.close();
}
