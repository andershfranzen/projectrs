export type ChatBubbleVariant = 'chat' | 'dialogue';

export function createChatBubbleElement(
  message: string,
  variant: ChatBubbleVariant = 'chat',
): HTMLDivElement {
  const el = document.createElement('div');
  el.className = variant === 'dialogue' ? 'chat-bubble-overlay dialogue-bubble-overlay' : 'chat-bubble-overlay';
  el.textContent = message;

  const palette = variant === 'dialogue'
    ? `
      background: rgba(43, 10, 8, 0.92); color: #f4ded5;
      border: 1px solid #9a332b;
      box-shadow: 0 2px 8px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,190,150,0.08);
    `
    : `
      background: rgba(0, 0, 0, 0.8); color: #fff;
      border: 1px solid #5a4a35;
  `;

  el.style.cssText = `
    position: absolute; pointer-events: none; z-index: 200;
    ${palette}
    max-width: min(360px, calc(100% - 24px));
    box-sizing: border-box;
    font-family: Arial, Helvetica, sans-serif; font-size: 13px; line-height: 1.3;
    padding: 4px 10px; border-radius: 6px;
    white-space: normal;
    overflow-wrap: anywhere;
    text-align: center;
    transform: translate(-50%, -100%);
    text-shadow: 1px 1px 1px rgba(0,0,0,0.5);
  `;

  return el;
}

export function chatBubbleDuration(message: string, baseDuration: number): number {
  return Math.max(3000, baseDuration, Math.min(18000, 2500 + message.length * 55));
}
