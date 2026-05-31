import type { Metadata, Viewport } from 'next';
import { AuthTopBar } from './AuthTopBar';
import './styles.css';

export const metadata: Metadata = {
  title: 'EvilQuest - Browser MMORPG',
  description: 'A retro browser MMORPG with old-school combat, skilling, quests, and a dark fantasy world.',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <AuthTopBar />
        {children}
      </body>
    </html>
  );
}
