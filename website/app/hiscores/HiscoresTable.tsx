'use client';

import { useEffect, useMemo, useState } from 'react';

type HiscoreCategory = {
  id: string;
  name: string;
};

type HiscoreRow = {
  rank: number;
  username: string;
  level: number;
  xp: number;
};

type HiscoreResponse = {
  category: HiscoreCategory;
  categories: HiscoreCategory[];
  rows: HiscoreRow[];
};

const fallbackCategories: HiscoreCategory[] = [
  { id: 'overall', name: 'Overall' },
  { id: 'combat', name: 'Combat' },
];

const formatNumber = new Intl.NumberFormat('en-US');

export function HiscoresTable() {
  const [selected, setSelected] = useState('overall');
  const [data, setData] = useState<HiscoreResponse | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError('');

    fetch(`/api/hiscores?category=${encodeURIComponent(selected)}&limit=100`, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('Hiscores are unavailable right now.');
        return res.json() as Promise<HiscoreResponse>;
      })
      .then((nextData) => {
        if (!cancelled) setData(nextData);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || 'Hiscores are unavailable right now.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selected]);

  const categories = useMemo(() => data?.categories.length ? data.categories : fallbackCategories, [data]);
  const rows = data?.rows ?? [];

  return (
    <section className="panel hiscores-panel" aria-labelledby="hiscores-title">
      <div className="hiscores-heading">
        <h1 id="hiscores-title" className="panel-title">Hiscores</h1>
        <a className="back-link" href="/">Back to EvilQuest</a>
      </div>

      <div className="hiscores-layout">
        <nav className="skill-nav" aria-label="Hiscore categories">
          {categories.map((category) => (
            <button
              className={category.id === selected ? 'skill-tab active' : 'skill-tab'}
              key={category.id}
              type="button"
              onClick={() => setSelected(category.id)}
            >
              {category.name}
            </button>
          ))}
        </nav>

        <div className="ranking-shell">
          <div className="ranking-title">
            <h2>{data?.category.name ?? 'Overall'}</h2>
            <span>{isLoading ? 'Loading ranks...' : `${rows.length} ranked adventurers`}</span>
          </div>

          {error ? <p className="table-state">{error}</p> : null}
          {!error && !isLoading && rows.length === 0 ? <p className="table-state">No saved characters yet.</p> : null}

          {!error && rows.length > 0 ? (
            <table className="hiscores-table">
              <thead>
                <tr>
                  <th scope="col">Rank</th>
                  <th scope="col">Name</th>
                  <th scope="col">Level</th>
                  <th scope="col">XP</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={`${row.rank}-${row.username}`}>
                    <td>{row.rank}</td>
                    <td>{row.username}</td>
                    <td>{formatNumber.format(row.level)}</td>
                    <td>{formatNumber.format(row.xp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
      </div>
    </section>
  );
}
