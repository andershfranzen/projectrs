import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Page Not Found - EvilQuest',
};

export default function NotFound() {
  return (
    <main className="page not-found-page">
      <section className="panel not-found-panel" aria-labelledby="not-found-title">
        <div className="logo not-found-logo">
          EvilQuest
        </div>
        <p className="not-found-code">404</p>
        <h1 id="not-found-title">Page Not Found</h1>
        <p className="not-found-copy">That page does not exist in the EvilQuest archives.</p>
        <div className="not-found-actions">
          <a className="button" href="/">
            Return Home
          </a>
          <a className="button" href="/play">
            Play Now
          </a>
        </div>
      </section>
    </main>
  );
}
