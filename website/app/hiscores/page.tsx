import { HiscoresTable } from './HiscoresTable';

export const metadata = {
  title: 'Hiscores - EvilQuest',
  description: 'EvilQuest player rankings by overall progress, combat level, and individual skills.',
};

export default function HiscoresPage() {
  return (
    <main className="page hiscores-page">
      <HiscoresTable />
    </main>
  );
}
