import { ensurePreAuthTheme } from './preAuthTheme';
import { PASSWORD_MAX_LENGTH, validatePassword, validateUsername } from '@projectrs/shared';

export type LoginCallback = (token: string, username: string) => void | Promise<void>;

export class LoginScreen {
  private container: HTMLDivElement;
  private onLogin: LoginCallback;
  private activeMode: 'login' | 'signup' = 'login';
  private errorEl: HTMLDivElement | null = null;
  private submitBtn: HTMLButtonElement | null = null;

  constructor(onLogin: LoginCallback) {
    this.onLogin = onLogin;
    this.container = this.buildUI();
    document.body.appendChild(this.container);
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

    const submitBtn = document.createElement('button');
    submitBtn.id = 'login-submit';
    submitBtn.className = 'eq-login-submit';
    submitBtn.textContent = 'Login';
    submitBtn.addEventListener('click', () => this.handleSubmit());
    this.submitBtn = submitBtn;
    form.appendChild(submitBtn);

    card.appendChild(form);
    overlay.appendChild(card);

    // Enter key submits
    overlay.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.handleSubmit();
    });

    // Focus username on show
    setTimeout(() => {
      (document.getElementById('login-username') as HTMLInputElement)?.focus();
    }, 100);

    return overlay;
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

  private switchMode(mode: 'login' | 'signup'): void {
    this.activeMode = mode;
    this.hideError();

    // Update tabs
    const tabs = this.container.querySelectorAll('[data-mode]');
    tabs.forEach((tab) => {
      const el = tab as HTMLDivElement;
      el.classList.toggle('is-active', el.dataset.mode === mode);
    });

    // Show/hide confirm password
    const confirm = this.container.querySelector('[data-signup-only]') as HTMLDivElement;
    if (confirm) {
      confirm.style.display = mode === 'signup' ? 'block' : 'none';
    }

    // Update submit button
    const btn = this.submitBtn;
    if (btn) btn.textContent = mode === 'login' ? 'Login' : 'Sign Up';
  }

  private async handleSubmit(): Promise<void> {
    const username = (document.getElementById('login-username') as HTMLInputElement)?.value.trim();
    const password = (document.getElementById('login-password') as HTMLInputElement)?.value;
    const confirm = (document.getElementById('login-confirm') as HTMLInputElement)?.value;

    if (!username || !password) {
      this.showError('Please fill in all fields');
      return;
    }

    if (this.activeMode === 'signup') {
      const usernameError = validateUsername(username);
      if (usernameError) {
        this.showError(usernameError);
        return;
      }
      if (password !== confirm) {
        this.showError('Passwords do not match');
        return;
      }
      const passwordError = validatePassword(password);
      if (passwordError) {
        this.showError(passwordError);
        return;
      }
    }

    const btn = this.submitBtn;
    if (btn) {
      btn.textContent = 'Please wait...';
      btn.disabled = true;
    }

    try {
      const endpoint = this.activeMode === 'login' ? '/api/login' : '/api/signup';
      // Device ID accompanies every login/signup so the server can enforce
      // the one-account-per-browser rule. Persisted in localStorage —
      // clearing it bypasses the rule but breaks the ToS.
      const deviceId = (await import('../deviceId')).getDeviceId();
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, deviceId }),
      });
      const data = await res.json();

      if (data.ok) {
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
    this.container.remove();
  }
}
