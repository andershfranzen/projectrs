import { QUEST_STAGE_COMPLETED, type QuestDef, type QuestState as SharedQuestState } from '@projectrs/shared';
import {
  DIALOGUE_ACCENT,
  DIALOGUE_PARCHMENT_BG,
  createGameDialogModal,
  mountModalInGameFrame,
} from './ModalPanel';

export type QuestJournalState = Record<string, SharedQuestState>;

/** Quest journal detail panel: a dialogue-chrome game-frame modal with a
 *  parchment-like text area, status-colored quest title, and
 *  cumulative journal entries (each stage that's been reached contributes
 *  a paragraph, matching the way the real RS quest log layered text as the
 *  player progressed).
 *
 *  Opened by clicking a quest in the side panel's Quests tab. Closes on the
 *  shared modal X button or Escape.
 */
export class QuestJournalPopup {
  private panel: HTMLDivElement;
  private titleEl: HTMLSpanElement;
  private bodyEl: HTMLDivElement;
  private currentQuestId: string | null = null;
  private getDef: (id: string) => QuestDef | undefined;
  private getState: () => QuestJournalState;
  private onClose: () => void;

  constructor(
    getDef: (id: string) => QuestDef | undefined,
    getState: () => QuestJournalState,
    onClose: () => void = () => {},
  ) {
    this.getDef = getDef;
    this.getState = getState;
    this.onClose = onClose;

    const modal = createGameDialogModal({
      id: 'quest-journal-popup',
      title: 'Quest Journal',
      closeLabel: 'X',
      onClose: () => this.hide(),
    });
    this.panel = modal.root;
    this.titleEl = modal.title;

    // Body: parchment-ish background, dark serif text, scrollable.
    this.bodyEl = document.createElement('div');
    this.bodyEl.style.cssText = [
      'flex:1',
      'min-height:0',
      'overflow-y:auto',
      'padding:14px 18px 18px 18px',
      'margin-top:4px',
      `background:${DIALOGUE_PARCHMENT_BG}`,
      `border:1px solid ${DIALOGUE_ACCENT}`,
      'box-shadow:inset 0 1px 0 rgba(255,220,170,0.08), inset 0 0 18px rgba(0,0,0,0.28)',
      'font-family: "Times New Roman", Georgia, serif',
      'color:#f0d2bd',
      'font-size:14px',
      'line-height:1.55',
      'white-space:pre-wrap',
    ].join(';');
    this.panel.appendChild(this.bodyEl);

    mountModalInGameFrame(this.panel);

    // Escape closes the modal. Captured at document level so the listener
    // fires regardless of focus.
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && this.panel.style.display !== 'none') {
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
    this.panel.style.display = 'flex';
  }

  hide(): void {
    this.panel.style.display = 'none';
    this.currentQuestId = null;
    this.onClose();
  }

  /** Re-render the open popup (no-op if closed). Called by SidePanel when
   *  a quest delta arrives so a journal you've left open updates in place. */
  refresh(): void {
    if (this.panel.style.display === 'none' || !this.currentQuestId) return;
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
    this.titleEl.style.color = notStarted ? '#e05a52' : completed ? '#8bd18b' : '#ffcc44';
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
      para.textContent = this.stageDescription(stage, state) ?? `(stage ${i})`;
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

  private stageDescription(
    stage: QuestDef['stages'][number],
    state: SharedQuestState,
  ): string | undefined {
    const branch = stage.descriptionByVar;
    if (branch) {
      const value = state.vars?.[branch.key];
      const override = value !== undefined ? branch.values[String(value)] : undefined;
      if (override) return override;
    }
    return stage.description;
  }
}
