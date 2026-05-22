import { ensurePreAuthTheme } from './preAuthTheme';
import { PASSWORD_MAX_LENGTH } from '@projectrs/shared';
import { getRecaptchaToken, preloadRecaptcha } from '../recaptcha';

export type LoginCallback = (token: string, username: string) => void | Promise<void>;

export class LoginScreen {
  private container: HTMLDivElement;
  private onLogin: LoginCallback;
  private activeMode: 'login' | 'signup' = 'login';
  private errorEl: HTMLDivElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;
  private signupClosedNotice: HTMLDivElement | null = null;
  private rememberUsernameRow: HTMLLabelElement | null = null;
  private rememberUsernameInput: HTMLInputElement | null = null;
  private vignetteIdleCallback: number | null = null;
  private vignetteTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(onLogin: LoginCallback) {
    this.onLogin = onLogin;
    this.container = this.buildUI();
    document.body.appendChild(this.container);
    preloadRecaptcha();
  }

  private buildUI(): HTMLDivElement {
    ensurePreAuthTheme();

    const overlay = document.createElement('div');
    overlay.id = 'login-screen';
    overlay.className = 'eq-preauth-overlay eq-login-overlay';

    const title = document.createElement('div');
    title.textContent = 'EvilQuest';
    title.className = 'eq-preauth-brand eq-login-brand';
    overlay.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.textContent = 'A Browser MMORPG Adventure';
    subtitle.className = 'eq-preauth-subtitle';
    overlay.appendChild(subtitle);

    const vignette = this.createVignette();
    overlay.appendChild(vignette);

    // Old-school login slab: square edges, dark fill, simple grey frame.
    const card = document.createElement('div');
    card.className = 'eq-login-card';

    // Mode tabs
    const tabs = document.createElement('div');
    tabs.className = 'eq-login-tabs';

    const loginTab = this.createTab('Login', 'login');
    const signupTab = this.createTab('Sign Up', 'signup');
    tabs.appendChild(loginTab);
    tabs.appendChild(signupTab);
    card.appendChild(tabs);

    // Error display
    this.errorEl = document.createElement('div');
    this.errorEl.className = 'eq-login-error';
    card.appendChild(this.errorEl);

    // Form
    const form = document.createElement('div');
    form.id = 'login-form';

    const usernameInput = this.createInput('Username', 'text', 'login-username');
    const passwordInput = this.createInput('Password', 'password', 'login-password');
    const confirmInput = this.createInput('Confirm Password', 'password', 'login-confirm');
    confirmInput.style.display = 'none';
    confirmInput.dataset.signupOnly = 'true';

    form.appendChild(usernameInput);
    form.appendChild(passwordInput);
    form.appendChild(confirmInput);
    form.appendChild(this.createRememberUsernameRow());
    form.appendChild(this.createSignupClosedNotice());

    const submitBtn = document.createElement('button');
    submitBtn.id = 'login-submit';
    submitBtn.className = 'eq-login-submit';
    submitBtn.textContent = 'Login';
    submitBtn.addEventListener('click', () => this.handleSubmit());
    this.submitBtn = submitBtn;
    form.appendChild(submitBtn);

    form.appendChild(this.createRecaptchaNotice());

    card.appendChild(form);
    overlay.appendChild(card);

    // Enter key submits
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleSubmit();
    });

    // Focus username on show
    setTimeout(() => {
      const input = this.container.querySelector('#login-username') as HTMLInputElement | null;
      const savedUsername = this.getSavedUsername();
      if (input && savedUsername) {
        input.value = savedUsername;
        (this.container.querySelector('#login-password') as HTMLInputElement | null)?.focus();
        return;
      }
      input?.focus();
    }, 100);

    return overlay;
  }

  private createVignette(): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'eq-login-vignette';
    wrap.setAttribute('aria-hidden', 'true');

    const img = document.createElement('img');
    img.className = 'eq-login-vignette-image';
    img.alt = '';
    img.draggable = false;
    wrap.appendChild(img);

    this.deferVignetteLoad(img);
    return wrap;
  }

  private deferVignetteLoad(img: HTMLImageElement): void {
    const load = () => {
      this.vignetteIdleCallback = null;
      this.vignetteTimeout = null;
      if (!this.container.isConnected) return;
      void this.loadVignetteImage(img);
    };

    if ('requestIdleCallback' in window) {
      this.vignetteIdleCallback = window.requestIdleCallback(load, { timeout: 2500 });
      return;
    }

    this.vignetteTimeout = setTimeout(load, 1500);
  }

  private async loadVignetteImage(img: HTMLImageElement): Promise<void> {
    try {
      const { getThumbnail } = await import('../rendering/ThumbnailRenderer');
      const dataUrl = await getThumbnail('/assets/bought-assets/Medieval_Dracula/Gargoyle_Var_1.gltf', {
        camera: {
          alpha: -Math.PI / 4,
          beta: Math.PI / 2.7,
          distanceMult: 0.7,
        },
        rotationY: Math.PI * 0.12,
      });
      if (dataUrl && this.container.isConnected) img.src = dataUrl;
    } catch (err) {
      console.warn('[LoginScreen] Failed to load login vignette asset:', err);
    }
  }

  private createTab(label: string, mode: 'login' | 'signup'): HTMLDivElement {
    const btn = document.createElement('div');
    btn.textContent = label;
    btn.dataset.mode = mode;
    btn.className = `eq-login-tab${mode === this.activeMode ? ' is-active' : ''}`;
    btn.addEventListener('click', () => this.switchMode(mode));
    return btn;
  }

  private createInput(label: string, type: string, id: string): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.className = 'eq-login-field';

    const labelEl = document.createElement('div');
    labelEl.textContent = label;
    labelEl.className = 'eq-login-label';
    wrap.appendChild(labelEl);

    const input = document.createElement('input');
    input.id = id;
    input.type = type;
    input.maxLength = type === 'password' ? PASSWORD_MAX_LENGTH : 16;
    input.className = 'eq-login-input';
    wrap.appendChild(input);

    return wrap;
  }

  private createRememberUsernameRow(): HTMLLabelElement {
    const label = document.createElement('label');
    label.className = 'eq-login-remember';
    this.rememberUsernameRow = label;

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = Boolean(this.getSavedUsername());
    this.rememberUsernameInput = input;

    const box = document.createElement('span');
    box.className = 'eq-login-checkbox-box';

    const text = document.createElement('span');
    text.textContent = 'Remember username on this device';

    label.appendChild(input);
    label.appendChild(box);
    label.appendChild(text);
    return label;
  }

  // Google permits hiding the v3 badge as long as the branding notice
  // remains visible in the user flow. Anchor it under the login button.
  private createRecaptchaNotice(): HTMLDivElement {
    const notice = document.createElement('div');
    notice.className = 'eq-login-recaptcha-notice';
    notice.style.cssText = 'margin-top:8px;font-size:10px;line-height:1.4;color:#9a8c70;text-align:center;';
    notice.innerHTML = 'This site is protected by reCAPTCHA and the Google '
      + '<a href="https://policies.google.com/privacy" target="_blank" rel="noopener noreferrer" style="color:#c9b78a;">Privacy Policy</a> and '
      + '<a href="https://policies.google.com/terms" target="_blank" rel="noopener noreferrer" style="color:#c9b78a;">Terms of Service</a> apply.';
    return notice;
  }

  private createSignupClosedNotice(): HTMLDivElement {
    const notice = document.createElement('div');
    notice.className = 'eq-login-signup-closed';
    notice.style.display = 'none';

    const text = document.createElement('p');
    text.textContent = 'We have decided to close for new accounts until the Alpha launch.';
    notice.appendChild(text);

    const follow = document.createElement('p');
    follow.appendChild(document.createTextNode('Join our '));
    const link = document.createElement('a');
    link.href = 'https://discord.gg/SSXyYY8Vx9';
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Discord';
    follow.appendChild(link);
    follow.appendChild(document.createTextNode(' for more info.'));
    notice.appendChild(follow);

    this.signupClosedNotice = notice;
    return notice;
  }

  private getSavedUsername(): string {
    return localStorage.getItem('evilquest_saved_username') || '';
  }

  private syncRememberedUsername(username: string): void {
    if (this.rememberUsernameInput?.checked) {
      localStorage.setItem('evilquest_saved_username', username);
      return;
    }
    localStorage.removeItem('evilquest_saved_username');
  }

  private switchMode(mode: 'login' | 'signup'): void {
    this.activeMode = mode;
    this.hideError();

    // Update tabs
    const tabs = this.container.querySelectorAll('[data-mode]');
    tabs.forEach((tab) => {
      const el = tab as HTMLDivElement;
      el.classList.toggle('is-active', el.dataset.mode === mode);
    });

    const signupClosed = mode === 'signup';
    const loginFields = this.container.querySelectorAll('.eq-login-field');
    loginFields.forEach((field) => {
      (field as HTMLElement).style.display = signupClosed ? 'none' : '';
    });

    const confirm = this.container.querySelector('[data-signup-only]') as HTMLDivElement;
    if (confirm) {
      confirm.style.display = 'none';
    }

    const btn = this.submitBtn;
    if (btn) {
      btn.textContent = 'Login';
      btn.style.display = signupClosed ? 'none' : '';
    }
    if (this.rememberUsernameRow) {
      this.rememberUsernameRow.style.display = mode === 'login' ? 'flex' : 'none';
    }
    if (this.signupClosedNotice) {
      this.signupClosedNotice.style.display = signupClosed ? 'block' : 'none';
    }
  }

  private async handleSubmit(): Promise<void> {
    if (this.activeMode === 'signup') return;

    const username = (this.container.querySelector('#login-username') as HTMLInputElement | null)?.value.trim();
    const password = (this.container.querySelector('#login-password') as HTMLInputElement | null)?.value;

    if (!username || !password) {
      this.showError('Please fill in all fields');
      return;
    }

    const btn = this.submitBtn;
    if (btn) {
      btn.textContent = 'Please wait...';
      btn.disabled = true;
    }

    try {
      // Device ID accompanies every login/signup so the server can enforce
      // the one-account-per-browser rule. Persisted in localStorage —
      // clearing it bypasses the rule but breaks the ToS.
      const deviceId = await (await import('../deviceId')).getDeviceId();
      const recaptchaToken = await getRecaptchaToken('login');
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username, password, deviceId, recaptchaToken }),
      });
      const data = await res.json();

      if (data.ok) {
        this.syncRememberedUsername(data.username || username);
        localStorage.setItem('projectrs_token', data.token);
        localStorage.setItem('projectrs_username', data.username || username);
        if (btn) btn.textContent = 'Entering world...';
        await this.onLogin(data.token, data.username || username);
      } else {
        this.showError(data.error || 'Unknown error');
      }
    } catch (err) {
      this.showError('Connection failed — is the server running?');
    } finally {
      if (btn && this.container.isConnected) {
        btn.textContent = this.activeMode === 'login' ? 'Login' : 'Sign Up';
        btn.disabled = false;
      }
    }
  }

  private showError(message: string): void {
    if (this.errorEl) {
      this.errorEl.textContent = message;
      this.errorEl.style.display = 'block';
    }
  }

  private hideError(): void {
    if (this.errorEl) {
      this.errorEl.style.display = 'none';
    }
  }

  destroy(): void {
    if (this.vignetteIdleCallback !== null && 'cancelIdleCallback' in window) {
      window.cancelIdleCallback(this.vignetteIdleCallback);
      this.vignetteIdleCallback = null;
    }
    if (this.vignetteTimeout !== null) {
      clearTimeout(this.vignetteTimeout);
      this.vignetteTimeout = null;
    }
    this.container.remove();
  }
}
