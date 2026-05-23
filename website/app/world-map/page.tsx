import { WorldMapViewer } from './WorldMapViewer';

export default function WorldMapPage() {
  return (
    <main className="page world-map-page">
      <header className="news-page-header">
        <div className="logo news-logo">
          EvilQuest
        </div>
        <div className="news-page-actions">
          <a className="button" href="/">
            Home
          </a>
          <a className="button" href="/play">
            Play Now
          </a>
        </div>
      </header>

      <WorldMapViewer />
    </main>
  );
}
