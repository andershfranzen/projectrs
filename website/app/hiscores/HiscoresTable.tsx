'use client';

import { useEffect, useMemo, useState } from 'react';

type HiscoreCategory = {
  id: string;
  name: string;
  hasXp: boolean;
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

type HiscoreProfileRow = {
  category: HiscoreCategory;
  rank: number;
  level: number;
  xp: number;
  dailyXp: number;
};

type HiscoreProfileResponse = {
  username: string;
  rows: HiscoreProfileRow[];
};

const fallbackCategories: HiscoreCategory[] = [
  { id: 'overall', name: 'Overall', hasXp: true },
  { id: 'combat', name: 'Combat', hasXp: true },
];

const formatNumber = new Intl.NumberFormat('en-US');
const PAGE_SIZE = 25;

export function HiscoresTable() {
  const [selected, setSelected] = useState('overall');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedPlayer, setSelectedPlayer] = useState('');
  const [data, setData] = useState<HiscoreResponse | null>(null);
  const [profile, setProfile] = useState<HiscoreProfileResponse | null>(null);
  const [error, setError] = useState('');
  const [profileError, setProfileError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [urlReady, setUrlReady] = useState(false);

  useEffect(() => {
    const readUrlState = () => {
      const params = new URLSearchParams(window.location.search);
      setSelected(params.get('category') || 'overall');
      setPage(Math.max(1, Math.floor(Number(params.get('page') || 1)) || 1));
      setSearch(params.get('q') || '');
      setSelectedPlayer(params.get('player') || '');
    };

    readUrlState();
    setUrlReady(true);
    window.addEventListener('popstate', readUrlState);
    return () => window.removeEventListener('popstate', readUrlState);
  }, []);

  useEffect(() => {
    if (!urlReady) return;
    const params = new URLSearchParams();
    if (selected !== 'overall') params.set('category', selected);
    if (page > 1) params.set('page', String(page));
    const trimmedSearch = search.trim();
    if (trimmedSearch) params.set('q', trimmedSearch);
    const trimmedPlayer = selectedPlayer.trim();
    if (trimmedPlayer) params.set('player', trimmedPlayer);

    const next = params.toString() ? `/hiscores?${params.toString()}` : '/hiscores';
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== next) window.history.replaceState(null, '', next);
  }, [selected, page, search, selectedPlayer, urlReady]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError('');

    const params = new URLSearchParams({
      category: selected,
      limit: String(PAGE_SIZE),
      page: String(page),
    });
    const trimmedSearch = search.trim();
    if (trimmedSearch) params.set('q', trimmedSearch);

    fetch(`/api/hiscores?${params.toString()}`, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('Hiscores are unavailable right now.');
        return res.json() as Promise<HiscoreResponse>;
      })
      .then((nextData) => {
        if (!cancelled) {
          setData(nextData);
          if (nextData.category.id !== selected) setSelected(nextData.category.id);
          if (nextData.page !== page) setPage(nextData.page);
        }
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
  }, [selected, page, search]);

  useEffect(() => {
    const username = selectedPlayer.trim();
    setProfile(null);
    setProfileError('');
    if (!username) {
      setIsProfileLoading(false);
      return;
    }

    let cancelled = false;
    setIsProfileLoading(true);
    fetch(`/api/hiscores/player?username=${encodeURIComponent(username)}`, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error(res.status === 404 ? 'Player profile not found.' : 'Player profile is unavailable right now.');
        return res.json() as Promise<HiscoreProfileResponse>;
      })
      .then((nextProfile) => {
        if (!cancelled) {
          setProfile(nextProfile);
          if (nextProfile.username !== selectedPlayer) setSelectedPlayer(nextProfile.username);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setProfileError(err.message || 'Player profile is unavailable right now.');
      })
      .finally(() => {
        if (!cancelled) setIsProfileLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedPlayer]);

  const categories = useMemo(() => data?.categories.length ? data.categories : fallbackCategories, [data]);
  const rows = data?.rows ?? [];
  const totalRows = data?.totalRows ?? rows.length;
  const totalPages = data?.totalPages ?? 1;
  const firstRow = rows.length > 0 ? ((data?.page ?? page) - 1) * (data?.pageSize ?? PAGE_SIZE) + 1 : 0;
  const lastRow = rows.length > 0 ? firstRow + rows.length - 1 : 0;
  const hasSearch = search.trim().length > 0;

  const selectCategory = (categoryId: string) => {
    setSelected(categoryId);
    setPage(1);
    setSelectedPlayer('');
    setProfile(null);
    setProfileError('');
  };

  const closeProfile = () => {
    setSelectedPlayer('');
    setProfile(null);
    setProfileError('');
  };

  return (
    <section className="panel hiscores-panel" aria-labelledby="hiscores-title">
      <div className="hiscores-heading">
        <h1 id="hiscores-title" className="panel-title">Hiscores</h1>
        <a className="back-link" href="/">Back to EvilQuest</a>
      </div>

      <div className="hiscores-layout">
        <aside className="hiscores-sidebar">
          <form className="hiscores-search" role="search" onSubmit={(event) => event.preventDefault()}>
            <label htmlFor="hiscores-player-search">Find Player</label>
            <input
              id="hiscores-player-search"
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setPage(1);
              }}
              placeholder="Search usernames"
              autoComplete="off"
            />
            {hasSearch ? (
              <button type="button" onClick={() => { setSearch(''); setPage(1); }}>
                Clear
              </button>
            ) : null}
          </form>

          <nav className="skill-nav" aria-label="Hiscore categories">
            {categories.map((category) => {
              const isInactiveSkill = category.hasXp === false;
              const classes = [
                'skill-tab',
                category.id === selected ? 'active' : '',
                isInactiveSkill ? 'inactive-skill' : '',
              ].filter(Boolean).join(' ');

              return (
                <button
                  className={classes}
                  key={category.id}
                  type="button"
                  title={isInactiveSkill ? 'No player has gained XP in this skill yet.' : undefined}
                  onClick={() => selectCategory(category.id)}
                >
                  {category.name}
                </button>
              );
            })}
          </nav>
        </aside>

        <div className="ranking-shell">
          {selectedPlayer ? (
            <section className="player-profile" aria-label={`${selectedPlayer} hiscore profile`}>
              <div className="player-profile-heading">
                <div>
                  <span>Player Profile</span>
                  <h2>{profile?.username ?? selectedPlayer}</h2>
                </div>
                <button type="button" onClick={closeProfile}>Close</button>
              </div>

              {isProfileLoading ? <p className="table-state compact-state">Loading profile...</p> : null}
              {profileError ? <p className="table-state compact-state">{profileError}</p> : null}

              {!isProfileLoading && !profileError && profile ? (
                <div className="hiscores-table-wrap">
                  <table className="hiscores-table profile-table">
                    <thead>
                      <tr>
                        <th scope="col">Skill</th>
                        <th scope="col">Rank</th>
                        <th scope="col">Level</th>
                        <th scope="col">XP</th>
                        <th scope="col">Daily XP</th>
                      </tr>
                    </thead>
                    <tbody>
                      {profile.rows.map((row) => (
                        <tr key={row.category.id}>
                          <td>{row.category.name}</td>
                          <td>{row.rank > 0 ? formatNumber.format(row.rank) : '-'}</td>
                          <td>{formatNumber.format(row.level)}</td>
                          <td>{formatNumber.format(row.xp)}</td>
                          <td className="daily-xp">{row.dailyXp > 0 ? `+${formatNumber.format(row.dailyXp)}` : '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : null}
            </section>
          ) : (
            <>
              <div className="ranking-title">
                <h2>{data?.category.name ?? 'Overall'}</h2>
                <span>
                  {isLoading
                    ? 'Loading ranks...'
                    : totalRows > 0
                      ? `${formatNumber.format(firstRow)}-${formatNumber.format(lastRow)} of ${formatNumber.format(totalRows)} adventurers`
                      : hasSearch ? 'No matching adventurers' : 'No ranked adventurers'}
                </span>
              </div>

              {error ? <p className="table-state">{error}</p> : null}
              {!error && !isLoading && rows.length === 0 ? (
                <p className="table-state">
                  {hasSearch ? `No saved characters match "${search.trim()}".` : 'No saved characters yet.'}
                </p>
              ) : null}

              {!error && rows.length > 0 ? (
                <>
                  <div className="hiscores-table-wrap">
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
                            <td>
                              <button
                                type="button"
                                className="player-link"
                                onClick={() => setSelectedPlayer(row.username)}
                              >
                                {row.username}
                              </button>
                            </td>
                            <td>{formatNumber.format(row.level)}</td>
                            <td>{formatNumber.format(row.xp)}</td>
                            <td className="daily-xp">{row.dailyXp > 0 ? `+${formatNumber.format(row.dailyXp)}` : '-'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="hiscores-pagination" aria-label="Hiscores pagination">
                    <button type="button" onClick={() => setPage(1)} disabled={page <= 1 || isLoading}>First</button>
                    <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || isLoading}>Previous</button>
                    <span>Page {formatNumber.format(data?.page ?? page)} of {formatNumber.format(totalPages)}</span>
                    <button type="button" onClick={() => setPage((current) => Math.min(totalPages, current + 1))} disabled={page >= totalPages || isLoading}>Next</button>
                    <button type="button" onClick={() => setPage(totalPages)} disabled={page >= totalPages || isLoading}>Last</button>
                  </div>
                </>
              ) : null}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
