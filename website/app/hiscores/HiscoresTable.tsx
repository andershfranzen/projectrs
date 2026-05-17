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
  dailyXp: number;
};

type HiscoreResponse = {
  category: HiscoreCategory;
  categories: HiscoreCategory[];
  rows: HiscoreRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
};

const fallbackCategories: HiscoreCategory[] = [
  { id: 'overall', name: 'Overall' },
  { id: 'combat', name: 'Combat' },
];

const formatNumber = new Intl.NumberFormat('en-US');
const PAGE_SIZE = 25;

export function HiscoresTable() {
  const [selected, setSelected] = useState('overall');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<HiscoreResponse | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError('');

    const params = new URLSearchParams({
      category: selected,
      limit: String(PAGE_SIZE),
      page: String(page),
    });

    fetch(`/api/hiscores?${params.toString()}`, { cache: 'no-store' })
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
  }, [selected, page]);

  const categories = useMemo(() => data?.categories.length ? data.categories : fallbackCategories, [data]);
  const rows = data?.rows ?? [];
  const totalRows = data?.totalRows ?? rows.length;
  const totalPages = data?.totalPages ?? 1;
  const firstRow = rows.length > 0 ? ((data?.page ?? page) - 1) * (data?.pageSize ?? PAGE_SIZE) + 1 : 0;
  const lastRow = rows.length > 0 ? firstRow + rows.length - 1 : 0;

  const selectCategory = (categoryId: string) => {
    setSelected(categoryId);
    setPage(1);
  };

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
              onClick={() => selectCategory(category.id)}
            >
              {category.name}
            </button>
          ))}
        </nav>

        <div className="ranking-shell">
          <div className="ranking-title">
            <h2>{data?.category.name ?? 'Overall'}</h2>
            <span>
              {isLoading
                ? 'Loading ranks...'
                : totalRows > 0
                  ? `${formatNumber.format(firstRow)}-${formatNumber.format(lastRow)} of ${formatNumber.format(totalRows)} adventurers`
                  : 'No ranked adventurers'}
            </span>
          </div>

          {error ? <p className="table-state">{error}</p> : null}
          {!error && !isLoading && rows.length === 0 ? <p className="table-state">No saved characters yet.</p> : null}

          {!error && rows.length > 0 ? (
            <>
              <table className="hiscores-table">
                <thead>
                  <tr>
                    <th scope="col">Rank</th>
                    <th scope="col">Name</th>
                    <th scope="col">Level</th>
                    <th scope="col">XP</th>
                    <th scope="col">Daily XP</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => (
                    <tr key={`${row.rank}-${row.username}`}>
                      <td>{row.rank}</td>
                      <td>{row.username}</td>
                      <td>{formatNumber.format(row.level)}</td>
                      <td>{formatNumber.format(row.xp)}</td>
                      <td className="daily-xp">{row.dailyXp > 0 ? `+${formatNumber.format(row.dailyXp)}` : '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="hiscores-pagination" aria-label="Hiscores pagination">
                <button type="button" onClick={() => setPage(1)} disabled={page <= 1 || isLoading}>First</button>
                <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || isLoading}>Previous</button>
                <span>Page {formatNumber.format(data?.page ?? page)} of {formatNumber.format(totalPages)}</span>
                <button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages || isLoading}>Next</button>
                <button type="button" onClick={() => setPage(totalPages)} disabled={page >= totalPages || isLoading}>Last</button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </section>
  );
}
