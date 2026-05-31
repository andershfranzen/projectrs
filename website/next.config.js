import { PHASE_DEVELOPMENT_SERVER } from 'next/constants.js';
import fs from 'node:fs';
import path from 'node:path';

function rootEnvValue(name) {
  const envPath = path.resolve(process.cwd(), '..', '.env');
  try {
    const contents = fs.readFileSync(envPath, 'utf8');
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const separator = trimmed.indexOf('=');
      if (separator === -1) continue;
      if (trimmed.slice(0, separator).trim() !== name) continue;
      return trimmed.slice(separator + 1).trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {
    return '';
  }
  return '';
}

const recaptchaSiteKey = process.env.NEXT_PUBLIC_RECAPTCHA_SITE_KEY
  || process.env.VITE_RECAPTCHA_SITE_KEY
  || rootEnvValue('VITE_RECAPTCHA_SITE_KEY')
  || '';

/** @type {(phase: string) => import('next').NextConfig} */
const nextConfig = (phase) => ({
  output: 'export',
  ...(phase === PHASE_DEVELOPMENT_SERVER ? {} : { distDir: 'dist' }),
  env: {
    NEXT_PUBLIC_RECAPTCHA_SITE_KEY: recaptchaSiteKey,
  },
  images: {
    unoptimized: true,
  },
});

export default nextConfig;
