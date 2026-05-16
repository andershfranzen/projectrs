'use client';

import { useEffect, useState } from 'react';

async function fetchOnlinePlayers(): Promise<number> {
  const res = await fetch('/api/status', { cache: 'no-store' });
  if (!res.ok) throw new Error('Failed to load status');
  const data = await res.json() as { onlinePlayers?: unknown };
  return typeof data.onlinePlayers === 'number' ? data.onlinePlayers : 0;
}

export function OnlineCount() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const next = await fetchOnlinePlayers();
        if (!cancelled) setCount(next);
      } catch {
        if (!cancelled) setCount(0);
      }
    };

    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  return (
    <div className="online" aria-live="polite">
      <strong>{count ?? 0}</strong> {count === 1 ? 'person is' : 'people are'} currently playing!
    </div>
  );
}
