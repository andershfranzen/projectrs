import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'EvilQuest - Browser MMORPG',
  description: 'A retro browser MMORPG with old-school combat, skilling, quests, and a dark fantasy world.',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
