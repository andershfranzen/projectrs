import { HiscoresTable } from './HiscoresTable';

export const metadata = {
  title: 'Hiscores - EvilQuest',
  description: 'EvilQuest player rankings by overall progress, combat level, individual skills, and monster kills.',
};

export default function HiscoresPage() {
  return (
    <main className="page hiscores-page">
      <div className="hiscores-logo logo">EvilQuest</div>
      <section className="panel playtest-disclaimer" aria-label="Public playtest disclaimer">
        <div className="static-asset-frame" aria-hidden="true">
          <img className="playtest-disclaimer-art" src="/ui/hiscores_feature.png" alt="" />
        </div>
        <p>
          EvilQuest is currently in a public playtest. Hiscores, characters, items, and progress will be reset before the full launch.
        </p>
      </section>
      <HiscoresTable />
    </main>
  );
}
