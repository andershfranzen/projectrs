import { FaDiscord } from 'react-icons/fa';
import { getLatestNewsPosts } from '../lib/news';
import { FooterCredits } from './components/FooterCredits';
import { OnlineCount } from './OnlineCount';

const mainFeatures = [
  {
    image: '/items/Iron_2-handed_Sword_77.png',
    title: 'Play Now',
    subtitle: 'Existing Adventurer',
    body: 'Return to EvilQuest and continue your character.',
    cta: 'Launch Game',
    href: '/play',
  },
  {
    image: '/items/Medium_Bronze_Helmet_104.png',
    title: 'Create Account',
    subtitle: 'New Adventurer',
    body: 'Open the game client and create your account from the login screen.',
    cta: 'Start Here',
    href: '/play',
  },
  {
    image: '/items/Staff_of_fire_197.png',
    title: 'View Hiscores',
    subtitle: 'Rankings',
    body: 'Compare overall progress, skills, and daily gains.',
    cta: 'View Rankings',
    href: '/hiscores',
  },
] as const;

const secureServices = [
  {
    image: '/items/Feather_381.png',
    title: 'Forums',
    body: 'Discuss the game with fellow players!',
    cta: 'Visit',
    href: '#',
  },
  {
    image: '/items/Unicorn_horn_466.png',
    title: 'Discord',
    body: 'Follow our development!',
    cta: 'Join',
    href: 'https://discord.gg/SSXyYY8Vx9',
  },
] as const;

const otherFeatures = [
  {
    image: '/items/Radimus_Scrolls_1163.png',
    title: 'Rules',
    body: 'Inform yourself on how to play safely.',
    cta: 'Click Here',
    href: '#',
  },
  {
    image: '/items/Map_415.png',
    title: 'World Map',
    body: 'Great for finding your way around.',
    cta: 'Open',
    href: '/world-map',
  },
  {
    image: '/ui/Skill tab.png',
    title: 'Roadmap',
    body: 'See what comes next.',
    cta: 'Click Here',
    href: '#',
  },
] as const;

const usefulLinks = [...secureServices, ...otherFeatures] as const;

function FeatureCard({ item }: { item: (typeof mainFeatures)[number] }) {
  return (
    <article className="feature">
      <div>
        <a className="button" href={item.href}>
          {item.title}
          <br />
          <span>{item.subtitle}</span>
        </a>
        <p>
          {item.body}
          <br />
          <a href={item.href}>{item.cta}</a>
        </p>
      </div>
    </article>
  );
}

function DirectoryTile({ item }: { item: (typeof secureServices | typeof otherFeatures)[number] }) {
  const isActive = item.href !== '#';

  return (
    <article className={isActive ? 'tile' : 'tile inactive-tile'}>
      {isActive ? (
        <a className="button" href={item.href}>
          {item.title === 'Discord' ? <FaDiscord className="button-icon" aria-hidden="true" /> : null}
          <span>{item.title}</span>
        </a>
      ) : (
        <span className="button disabled-button" aria-disabled="true">
          {item.title}
        </span>
      )}
      <p>
        {item.body}
        <br />
        {isActive ? <a href={item.href}>{item.cta}</a> : <span className="coming-soon">Coming Soon</span>}
      </p>
    </article>
  );
}

export default function Home() {
  const newsItems = getLatestNewsPosts(5);

  return (
    <main className="page">
      <section className="top" aria-label="EvilQuest overview">
        <div className="brand">
          <div className="logo">EvilQuest</div>
          <OnlineCount />
        </div>

        <section className="panel news" aria-labelledby="news-title">
          <h1 id="news-title" className="panel-title">
            Latest News and Updates
          </h1>
          {newsItems.length > 0 ? (
            <div className="news-grid">
              <ol>
                {newsItems.map(({ slug, title, date, formattedDate }) => (
                  <li key={slug}>
                    <a href={`/news/${slug}`}>{title}</a>
                    <time dateTime={date}>{formattedDate}</time>
                  </li>
                ))}
              </ol>
              <a className="news-index-link" href="/news">
                View All News
              </a>
            </div>
          ) : null}
        </section>
      </section>

      <section className="panel features" aria-labelledby="main-features">
        <h2 id="main-features" className="panel-title">
          Main Features
        </h2>
        <div className="feature-row">
          {mainFeatures.map((item) => (
            <FeatureCard key={item.title} item={item} />
          ))}
        </div>
      </section>

      <section className="panel directory combined-directory" aria-label="Website links">
        <h2 className="panel-title">Useful Links</h2>
        <div className="tile-grid useful-links-grid">
          {usefulLinks.map((item) => (
            <DirectoryTile key={item.title} item={item} />
          ))}
        </div>
      </section>

      <footer className="site-footer">
        <FooterCredits />
        <span>Copyright © {new Date().getFullYear()} EvilQuest. All rights reserved.</span>
      </footer>
    </main>
  );
}
