import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { marked } from 'marked';
import sanitizeHtml from 'sanitize-html';

const NEWS_DIR = join(process.cwd(), 'news');
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export interface NewsPostSummary {
  slug: string;
  title: string;
  date: string;
  formattedDate: string;
  timestamp: number;
  summary: string;
}

export interface NewsPost extends NewsPostSummary {
  html: string;
}

interface ParsedNewsFile {
  slug: string;
  title: string;
  date: string;
  timestamp: number;
  summary: string;
  draft: boolean;
  body: string;
}

function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } {
  const match = raw.match(FRONTMATTER_RE);
  if (!match) return { data: {}, body: raw.trim() };

  const data: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf(':');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    data[key] = value;
  }

  return { data, body: raw.slice(match[0].length).trim() };
}

function titleFromBody(body: string): string {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || '';
}

function summaryFromBody(body: string): string {
  return body
    .replace(/^#.+$/gm, '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, '')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/[#>*_`~-]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function parseNewsDate(rawDate: string, fileName: string): { date: string; timestamp: number; formattedDate: string } {
  const date = rawDate.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`News post "${fileName}" must use a YYYY-MM-DD date.`);
  }

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`News post "${fileName}" has an invalid date.`);
  }

  return {
    date,
    timestamp: parsed.getTime(),
    formattedDate: new Intl.DateTimeFormat('en', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(parsed),
  };
}

function readNewsFiles(): ParsedNewsFile[] {
  if (!existsSync(NEWS_DIR)) return [];

  const posts = readdirSync(NEWS_DIR)
    .filter((fileName) => extname(fileName).toLowerCase() === '.md' && !fileName.startsWith('_'))
    .map((fileName) => {
      const filePath = join(NEWS_DIR, fileName);
      const { data, body } = parseFrontmatter(readFileSync(filePath, 'utf8'));
      const slug = normalizeSlug(data.slug || basename(fileName, '.md'));
      if (!slug) throw new Error(`News post "${fileName}" needs a usable slug or filename.`);

      const title = data.title || titleFromBody(body);
      if (!title) throw new Error(`News post "${fileName}" needs a title in frontmatter or a top-level heading.`);

      if (!data.date) throw new Error(`News post "${fileName}" needs a date in frontmatter.`);
      const { date, timestamp } = parseNewsDate(data.date, fileName);

      return {
        slug,
        title,
        date,
        timestamp,
        summary: data.summary || summaryFromBody(body),
        draft: data.draft === 'true',
        body,
      };
    })
    .filter((post) => !post.draft);

  const slugs = new Set<string>();
  for (const post of posts) {
    if (slugs.has(post.slug)) throw new Error(`Duplicate news slug "${post.slug}".`);
    slugs.add(post.slug);
  }

  return posts.sort((a, b) => b.timestamp - a.timestamp || a.title.localeCompare(b.title));
}

function toSummary(post: ParsedNewsFile): NewsPostSummary {
  return {
    slug: post.slug,
    title: post.title,
    date: post.date,
    formattedDate: parseNewsDate(post.date, post.slug).formattedDate,
    timestamp: post.timestamp,
    summary: post.summary,
  };
}

function renderMarkdown(body: string): string {
  const html = marked.parse(body, { async: false, gfm: true }) as string;

  return sanitizeHtml(html, {
    allowedTags: sanitizeHtml.defaults.allowedTags.concat(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img']),
    allowedAttributes: {
      ...sanitizeHtml.defaults.allowedAttributes,
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'width', 'height'],
    },
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer' }),
    },
  });
}

export function getAllNewsPosts(): NewsPostSummary[] {
  return readNewsFiles().map(toSummary);
}

export function getLatestNewsPosts(limit = 5): NewsPostSummary[] {
  return getAllNewsPosts().slice(0, limit);
}

export function getNewsPost(slug: string): NewsPost | null {
  const normalizedSlug = normalizeSlug(slug);
  const parsed = readNewsFiles().find((post) => post.slug === normalizedSlug);
  if (!parsed) return null;

  return {
    ...toSummary(parsed),
    html: renderMarkdown(parsed.body),
  };
}
