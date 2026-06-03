'use client';

import { useEffect, useState } from 'react';

/**
 * Renders a date in the viewer's own locale (e.g. a Danish browser shows
 * "2. jun. 2026" instead of "Jun 2, 2026").
 *
 * News dates are produced on the server, which cannot know the viewer's locale,
 * so we render the server-formatted `fallback` first (matching SSR markup to
 * avoid a hydration mismatch) and re-localize once mounted in the browser.
 *
 * `iso` is a date-only `YYYY-MM-DD`; we pin it to UTC so the calendar day of
 * publication never shifts based on the viewer's timezone.
 */
export function LocalDate({ iso, fallback }: { iso: string; fallback: string }) {
  const [text, setText] = useState(fallback);

  useEffect(() => {
    const parsed = new Date(`${iso}T00:00:00.000Z`);
    if (Number.isNaN(parsed.getTime())) return;
    setText(new Intl.DateTimeFormat(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      timeZone: 'UTC',
    }).format(parsed));
  }, [iso]);

  return <time dateTime={iso}>{text}</time>;
}
