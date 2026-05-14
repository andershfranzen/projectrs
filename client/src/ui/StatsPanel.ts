export class StatsPanel {
  private container: HTMLDivElement;
  private hpBar: HTMLDivElement;
  private hpText: HTMLSpanElement;

  constructor() {
    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed; top: 10px; left: 10px;
      background: rgba(0, 0, 0, 0.75);
      border: 2px solid #5a4a35; border-radius: 4px;
      padding: 8px 12px; z-index: 100;
      font-family: Arial, Helvetica, sans-serif; font-size: 13px;
      color: #ddd; min-width: 140px;
    `;

    // Title
    const title = document.createElement('div');
    title.textContent = 'Stats';
    title.style.cssText = `color: #d8372b; font-weight: bold; margin-bottom: 6px;`;
    this.container.appendChild(title);

    // HP bar
    const hpRow = document.createElement('div');
    hpRow.style.cssText = `margin-bottom: 4px;`;

    const hpLabel = document.createElement('span');
    hpLabel.textContent = 'HP ';
    hpRow.appendChild(hpLabel);

    const barBg = document.createElement('div');
    barBg.style.cssText = `
      display: inline-block; width: 80px; height: 12px;
      background: #400; border: 1px solid #555;
      vertical-align: middle; position: relative;
    `;

    this.hpBar = document.createElement('div');
    this.hpBar.style.cssText = `
      height: 100%; background: #0a0; transition: width 0.3s;
      width: 100%;
    `;
    barBg.appendChild(this.hpBar);
    hpRow.appendChild(barBg);

    this.hpText = document.createElement('span');
    this.hpText.textContent = ' 20/20';
    this.hpText.style.cssText = `margin-left: 4px;`;
    hpRow.appendChild(this.hpText);

    this.container.appendChild(hpRow);

    // Equipment bonuses display
    const bonusRow = document.createElement('div');
    bonusRow.id = 'stat-bonuses';
    bonusRow.style.cssText = `font-size: 11px; color: #aaa; margin-top: 4px;`;
    bonusRow.textContent = 'ATK: +0 | DEF: +0 | STR: +0';
    this.container.appendChild(bonusRow);

    document.body.appendChild(this.container);
  }

  updateHealth(current: number, max: number): void {
    const ratio = Math.max(0, current / max);
    this.hpBar.style.width = `${ratio * 100}%`;

    if (ratio > 0.5) {
      this.hpBar.style.background = '#0a0';
    } else if (ratio > 0.25) {
      this.hpBar.style.background = '#aa0';
    } else {
      this.hpBar.style.background = '#a00';
    }

    this.hpText.textContent = ` ${current}/${max}`;
  }

  updateBonuses(atk: number, def: number, str: number): void {
    const el = document.getElementById('stat-bonuses');
    if (el) {
      el.textContent = `ATK: +${atk} | DEF: +${def} | STR: +${str}`;
    }
  }
}
