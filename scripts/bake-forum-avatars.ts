import { chromium } from 'playwright';
import { existsSync } from 'fs';

type BakeResult = { ok: boolean; baked: number; total: number; errors: string[] };

declare global {
  interface Window {
    __forumAvatarBakeDone?: boolean;
    __forumAvatarBakeResult?: BakeResult;
    __forumAvatarBakeSecret?: string;
  }
}

function argValue(name: string): string | null {
  const prefix = `${name}=`;
  const direct = Bun.argv.find((arg) => arg.startsWith(prefix));
  if (direct) return direct.slice(prefix.length);
  const index = Bun.argv.indexOf(name);
  return index >= 0 ? Bun.argv[index + 1] ?? null : null;
}

const origin = (argValue('--origin') || Bun.env.FORUM_AVATAR_BAKE_ORIGIN || 'http://localhost:4000').replace(/\/+$/, '');
const onlyMissing = !Bun.argv.includes('--all');
const timeoutMs = Math.max(10_000, Number(argValue('--timeout-ms') || Bun.env.FORUM_AVATAR_BAKE_TIMEOUT_MS || 120_000));
const failOnError = Bun.argv.includes('--fail-on-error');
const url = `${origin}/forums/avatar-bake?autorun=${onlyMissing ? 'missing' : 'all'}`;
const bakeSecret = Bun.env.FORUM_AVATAR_BAKE_SECRET || '';
const chromiumExecutablePath = Bun.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH
  || ['/usr/bin/chromium-browser', '/usr/bin/chromium'].find((path) => existsSync(path));

console.log(`[forum-avatar-bake] opening ${url}`);

let browser: Awaited<ReturnType<typeof chromium.launch>> | null = null;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: chromiumExecutablePath,
    args: [
      '--disable-dev-shm-usage',
      '--no-sandbox',
      '--enable-webgl',
      '--ignore-gpu-blocklist',
      '--enable-unsafe-swiftshader',
      '--use-gl=swiftshader',
    ],
  });
  const page = await browser.newPage({ viewport: { width: 900, height: 760 } });
  if (bakeSecret) {
    await page.addInitScript((secret) => {
      window.__forumAvatarBakeSecret = secret;
    }, bakeSecret);
  }
  const pageErrors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') console.warn(`[forum-avatar-bake] browser: ${message.text()}`);
  });
  page.on('pageerror', (error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    pageErrors.push(message);
    console.warn(`[forum-avatar-bake] pageerror: ${message}`);
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
  await page.waitForFunction(() => window.__forumAvatarBakeDone === true, undefined, { timeout: timeoutMs });
  const result = await page.evaluate(() => window.__forumAvatarBakeResult ?? { ok: false, baked: 0, total: 0, errors: ['Bake page did not report a result.'] }) as BakeResult;
  result.errors.push(...pageErrors);
  result.ok = result.ok && pageErrors.length === 0;
  console.log(`[forum-avatar-bake] baked ${result.baked}/${result.total}`);
  for (const error of result.errors) console.warn(`[forum-avatar-bake] ${error}`);
  if (failOnError && !result.ok) process.exitCode = 1;
} catch (error) {
  console.warn(`[forum-avatar-bake] failed: ${error instanceof Error ? error.message : String(error)}`);
  if (failOnError) process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
}
