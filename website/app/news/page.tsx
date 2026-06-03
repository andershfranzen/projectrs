import type { Metadata } from 'next';
import { getAllNewsPosts } from '../../lib/news';
import { LocalDate } from '../components/LocalDate';

export const metadata: Metadata = {
  title: 'News - EvilQuest',
  description: 'Latest EvilQuest news and updates.',
};

export default function NewsPage() {
  const posts = getAllNewsPosts();

  return (
    <main className="page news-page">
      <header className="news-page-header">
        <div className="logo news-logo">
          EvilQuest
        </div>
        <a className="back-link" href="/">
          Back to Home
        </a>
      </header>

      <section className="panel news-list-panel" aria-labelledby="news-page-title">
        <h1 id="news-page-title" className="panel-title">
          News and Updates
        </h1>
        {posts.length > 0 ? (
          <ol className="news-list">
            {posts.map((post) => (
              <li key={post.slug}>
                <a href={`/news/${post.slug}`}>{post.title}</a>
                <LocalDate iso={post.date} fallback={post.formattedDate} />
                {post.summary ? <p>{post.summary}</p> : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="empty-news">No news has been posted yet.</p>
        )}
      </section>
    </main>
  );
}
