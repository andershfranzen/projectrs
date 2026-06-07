import {
  DIALOGUE_ACCENT,
  DIALOGUE_ACCENT_BRIGHT,
  DIALOGUE_PARCHMENT_BG,
  DIALOGUE_TEXT_SHADOW,
  createGameDialogModal,
  mountModalInGameFrame,
} from './ModalPanel';

const LOGIN_MESSAGE_MODAL_ID = 'login-message-modal';
let activeClose: (() => void) | null = null;

interface LoginMessageOptions {
  username: string;
  lastLoginTs: number | null;
}

export function dismissLoginMessage(): void {
  if (activeClose) {
    activeClose();
    return;
  }
  document.getElementById(LOGIN_MESSAGE_MODAL_ID)?.remove();
}

function daysSinceLastLogin(lastLoginTs: number | null): string {
  if (lastLoginTs === null) return 'First login on this account.';

  const elapsedMs = Date.now() - lastLoginTs * 1000;
  const days = Math.max(0, Math.floor(elapsedMs / 86_400_000));
  return `${days} ${days === 1 ? 'day' : 'days'} since your last login.`;
}

export function showLoginMessage({ lastLoginTs }: LoginMessageOptions): void {
  dismissLoginMessage();

  let panel!: HTMLDivElement;
  let enterButton!: HTMLButtonElement;
  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' && event.key !== 'Enter') return;
    event.preventDefault();
    close();
  };
  const close = () => {
    document.removeEventListener('keydown', handleKeyDown, true);
    panel.remove();
    activeClose = null;
  };

  const modal = createGameDialogModal({
    id: LOGIN_MESSAGE_MODAL_ID,
    title: 'Welcome to EvilQuest',
    closeLabel: 'X',
    width: 'min(400px, calc(100% - var(--right-rail-width, 300px) - 24px))',
    height: 'auto',
    maxHeight: 'calc(100% - var(--chat-height, 220px) - 18px)',
    zIndex: 1004,
    onClose: close,
  });

  panel = modal.root;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  modal.title.id = 'login-message-title';
  panel.setAttribute('aria-labelledby', modal.title.id);

  const body = document.createElement('div');
  body.id = 'login-message-body';
  body.style.cssText = `
    margin-top: 4px;
    padding: 14px 16px 12px;
    background: ${DIALOGUE_PARCHMENT_BG};
    border: 1px solid ${DIALOGUE_ACCENT};
    box-shadow: inset 0 1px 0 rgba(255,220,170,0.08), inset 0 0 18px rgba(0,0,0,0.32);
    color: #f0d2bd;
    font-size: 13px;
    line-height: 1.45;
    text-shadow: ${DIALOGUE_TEXT_SHADOW};
  `;
  panel.setAttribute('aria-describedby', body.id);

  const loginAge = document.createElement('p');
  loginAge.style.cssText = 'margin:0;color:#f4ded5;font-weight:bold;';
  loginAge.textContent = daysSinceLastLogin(lastLoginTs);
  body.appendChild(loginAge);

  const playtest = document.createElement('p');
  playtest.style.cssText = 'margin:8px 0 0;';
  playtest.append(
    'This is a playtest. The game will be reset once, and you can expect ',
    boldText('fairly frequent disconnects'),
    ' as we push code to main.',
  );
  body.appendChild(playtest);

  const browserNote = document.createElement('p');
  browserNote.style.cssText = 'margin:10px 0 0;';
  browserNote.append(
    'For the best experience, we suggest playing in a ',
    boldText('Chromium-based browser'),
    '.',
  );
  body.appendChild(browserNote);

  const actions = document.createElement('div');
  actions.style.cssText = `
    display: flex;
    justify-content: flex-end;
    margin-top: 12px;
  `;

  enterButton = document.createElement('button');
  enterButton.type = 'button';
  enterButton.textContent = 'Enter world';
  enterButton.style.cssText = `
    min-width: 104px;
    min-height: 28px;
    padding: 4px 12px;
    background: linear-gradient(180deg, rgba(90, 29, 24, 0.96), rgba(42, 12, 10, 0.98));
    border: 1px solid ${DIALOGUE_ACCENT_BRIGHT};
    border-radius: 2px;
    color: #f4ded5;
    cursor: pointer;
    font-family: Arial, Helvetica, sans-serif;
    font-size: 12px;
    font-weight: bold;
    text-shadow: 1px 1px 0 #000;
    box-shadow: inset 0 1px 0 rgba(255, 220, 180, 0.1), 0 1px 0 rgba(0, 0, 0, 0.65);
  `;
  enterButton.addEventListener('click', close);
  actions.appendChild(enterButton);
  body.appendChild(actions);

  panel.appendChild(body);
  mountModalInGameFrame(panel);
  panel.style.display = 'flex';
  activeClose = close;
  document.addEventListener('keydown', handleKeyDown, true);
  setTimeout(() => enterButton.focus(), 0);
}

function boldText(text: string): HTMLElement {
  const strong = document.createElement('strong');
  strong.textContent = text;
  return strong;
}
