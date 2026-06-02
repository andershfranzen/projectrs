import type { Metadata } from 'next';
import { ForumsApp } from './ForumsApp';

export const metadata: Metadata = {
  title: 'Forums - EvilQuest',
  description: 'EvilQuest community forums.',
};

export default function ForumsPage() {
  return <ForumsApp />;
}
