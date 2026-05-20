import type { Metadata } from 'next';
import { getAllNewsPosts, getNewsPost } from '../../../lib/news';

type NewsPostPageProps = {
  params: Promise<{ slug: string }>;
};

const EMPTY_NEWS_SLUG = '_empty';

export const dynamicParams = false;

export function generateStaticParams() {
  const posts = getAllNewsPosts();
  return posts.length > 0 ? posts.map((post) => ({ slug: post.slug })) : [{ slug: EMPTY_NEWS_SLUG }];
}

export async function generateMetadata({ params }: NewsPostPageProps): Promise<Metadata> {
  const { slug } = await params;
  const post = getNewsPost(slug);

  if (!post) {
    return {
      title: 'News - EvilQuest',
      robots: {
        index: false,
        follow: false,
      },
    };
  }

  return {
    title: `${post.title} - EvilQuest`,
    description: post.summary || 'EvilQuest news and updates.',
  };
}

export default async function NewsPostPage({ params }: NewsPostPageProps) {
  const { slug } = await params;
  const post = getNewsPost(slug);

  if (!post) {
    return (
      <main className="page news-page">
        <header className="news-page-header">
          <div className="logo news-logo">
            EvilQuest
          </div>
          <a className="back-link" href="/news">
            All News
          </a>
        </header>

        <section className="panel news-post">
          <p className="empty-news">No news has been posted yet.</p>
        </section>
      </main>
    );
  }

  return (
    <main className="page news-page">
      <header className="news-page-header">
        <div className="logo news-logo">
          EvilQuest
        </div>
        <nav className="news-page-actions" aria-label="News navigation">
          <a className="back-link" href="/news">
            All News
          </a>
          <a className="back-link" href="/">
            Back to Home
          </a>
        </nav>
      </header>

      <article className="panel news-post">
        <header className="news-post-header">
          <time dateTime={post.date}>{post.formattedDate}</time>
          <h1>{post.title}</h1>
          {post.summary ? <p>{post.summary}</p> : null}
        </header>
        <div className="news-post-body" dangerouslySetInnerHTML={{ __html: post.html }} />
      </article>
    </main>
  );
}
