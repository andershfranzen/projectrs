'use client';

import { useState } from 'react';
import { FaBookOpen, FaCode, FaCubes, FaDiscord, FaShieldAlt, FaUsers, FaVolumeUp } from 'react-icons/fa';
import { Modal } from './Modal';

const DISCORD_URL = 'https://discord.gg/SSXyYY8Vx9';

const creditSections = [
  {
    title: 'Lead Developers',
    names: ['mogn', 'anders'],
    Icon: FaCode,
  },
  {
    title: '3D Asset Developers',
    names: ['dodo', 'Tobi'],
    Icon: FaCubes,
  },
  {
    title: 'Community Manager',
    names: ['Tony'],
    Icon: FaUsers,
  },
  {
    title: 'Audio Engineering',
    names: ['Godric'],
    Icon: FaVolumeUp,
  },
  {
    title: 'Lore and Story',
    names: ['Ez'],
    Icon: FaBookOpen,
  },
  {
    title: 'Anti-botting',
    names: ['Blackberry'],
    Icon: FaShieldAlt,
  },
] as const;

export function FooterCredits() {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <button type="button" className="footer-link" onClick={() => setIsOpen(true)}>
        Credits
      </button>
      <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Credits">
        <div className="credits-list">
          {creditSections.map(({ title, names, Icon }) => (
            <section className="credits-section" key={title}>
              <div className="credits-icon" aria-hidden="true">
                <Icon />
              </div>
              <div>
                <h3>{title}</h3>
                <ul>
                  {names.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            </section>
          ))}
          <section className="credits-community">
            <FaDiscord className="credits-community-icon" aria-hidden="true" />
            <p>Thanks to our amazing community supporting us and the game on Discord.</p>
            <a href={DISCORD_URL}>Join the Discord</a>
          </section>
        </div>
      </Modal>
    </>
  );
}
