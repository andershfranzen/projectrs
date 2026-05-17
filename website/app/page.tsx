import Image from 'next/image';
import { OnlineCount } from './OnlineCount';

const newsItems = [
  ['Castle Doors and Upper Floors', 'Today'],
  ['Good Magic and Evil Magic', 'In Dev'],
  ["The Sultan's Mine", 'Open'],
  ['Smithing Tiers Expanded', 'Recent'],
  ['Character Gear Tests', 'Recent'],
] as const;

const mainFeatures = [
  {
    image: '/items/Iron_2-handed_Sword_77.png',
    title: 'Play Game',
    subtitle: '(Existing User)',
    body: 'Play EvilQuest right now!',
    cta: 'Click Here',
    href: '/play',
  },
  {
    image: '/items/Medium_Bronze_Helmet_104.png',
    title: 'Create Account',
    subtitle: '(New User)',
    body: 'Create an account for both the game and website.',
    cta: 'Click Here',
    href: '/play',
  },
  {
    image: '/items/Staff_of_fire_197.png',
    title: 'Hiscores',
    subtitle: 'Table',
    body: 'Is your character climbing the old lists?',
    cta: 'Click Here',
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
    cta: 'Click Here',
    href: '#',
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
          {item.title}
        </a>
      ) : (
        <span className="button disabled-button" aria-disabled="true">
          {item.title}
        </span>
      )}
      <p>
        {item.body}
        <br />
        {isActive ? <a href={item.href}>{item.cta}</a> : <span className="disabled-link">{item.cta}</span>}
      </p>
    </article>
  );
}

export default function Home() {
  return (
    <main className="page">
      <section className="top top-centered" aria-label="EvilQuest overview">
        <div className="brand">
          <div className="logo">EvilQuest</div>
          <OnlineCount />
        </div>

        <section className="panel news hidden-section" aria-labelledby="news-title">
          <h1 id="news-title" className="panel-title">
            Latest News and Updates
          </h1>
          <div className="news-grid">
            <Image src="/items/Scroll_1173.png" alt="" width={138} height={138} priority />
            <ol>
              {newsItems.map(([title, date]) => (
                <li key={title}>
                  <a href="#">{title}</a>
                  <time>{date}</time>
                </li>
              ))}
            </ol>
          </div>
          <p className="news-footer">
            To view a full list of news and updates, <a href="#">Click Here</a>.
          </p>
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
        Copyright © {new Date().getFullYear()} EvilQuest. All rights reserved.
      </footer>
    </main>
  );
}
