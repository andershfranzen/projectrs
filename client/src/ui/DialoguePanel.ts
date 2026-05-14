import { ClientOpcode, encodePacket } from '@projectrs/shared';
import type { NetworkManager } from '../managers/NetworkManager';

/** Wire-format dialogue node received via DIALOGUE_OPEN. The server strips
 *  layout + action types — the client only sees what it needs to render. */
export interface DialogueNodePayload {
  speaker: string;
  lines: string[];
  /** Just the labels — the server validates the chosen index against its
   *  own copy of the node, so the client doesn't need actions or next ids. */
  options: { label: string }[];
}

/**
 * RPG-style dialogue overlay anchored to the bottom of the viewport.
 *
 * Lines are shown one at a time; clicking the body advances. Once the last
 * line is reached, options appear as buttons. Selecting an option fires a
 * DIALOGUE_CHOOSE — the server then either pushes a new DIALOGUE_OPEN (next
 * node), DIALOGUE_CLOSE (end), or hands off to another panel (e.g. shop).
 */
export class DialoguePanel {
  private container: HTMLDivElement;
  private speakerEl: HTMLDivElement;
  private lineEl: HTMLDivElement;
  private optionsEl: HTMLDivElement;
  private continueHintEl: HTMLDivElement;
  private network: NetworkManager;
  private visible: boolean = false;
  private npcEntityId: number = -1;
  private currentNode: DialogueNodePayload | null = null;
  private lineIndex: number = 0;

  constructor(network: NetworkManager) {
    this.network = network;

    this.container = document.createElement('div');
    this.container.style.cssText = `
      position: fixed;
      left: 50%;
      bottom: 24px;
      transform: translateX(-50%);
      width: min(640px, 80vw);
      background: #1a140e;
      border: 2px solid #aa8844;
      border-radius: 8px;
      padding: 12px 16px 14px 16px;
      font-family: monospace;
      color: #f0e6d2;
      box-shadow: 0 4px 18px rgba(0,0,0,0.6);
      display: none;
      flex-direction: column;
      gap: 8px;
      z-index: 600;
      user-select: none;
      cursor: pointer;
    `;

    this.speakerEl = document.createElement('div');
    this.speakerEl.style.cssText = `
      font-size: 13px; color: #ffcc44; font-weight: bold;
      letter-spacing: 0.5px; text-transform: uppercase;
    `;

    this.lineEl = document.createElement('div');
    this.lineEl.style.cssText = `
      font-size: 15px; color: #f0e6d2; line-height: 1.45;
      min-height: 1.45em;
    `;

    this.optionsEl = document.createElement('div');
    this.optionsEl.style.cssText = `
      display: flex; flex-direction: column; gap: 4px; margin-top: 4px;
    `;

    this.continueHintEl = document.createElement('div');
    this.continueHintEl.style.cssText = `
      font-size: 11px; color: #8a7a5c; text-align: right;
      font-style: italic;
    `;
    this.continueHintEl.textContent = 'click to continue ▸';

    this.container.appendChild(this.speakerEl);
    this.container.appendChild(this.lineEl);
    this.container.appendChild(this.optionsEl);
    this.container.appendChild(this.continueHintEl);

    // Clicking the panel body advances to the next line. Option buttons
    // stop propagation so they don't double-fire as both choice + advance.
    this.container.addEventListener('click', () => this.advance());

    document.body.appendChild(this.container);
  }

  show(npcEntityId: number, node: DialogueNodePayload): void {
    this.npcEntityId = npcEntityId;
    this.currentNode = node;
    this.lineIndex = 0;
    this.visible = true;
    this.container.style.display = 'flex';
    this.render();
  }

  hide(): void {
    this.visible = false;
    this.container.style.display = 'none';
    this.npcEntityId = -1;
    this.currentNode = null;
  }

  isVisible(): boolean {
    return this.visible;
  }

  private advance(): void {
    if (!this.currentNode) return;
    // Only advance lines while there's still text to show. Once the last line
    // is on screen, options are visible — clicking the panel body should
    // do nothing (the user must pick an option or walk away).
    if (this.lineIndex < this.currentNode.lines.length - 1) {
      this.lineIndex++;
      this.render();
    }
  }

  private render(): void {
    if (!this.currentNode) return;
    this.speakerEl.textContent = this.currentNode.speaker;
    const line = this.currentNode.lines[this.lineIndex] ?? '';
    this.lineEl.textContent = line;

    const onLastLine = this.lineIndex >= this.currentNode.lines.length - 1;
    this.optionsEl.innerHTML = '';
    if (onLastLine) {
      // No options at all (e.g. an "end of conversation" node) → show a
      // single "Continue" that closes the panel, otherwise the user has no
      // way to dismiss without walking away.
      const opts = this.currentNode.options.length > 0
        ? this.currentNode.options
        : [{ label: 'Continue' }];
      for (let i = 0; i < opts.length; i++) {
        const optionIndex = i;
        const btn = document.createElement('button');
        btn.textContent = opts[i].label;
        btn.style.cssText = `
          background: #2a1f15; border: 1px solid #5a4a35;
          color: #ffe6a8; padding: 6px 10px; border-radius: 4px;
          font-family: monospace; font-size: 13px; cursor: pointer;
          text-align: left;
        `;
        btn.onmouseenter = () => { btn.style.background = '#3a2f25'; };
        btn.onmouseleave = () => { btn.style.background = '#2a1f15'; };
        btn.onclick = (ev) => {
          ev.stopPropagation();
          // For an empty-options node we synthesized a "Continue" — index 0
          // can't be sent to the server (no real option to choose). Just close.
          if (this.currentNode!.options.length === 0) {
            this.hide();
            return;
          }
          this.network.sendRaw(encodePacket(
            ClientOpcode.DIALOGUE_CHOOSE,
            this.npcEntityId,
            optionIndex,
          ));
        };
        this.optionsEl.appendChild(btn);
      }
      this.continueHintEl.style.display = 'none';
    } else {
      this.continueHintEl.style.display = 'block';
    }
  }

  dispose(): void {
    this.container.remove();
  }
}
