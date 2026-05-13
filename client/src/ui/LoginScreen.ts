export type LoginCallback = (token: string, username: string) => void;

export class LoginScreen {
  private container: HTMLDivElement;
  private onLogin: LoginCallback;
  private activeMode: 'login' | 'signup' = 'login';
  private errorEl: HTMLDivElement | null = null;

  constructor(onLogin: LoginCallback) {
    this.onLogin = onLogin;
    this.container = this.buildUI();
    document.body.appendChild(this.container);
  }

  private buildUI(): HTMLDivElement {
    const overlay = document.createElement('div');
    overlay.id = 'login-screen';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: linear-gradient(135deg, #1a1510 0%, #2a2218 50%, #1a1510 100%);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      z-index: 9999; font-family: monospace;
    `;

    // Title
    const title = document.createElement('div');
    title.textContent = 'evilMUD';
    title.style.cssText = `
      font-size: 48px; font-weight: bold; color: #fc0;
      text-shadow: 2px 2px 4px rgba(0,0,0,0.8), 0 0 20px rgba(255,204,0,0.3);
      margin-bottom: 8px; letter-spacing: 2px;
    `;
    overlay.appendChild(title);

    const subtitle = document.createElement('div');
    subtitle.textContent = 'A Browser MMORPG Adventure';
    subtitle.style.cssText = `
      font-size: 14px; color: #8a7a60; margin-bottom: 30px;
    `;
    overlay.appendChild(subtitle);

    // Card
    const card = document.createElement('div');
    card.style.cssText = `
      width: 320px; background: rgba(30, 25, 18, 0.95);
      border: 2px solid #5a4a35; border-radius: 6px;
      padding: 20px; box-shadow: 0 4px 20px rgba(0,0,0,0.6);
    `;

    // Mode tabs
    const tabs = document.createElement('div');
    tabs.style.cssText = `display: flex; margin-bottom: 16px; gap: 4px;`;

    const loginTab = this.createTab('Login', 'login');
    const signupTab = this.createTab('Sign Up', 'signup');
    tabs.appendChild(loginTab);
    tabs.appendChild(signupTab);
    card.appendChild(tabs);

    // Error display
    this.errorEl = document.createElement('div');
    this.errorEl.style.cssText = `
      display: none; padding: 8px; margin-bottom: 12px;
      background: rgba(200, 50, 50, 0.3); border: 1px solid #c44;
      border-radius: 3px; color: #f88; font-size: 12px; text-align: center;
    `;
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
    submitBtn.textContent = 'Login';
    submitBtn.style.cssText = `
      width: 100%; padding: 10px; margin-top: 8px;
      background: linear-gradient(180deg, #5a4a35 0%, #3a3025 100%);
      border: 2px solid #7a6a50; border-radius: 4px;
      color: #fc0; font-family: monospace; font-size: 14px;
      font-weight: bold; cursor: pointer; letter-spacing: 1px;
    `;
    submitBtn.addEventListener('mouseenter', () => {
      submitBtn.style.background = 'linear-gradient(180deg, #7a6a50 0%, #5a4a35 100%)';
    });
    submitBtn.addEventListener('mouseleave', () => {
      submitBtn.style.background = 'linear-gradient(180deg, #5a4a35 0%, #3a3025 100%)';
    });
    submitBtn.addEventListener('click', () => this.handleSubmit());
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
    btn.style.cssText = `
      flex: 1; text-align: center; padding: 8px 0;
      cursor: pointer; font-size: 13px; font-weight: bold;
      border-radius: 3px; transition: background 0.15s;
      color: ${mode === this.activeMode ? '#fc0' : '#888'};
      background: ${mode === this.activeMode ? 'rgba(90,74,53,0.4)' : 'transparent'};
    `;
    btn.addEventListener('click', () => this.switchMode(mode));
    return btn;
  }

  private createInput(label: string, type: string, id: string): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = `margin-bottom: 12px;`;

    const labelEl = document.createElement('div');
    labelEl.textContent = label;
    labelEl.style.cssText = `font-size: 11px; color: #aaa; margin-bottom: 4px;`;
    wrap.appendChild(labelEl);

    const input = document.createElement('input');
    input.id = id;
    input.type = type;
    input.maxLength = type === 'password' ? 64 : 16;
    input.style.cssText = `
      width: 100%; padding: 8px; box-sizing: border-box;
      background: rgba(0, 0, 0, 0.5); border: 1px solid #5a4a35;
      border-radius: 3px; color: #fff; font-family: monospace;
      font-size: 14px; outline: none;
    `;
    input.addEventListener('focus', () => {
      input.style.borderColor = '#7a6a50';
    });
    input.addEventListener('blur', () => {
      input.style.borderColor = '#5a4a35';
    });
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
      if (el.dataset.mode === mode) {
        el.style.color = '#fc0';
        el.style.background = 'rgba(90,74,53,0.4)';
      } else {
        el.style.color = '#888';
        el.style.background = 'transparent';
      }
    });

    // Show/hide confirm password
    const confirm = this.container.querySelector('[data-signup-only]') as HTMLDivElement;
    if (confirm) {
      confirm.style.display = mode === 'signup' ? 'block' : 'none';
    }

    // Update submit button
    const btn = document.getElementById('login-submit');
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
      if (password !== confirm) {
        this.showError('Passwords do not match');
        return;
      }
      if (password.length < 4) {
        this.showError('Password must be at least 4 characters');
        return;
      }
    }

    const btn = document.getElementById('login-submit') as HTMLButtonElement;
    if (btn) {
      btn.textContent = 'Please wait...';
      btn.style.pointerEvents = 'none';
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
        this.onLogin(data.token, data.username || username);
      } else {
        this.showError(data.error || 'Unknown error');
      }
    } catch (err) {
      this.showError('Connection failed — is the server running?');
    } finally {
      if (btn) {
        btn.textContent = this.activeMode === 'login' ? 'Login' : 'Sign Up';
        btn.style.pointerEvents = 'auto';
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
