'use client';

import { useEffect, useMemo, useState } from 'react';
import { MonsterPreview, type NpcVisualProfile } from './MonsterPreview';

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
  rankChange: number | null;
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
  rankChange: number | null;
};

type HiscoreProfileResponse = {
  username: string;
  avatarUrl: string;
  rows: HiscoreProfileRow[];
  monsterKills: HiscoreProfileMonsterKillRow[];
};

type HiscoreProfileMonsterKillRow = {
  npcDefId: number;
  name: string;
  rank: number;
  kills: number;
  dailyKills: number;
};

// Mob-kill leaderboard shapes — mirror server/src/Database.ts (MobKillResponse).
// Kept in sync manually; there is no shared type import across the
// website/server boundary (see CLAUDE.md).
type MobKillMob = {
  id: number;
  name: string;
  visual?: NpcVisualProfile;
};

type MobKillRow = {
  rank: number;
  username: string;
  kills: number;
};

type MobKillResponse = {
  npcDefId: number;
  mobName: string;
  visual?: NpcVisualProfile;
  mobs: MobKillMob[];
  rows: MobKillRow[];
  page: number;
  pageSize: number;
  totalRows: number;
  totalPages: number;
};

type SortDirection = 'asc' | 'desc';
type SortState<T extends string> = {
  key: T;
  direction: SortDirection;
};

type MainSortKey = 'rank' | 'username' | 'level' | 'xp' | 'dailyXp';
type KillSortKey = 'rank' | 'username' | 'kills';
type ProfileSortKey = 'category' | 'rank' | 'level' | 'xp' | 'dailyXp';
type ProfileMonsterSortKey = 'rank' | 'name' | 'kills' | 'dailyKills';

const fallbackCategories: HiscoreCategory[] = [
  { id: 'overall', name: 'Overall', hasXp: true },
];

// Synthetic category for the Monster Kills view. It is NOT a server skill category
// (that list comes from /api/hiscores); it is appended client-side and routes
// to the dedicated /api/hiscores/kills endpoint. hasXp:true keeps it styled as
// a normal active tab rather than a greyed "no XP yet" skill.
const MOB_KILLS_CATEGORY: HiscoreCategory = { id: 'mobkills', name: 'Monster Kills', hasXp: true };

const formatNumber = new Intl.NumberFormat('en-US');
const PAGE_SIZE = 25;

function compareText(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

function applyDirection(value: number, direction: SortDirection): number {
  return direction === 'asc' ? value : -value;
}

function sortRows<T>(rows: readonly T[], compare: (a: T, b: T) => number, direction: SortDirection): T[] {
  return [...rows].sort((a, b) => applyDirection(compare(a, b), direction));
}

function nextSort<T extends string>(current: SortState<T>, key: T): SortState<T> {
  if (current.key !== key) return { key, direction: 'asc' };
  return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
}

function rankedCategories(categories: HiscoreCategory[]): HiscoreCategory[] {
  return categories.filter((category) => category.id !== 'combat');
}

function SortHeader<T extends string>({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: T;
  sort: SortState<T>;
  onSort: (key: T) => void;
  className?: string;
}) {
  const active = sort.key === sortKey;
  const directionLabel = active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'not sorted';

  return (
    <th className={className} scope="col" aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
      <button
        type="button"
        className="sort-header-button"
        onClick={() => onSort(sortKey)}
        aria-label={`Sort by ${label}, ${directionLabel}`}
      >
        <span>{label}</span>
        <span className="sort-indicator" aria-hidden="true">{active ? (sort.direction === 'asc' ? '▲' : '▼') : '↕'}</span>
      </button>
    </th>
  );
}

function RankCell({ rank, rankChange }: { rank: number; rankChange?: number | null }) {
  const hasMovement = typeof rankChange === 'number' && rankChange !== 0;
  const movementClass = rankChange != null && rankChange > 0 ? 'up' : 'down';

  return (
    <span className="rank-value">
      {hasMovement ? (
        <span className={`rank-movement ${movementClass}`}>
          {rankChange! > 0 ? '▲' : '▼'}{formatNumber.format(Math.abs(rankChange!))}
        </span>
      ) : null}
      <span>{rank > 0 ? formatNumber.format(rank) : '-'}</span>
    </span>
  );
}

export function HiscoresTable() {
  const [selected, setSelected] = useState('overall');
  const [selectedMob, setSelectedMob] = useState('');
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [selectedPlayer, setSelectedPlayer] = useState('');
  const [data, setData] = useState<HiscoreResponse | null>(null);
  const [killData, setKillData] = useState<MobKillResponse | null>(null);
  const [skillCategories, setSkillCategories] = useState<HiscoreCategory[]>(fallbackCategories);
  const [skillCategoriesLoaded, setSkillCategoriesLoaded] = useState(false);
  const [profile, setProfile] = useState<HiscoreProfileResponse | null>(null);
  const [error, setError] = useState('');
  const [profileError, setProfileError] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isProfileLoading, setIsProfileLoading] = useState(false);
  const [urlReady, setUrlReady] = useState(false);
  const [mainSort, setMainSort] = useState<SortState<MainSortKey>>({ key: 'rank', direction: 'asc' });
  const [killSort, setKillSort] = useState<SortState<KillSortKey>>({ key: 'rank', direction: 'asc' });
  const [profileSort, setProfileSort] = useState<SortState<ProfileSortKey>>({ key: 'category', direction: 'asc' });
  const [profileMonsterSort, setProfileMonsterSort] = useState<SortState<ProfileMonsterSortKey>>({ key: 'kills', direction: 'desc' });

  const isKillsMode = selected === 'mobkills';

  useEffect(() => {
    const readUrlState = () => {
      const params = new URLSearchParams(window.location.search);
      const category = params.get('category') || 'overall';
      setSelected(category === 'combat' ? 'overall' : category);
      setSelectedMob(params.get('mob') || '');
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
    if (isKillsMode && selectedMob) params.set('mob', selectedMob);
    if (page > 1) params.set('page', String(page));
    const trimmedSearch = search.trim();
    if (trimmedSearch) params.set('q', trimmedSearch);
    const trimmedPlayer = selectedPlayer.trim();
    if (trimmedPlayer) params.set('player', trimmedPlayer);

    const next = params.toString() ? `/hiscores?${params.toString()}` : '/hiscores';
    const current = `${window.location.pathname}${window.location.search}`;
    if (current !== next) window.history.replaceState(null, '', next);
  }, [selected, selectedMob, page, search, selectedPlayer, isKillsMode, urlReady]);

  // Skill-category rankings (Overall / individual skills).
  useEffect(() => {
    if (!urlReady || isKillsMode) return;
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
          if (nextData.categories.length) {
            setSkillCategories(rankedCategories(nextData.categories));
            setSkillCategoriesLoaded(true);
          }
          if (nextData.category.id !== selected && nextData.category.id !== 'combat') setSelected(nextData.category.id);
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
  }, [selected, page, search, isKillsMode, urlReady]);

  // Per-mob kill leaderboard. Separate endpoint + state so switching modes
  // never clobbers the skill rankings or the category nav.
  useEffect(() => {
    if (!urlReady || !isKillsMode) return;
    let cancelled = false;
    setIsLoading(true);
    setError('');

    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      page: String(page),
    });
    if (selectedMob) params.set('npc', selectedMob);
    const trimmedSearch = search.trim();
    if (trimmedSearch) params.set('q', trimmedSearch);

    fetch(`/api/hiscores/kills?${params.toString()}`, { cache: 'no-store' })
      .then((res) => {
        if (!res.ok) throw new Error('Mob kill rankings are unavailable right now.');
        return res.json() as Promise<MobKillResponse>;
      })
      .then((nextData) => {
        if (!cancelled) {
          setKillData(nextData);
          // The server resolves a default mob when none was supplied; reflect
          // it in the picker (guarded so it doesn't loop on itself).
          if (String(nextData.npcDefId) !== selectedMob) setSelectedMob(String(nextData.npcDefId));
          if (nextData.page !== page) setPage(nextData.page);
        }
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || 'Mob kill rankings are unavailable right now.');
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedMob, page, search, isKillsMode, urlReady]);

  // When the page is opened directly in Monster Kills mode, the skill data fetch is
  // skipped — so pull the category list once to keep the full nav populated.
  useEffect(() => {
    if (!urlReady || !isKillsMode || skillCategoriesLoaded) return;
    let cancelled = false;
    fetch('/api/hiscores?category=overall&limit=5&page=1', { cache: 'no-store' })
      .then((res) => (res.ok ? (res.json() as Promise<HiscoreResponse>) : null))
      .then((d) => {
        if (!cancelled && d?.categories?.length) {
          setSkillCategories(rankedCategories(d.categories));
          setSkillCategoriesLoaded(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [urlReady, isKillsMode, skillCategoriesLoaded]);

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

  const categories = useMemo(() => [MOB_KILLS_CATEGORY, ...rankedCategories(skillCategories)], [skillCategories]);
  const activeData = isKillsMode ? killData : data;
  const rowCount = activeData?.rows.length ?? 0;
  const totalRows = activeData?.totalRows ?? rowCount;
  const totalPages = activeData?.totalPages ?? 1;
  const pageSize = activeData?.pageSize ?? PAGE_SIZE;
  const responsePage = activeData?.page ?? page;
  const firstRow = rowCount > 0 ? (responsePage - 1) * pageSize + 1 : 0;
  const lastRow = rowCount > 0 ? firstRow + rowCount - 1 : 0;
  const hasSearch = search.trim().length > 0;
  const rankingTitle = isKillsMode ? (killData?.mobName ?? 'Monster Kills') : (data?.category.name ?? 'Overall');
  const sortedMainRows = useMemo(() => sortRows(data?.rows ?? [], (a, b) => {
    if (mainSort.key === 'username') return compareText(a.username, b.username);
    return a[mainSort.key] - b[mainSort.key];
  }, mainSort.direction), [data?.rows, mainSort]);
  const sortedKillRows = useMemo(() => sortRows(killData?.rows ?? [], (a, b) => {
    if (killSort.key === 'username') return compareText(a.username, b.username);
    return a[killSort.key] - b[killSort.key];
  }, killSort.direction), [killData?.rows, killSort]);
  const profileCombatLevel = profile?.rows.find((row) => row.category.id === 'combat')?.level ?? null;
  const profileSkillRows = useMemo(() => (profile?.rows ?? []).filter((row) => row.category.id !== 'combat'), [profile?.rows]);
  const sortedProfileRows = useMemo(() => sortRows(profileSkillRows, (a, b) => {
    if (profileSort.key === 'category') return compareText(a.category.name, b.category.name);
    return a[profileSort.key] - b[profileSort.key];
  }, profileSort.direction), [profileSkillRows, profileSort]);
  const sortedProfileMonsterRows = useMemo(() => sortRows(profile?.monsterKills ?? [], (a, b) => {
    if (profileMonsterSort.key === 'name') return compareText(a.name, b.name);
    return a[profileMonsterSort.key] - b[profileMonsterSort.key];
  }, profileMonsterSort.direction), [profile?.monsterKills, profileMonsterSort]);

  const selectCategory = (categoryId: string) => {
    setSelected(categoryId);
    setPage(1);
    setSelectedPlayer('');
    setProfile(null);
    setProfileError('');
  };

  const selectProfileCategory = (categoryId: string) => {
    selectCategory(categoryId);
  };

  const selectProfileMonster = (npcDefId: number) => {
    setSelected('mobkills');
    setSelectedMob(String(npcDefId));
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
                category.id === 'overall' ? 'overall-tab' : '',
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
                <div className="player-profile-title-row">
                  {profile?.avatarUrl ? (
                    <img className="hiscores-profile-avatar" src={profile.avatarUrl} alt={`${profile.username} avatar`} />
                  ) : (
                    <div className="hiscores-profile-avatar empty" aria-hidden="true">?</div>
                  )}
                  <div>
                    <span>Player Profile</span>
                    <h2>
                      {profile?.username ?? selectedPlayer}
                      {profileCombatLevel != null ? (
                        <span className="combat-level-badge">Combat Lv. {formatNumber.format(profileCombatLevel)}</span>
                      ) : null}
                    </h2>
                  </div>
                </div>
                <button type="button" onClick={closeProfile}>Close</button>
              </div>

              {isProfileLoading ? <p className="table-state compact-state">Loading profile...</p> : null}
              {profileError ? <p className="table-state compact-state">{profileError}</p> : null}

              {!isProfileLoading && !profileError && profile ? (
                <>
                  <div className="hiscores-table-wrap">
                    <table className="hiscores-table profile-table">
                      <thead>
                        <tr>
                          <SortHeader label="Rank" sortKey="rank" sort={profileSort} onSort={(key) => setProfileSort((current) => nextSort(current, key))} className="rank-column" />
                          <SortHeader label="Skill" sortKey="category" sort={profileSort} onSort={(key) => setProfileSort((current) => nextSort(current, key))} />
                          <SortHeader label="Level" sortKey="level" sort={profileSort} onSort={(key) => setProfileSort((current) => nextSort(current, key))} />
                          <SortHeader label="XP" sortKey="xp" sort={profileSort} onSort={(key) => setProfileSort((current) => nextSort(current, key))} />
                          <SortHeader label="Daily XP" sortKey="dailyXp" sort={profileSort} onSort={(key) => setProfileSort((current) => nextSort(current, key))} />
                        </tr>
                      </thead>
                      <tbody>
                        {sortedProfileRows.map((row) => (
                          <tr key={row.category.id}>
                            <td className="rank-column"><RankCell rank={row.rank} rankChange={row.rankChange} /></td>
                            <td>
                              <button
                                type="button"
                                className="player-link"
                                onClick={() => selectProfileCategory(row.category.id)}
                              >
                                {row.category.name}
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

                  <section className="profile-monster-kills" aria-label={`${profile.username} monster kills`}>
                    <h3>Monster Kills</h3>
                    {profile.monsterKills.length > 0 ? (
                      <div className="hiscores-table-wrap">
                        <table className="hiscores-table profile-monster-table">
                          <thead>
                            <tr>
                              <SortHeader label="Rank" sortKey="rank" sort={profileMonsterSort} onSort={(key) => setProfileMonsterSort((current) => nextSort(current, key))} className="rank-column" />
                              <SortHeader label="Monster" sortKey="name" sort={profileMonsterSort} onSort={(key) => setProfileMonsterSort((current) => nextSort(current, key))} />
                              <SortHeader label="Kills" sortKey="kills" sort={profileMonsterSort} onSort={(key) => setProfileMonsterSort((current) => nextSort(current, key))} />
                              <SortHeader label="Daily Change" sortKey="dailyKills" sort={profileMonsterSort} onSort={(key) => setProfileMonsterSort((current) => nextSort(current, key))} />
                            </tr>
                          </thead>
                          <tbody>
                            {sortedProfileMonsterRows.map((row) => (
                              <tr key={row.npcDefId}>
                                <td className="rank-column">{row.rank > 0 ? formatNumber.format(row.rank) : '-'}</td>
                                <td>
                                  <button
                                    type="button"
                                    className="player-link"
                                    onClick={() => selectProfileMonster(row.npcDefId)}
                                  >
                                    {row.name}
                                  </button>
                                </td>
                                <td>{formatNumber.format(row.kills)}</td>
                                <td className="daily-xp">{row.dailyKills > 0 ? `+${formatNumber.format(row.dailyKills)}` : '-'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="table-state compact-state">No monster kills yet.</p>
                    )}
                  </section>
                </>
              ) : null}
            </section>
          ) : (
            <>
              <div className="ranking-title">
                <h2>{rankingTitle}</h2>
                <span>
                  {isLoading
                    ? 'Loading ranks...'
                    : totalRows > 0
                      ? `${formatNumber.format(firstRow)}-${formatNumber.format(lastRow)} of ${formatNumber.format(totalRows)} adventurers`
                      : hasSearch ? 'No matching adventurers' : 'No ranked adventurers'}
                </span>
              </div>

              {isKillsMode ? (
                <div className="monster-kills-controls">
                  <MonsterPreview npcId={killData?.npcDefId ?? null} name={killData?.mobName ?? 'Monster'} visual={killData?.visual ?? null} />
                  <form className="hiscores-mob-picker" onSubmit={(event) => event.preventDefault()}>
                    <label htmlFor="hiscores-mob-select">Monster</label>
                    <select
                      id="hiscores-mob-select"
                      value={String(killData?.npcDefId ?? selectedMob ?? '')}
                      onChange={(event) => { setSelectedMob(event.target.value); setPage(1); }}
                      disabled={!killData || killData.mobs.length === 0}
                    >
                      {(killData?.mobs ?? []).map((mob) => (
                        <option key={mob.id} value={String(mob.id)}>{mob.name}</option>
                      ))}
                    </select>
                  </form>
                </div>
              ) : null}

              {error ? <p className="table-state">{error}</p> : null}
              {!error && !isLoading && rowCount === 0 ? (
                <p className="table-state">
                  {isKillsMode
                    ? (hasSearch
                        ? `No ranked killers match "${search.trim()}".`
                        : `No one has killed ${killData?.mobName ?? 'this mob'} yet.`)
                    : (hasSearch ? `No saved characters match "${search.trim()}".` : 'No saved characters yet.')}
                </p>
              ) : null}

              {!error && rowCount > 0 ? (
                <>
                  <div className="hiscores-table-wrap">
                    {isKillsMode ? (
                      <table className="hiscores-table">
                        <thead>
                          <tr>
                            <SortHeader label="Rank" sortKey="rank" sort={killSort} onSort={(key) => setKillSort((current) => nextSort(current, key))} className="rank-column" />
                            <SortHeader label="Name" sortKey="username" sort={killSort} onSort={(key) => setKillSort((current) => nextSort(current, key))} />
                            <SortHeader label="Kills" sortKey="kills" sort={killSort} onSort={(key) => setKillSort((current) => nextSort(current, key))} />
                          </tr>
                        </thead>
                        <tbody>
                          {sortedKillRows.map((row) => (
                            <tr key={`${row.rank}-${row.username}`}>
                              <td className="rank-column">{row.rank}</td>
                              <td>
                                <button
                                  type="button"
                                  className="player-link"
                                  onClick={() => setSelectedPlayer(row.username)}
                                >
                                  {row.username}
                                </button>
                              </td>
                              <td>{formatNumber.format(row.kills)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    ) : (
                      <table className="hiscores-table">
                        <thead>
                          <tr>
                            <SortHeader label="Rank" sortKey="rank" sort={mainSort} onSort={(key) => setMainSort((current) => nextSort(current, key))} className="rank-column" />
                            <SortHeader label="Name" sortKey="username" sort={mainSort} onSort={(key) => setMainSort((current) => nextSort(current, key))} />
                            <SortHeader label="Level" sortKey="level" sort={mainSort} onSort={(key) => setMainSort((current) => nextSort(current, key))} />
                            <SortHeader label="XP" sortKey="xp" sort={mainSort} onSort={(key) => setMainSort((current) => nextSort(current, key))} />
                            <SortHeader label="Daily XP" sortKey="dailyXp" sort={mainSort} onSort={(key) => setMainSort((current) => nextSort(current, key))} />
                          </tr>
                        </thead>
                        <tbody>
                          {sortedMainRows.map((row) => (
                            <tr key={`${row.rank}-${row.username}`}>
                              <td className="rank-column"><RankCell rank={row.rank} rankChange={row.rankChange} /></td>
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
                    )}
                  </div>

                  <div className="hiscores-pagination" aria-label="Hiscores pagination">
                    <button type="button" onClick={() => setPage(1)} disabled={page <= 1 || isLoading}>First</button>
                    <button type="button" onClick={() => setPage((current) => Math.max(1, current - 1))} disabled={page <= 1 || isLoading}>Previous</button>
                    <span>Page {formatNumber.format(responsePage)} of {formatNumber.format(totalPages)}</span>
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
