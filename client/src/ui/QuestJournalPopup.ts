import { QUEST_STAGE_COMPLETED, type QuestDef } from '@projectrs/shared';

export type QuestState = Record<string, { stage: number; triggerProgress: number }>;

/** Overlay panel that mimics the RS2 / 2004scape quest journal: a dark wood
 *  frame around a parchment text area, status-colored quest title, and
 *  cumulative journal entries (each stage that's been reached contributes
 *  a paragraph, matching the way the real RS quest log layered text as the
 *  player progressed).
 *
 *  Opened by clicking a quest in the side panel's Quests tab. Closes on
 *  the X button, click outside the panel, or Escape.
 */
export class QuestJournalPopup {
  private overlay: HTMLDivElement;
  private inner: HTMLDivElement;
  private titleEl: HTMLDivElement;
  private bodyEl: HTMLDivElement;
  private currentQuestId: string | null = null;
  private getDef: (id: string) => QuestDef | undefined;
  private getState: () => QuestState;
  private onClose: () => void;

  constructor(
    getDef: (id: string) => QuestDef | undefined,
    getState: () => QuestState,
    onClose: () => void = () => {},
  ) {
    this.getDef = getDef;
    this.getState = getState;
    this.onClose = onClose;

    this.overlay = document.createElement('div');
    this.overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'background:rgba(0,0,0,0.55)',
      'display:none',
      'align-items:center',
      'justify-content:center',
      'z-index:700',
    ].join(';');
    this.overlay.addEventListener('click', (e) => {
      if (e.target === this.overlay) this.hide();
    });

    this.inner = document.createElement('div');
    this.inner.style.cssText = [
      'width:min(520px, 90vw)',
      'max-height:min(560px, 80vh)',
      'background:#1a140e',
      'border:2px solid #aa8844',
      'border-radius:8px',
      'box-shadow:0 4px 18px rgba(0,0,0,0.7), inset 0 0 0 1px rgba(255,210,120,0.12)',
      'display:flex',
      'flex-direction:column',
      'overflow:hidden',
    ].join(';');

    // Top bar: quest title + close button. Title color carries the status.
    const topBar = document.createElement('div');
    topBar.style.cssText = 'display:flex;align-items:center;gap:8px;padding:10px 14px;background:#0f0a06;border-bottom:1px solid #6a4a22;';

    this.titleEl = document.createElement('div');
    this.titleEl.style.cssText = `
      flex:1;
      font-family: 'Cinzel', 'Times New Roman', serif;
      font-size:18px;
      font-weight:700;
      letter-spacing:1px;
      text-shadow: 2px 2px 0 #000;
      color:#ffcc44;
    `;
    topBar.appendChild(this.titleEl);

    const closeBtn = document.createElement('div');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = 'cursor:pointer;color:#cfc2a1;font-size:14px;padding:2px 8px;user-select:none;';
    closeBtn.addEventListener('click', () => this.hide());
    topBar.appendChild(closeBtn);

    this.inner.appendChild(topBar);

    // Body: parchment-ish background, dark serif text, scrollable.
    this.bodyEl = document.createElement('div');
    this.bodyEl.style.cssText = [
      'flex:1',
      'overflow-y:auto',
      'padding:14px 18px 18px 18px',
      'background:#2a1f15',
      'font-family: "Times New Roman", Georgia, serif',
      'color:#e8d8a8',
      'font-size:14px',
      'line-height:1.55',
      'white-space:pre-wrap',
    ].join(';');
    this.inner.appendChild(this.bodyEl);

    this.overlay.appendChild(this.inner);
    document.body.appendChild(this.overlay);

    // Escape closes the popup. Captured at document level so the listener
    // fires regardless of focus.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.overlay.style.display !== 'none') {
        this.hide();
      }
    });
  }

  /** Show the journal for one quest. Pass the questId; the popup pulls the
   *  current def + state via the callbacks supplied at construction so the
   *  rendered text stays in sync with mid-conversation deltas. */
  show(questId: string): void {
    this.currentQuestId = questId;
    this.render();
    this.overlay.style.display = 'flex';
  }

  hide(): void {
    this.overlay.style.display = 'none';
    this.currentQuestId = null;
    this.onClose();
  }

  /** Re-render the open popup (no-op if closed). Called by SidePanel when
   *  a quest delta arrives so a journal you've left open updates in place. */
  refresh(): void {
    if (this.overlay.style.display === 'none' || !this.currentQuestId) return;
    this.render();
  }

  private render(): void {
    if (!this.currentQuestId) return;
    const def = this.getDef(this.currentQuestId);
    if (!def) {
      this.titleEl.textContent = 'Unknown quest';
      this.bodyEl.textContent = 'This quest is no longer in your journal.';
      return;
    }
    const state = this.getState()[def.id];
    const currentStage = state ? state.stage : -2; // -2 = not started (distinct from QUEST_STAGE_COMPLETED)
    const completed = currentStage === QUEST_STAGE_COMPLETED;
    const notStarted = !state;

    // Status color on the title matches the side-panel red/yellow/green so
    // the player's eye carries from "I clicked the red one" to "the title
    // is still red here." Keeps the status legible inside the popup.
    this.titleEl.style.color = notStarted ? '#c44' : completed ? '#6c6' : '#ffcc44';
    this.titleEl.textContent = def.name;

    this.bodyEl.innerHTML = '';

    if (notStarted) {
      const para = document.createElement('div');
      para.textContent = def.blurb ?? 'You have not yet begun this quest.';
      para.style.fontStyle = 'italic';
      this.bodyEl.appendChild(para);
      return;
    }

    // Cumulative journal: every stage from 0 up through the player's current
    // stage contributes a paragraph (matches the RS2 behaviour where each
    // breakthrough adds a new entry to your journal). On completion, every
    // stage is shown plus a completion line.
    const lastShown = completed ? def.stages.length - 1 : currentStage;
    for (let i = 0; i <= lastShown && i < def.stages.length; i++) {
      const stage = def.stages[i];
      const para = document.createElement('div');
      para.style.marginBottom = '12px';
      para.textContent = stage.description ?? `(stage ${i})`;
      this.bodyEl.appendChild(para);
    }

    if (completed) {
      const finale = document.createElement('div');
      finale.textContent = 'Quest complete.';
      finale.style.cssText = 'margin-top:8px;color:#9ec99e;font-style:italic;';
      this.bodyEl.appendChild(finale);
    } else {
      // Surface trigger progress at the bottom for stages that count up
      // (e.g. "Kill 5 cows: 3/5"). Cosmetic — matches the RS2 hint of "you
      // still need to..." underneath the journal text.
      const stage = def.stages[currentStage];
      const trig = stage?.trigger;
      const threshold = trig && trig.type === 'itemPickup' ? (trig.quantity ?? 1)
        : trig && (trig.type === 'npcKill' || trig.type === 'chestOpen') ? (trig.count ?? 1)
        : 1;
      if (threshold > 1 && state.triggerProgress > 0) {
        const prog = document.createElement('div');
        prog.style.cssText = 'margin-top:8px;color:#cfa86a;font-style:italic;font-size:12px;';
        prog.textContent = `Progress: ${state.triggerProgress} / ${threshold}`;
        this.bodyEl.appendChild(prog);
      }
    }
  }
}
