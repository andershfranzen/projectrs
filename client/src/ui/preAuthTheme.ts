const STYLE_ID = 'evilquest-preauth-theme';

/**
 * Shared CSS for the loading and login/signup screens. Keeping this in one
 * stylesheet prevents the pre-auth surfaces from drifting apart as the theme
 * gets tuned.
 */
export function ensurePreAuthTheme(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    @keyframes eq-preauth-fade-in { from { opacity: 0; } to { opacity: 1; } }
    @keyframes eq-preauth-fade-out { from { opacity: 1; } to { opacity: 0; } }

    .eq-preauth-overlay {
      position: fixed;
      inset: 0;
      background: #050505;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: Arial, Helvetica, sans-serif;
    }

    .eq-preauth-brand {
      font-family: 'Cinzel', 'Times New Roman', serif;
      font-size: 68px;
      font-weight: 900;
      letter-spacing: 7px;
      color: #d8372b;
      text-shadow: 2px 2px 0 #160604, 0 0 10px rgba(200, 28, 18, 0.22);
      user-select: none;
    }

    .eq-preauth-subtitle,
    .eq-loading-heading,
    .eq-loading-status,
    .eq-login-label {
      text-shadow: 1px 1px 0 #000;
    }

    .eq-loading-overlay {
      z-index: 99999;
      animation: eq-preauth-fade-in 120ms linear;
    }

    .eq-loading-overlay.fading-out {
      animation: eq-preauth-fade-out 220ms linear forwards;
      pointer-events: none;
    }

    .eq-loading-brand {
      margin-bottom: 26px;
    }

    .eq-loading-heading {
      color: #d7d0c2;
      font-size: 13px;
      font-weight: bold;
      margin-bottom: 8px;
    }

    .eq-loading-progress-wrap {
      width: 304px;
      max-width: 70vw;
      display: flex;
      flex-direction: column;
      align-items: center;
    }

    .eq-loading-progress-track {
      position: relative;
      width: 100%;
      height: 20px;
      background: #090909;
      border: 2px solid #2a2a2a;
      outline: 1px solid #000;
      overflow: hidden;
      box-shadow: inset 0 0 0 1px #151515;
    }

    .eq-loading-progress-fill {
      height: 100%;
      width: 0%;
      background:
        repeating-linear-gradient(90deg, rgba(0,0,0,0.18) 0 2px, transparent 2px 8px),
        linear-gradient(180deg, #be3024 0%, #8c1510 54%, #540b08 100%);
      transition: width 90ms linear;
    }

    .eq-loading-progress-text {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #e8e0cf;
      font-size: 11px;
      line-height: 20px;
      font-weight: bold;
      text-shadow: 1px 1px 0 #000;
      pointer-events: none;
      font-variant-numeric: tabular-nums;
    }

    .eq-loading-status {
      margin-top: 8px;
      font-size: 12px;
      color: #a09a90;
      max-width: 70vw;
      text-align: center;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .eq-login-overlay {
      z-index: 9999;
    }

    .eq-login-brand {
      margin-bottom: 10px;
    }

    .eq-preauth-subtitle {
      font-size: 12px;
      color: #8a857c;
      margin-bottom: 18px;
    }

    .eq-login-card {
      width: 304px;
      background: #090909;
      border: 2px solid #2a2a2a;
      outline: 1px solid #000;
      padding: 12px;
      box-shadow: inset 0 0 0 1px #151515;
    }

    .eq-login-tabs {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 4px;
      margin-bottom: 10px;
    }

    .eq-login-tab,
    .eq-login-submit {
      outline: 1px solid #000;
      text-shadow: 1px 1px 0 #000;
      font-weight: bold;
      cursor: pointer;
    }

    .eq-login-tab {
      text-align: center;
      padding: 7px 0;
      font-size: 12px;
      border: 2px solid #252525;
      color: #81796d;
      background: #080808;
      box-shadow: inset 0 0 0 1px #121212;
    }

    .eq-login-tab.is-active {
      border-color: #6b2a22;
      color: #f0e6d0;
      background: #3a100d;
      box-shadow: inset 0 0 0 1px #1c0907;
    }

    .eq-login-error {
      display: none;
      padding: 7px;
      margin-bottom: 10px;
      background: #160706;
      border: 1px solid #672019;
      color: #e8c2b8;
      font-size: 12px;
      text-align: center;
      text-shadow: 1px 1px 0 #000;
    }

    .eq-login-field {
      margin-bottom: 9px;
    }

    .eq-login-label {
      font-size: 11px;
      color: #b8b0a2;
      margin-bottom: 3px;
      font-weight: bold;
    }

    .eq-login-input {
      width: 100%;
      padding: 7px 8px;
      box-sizing: border-box;
      background: #020202;
      border: 2px solid #2a2a2a;
      outline: 1px solid #000;
      color: #e8e0cf;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 14px;
      box-shadow: inset 0 0 0 1px #101010;
    }

    .eq-login-input:focus {
      border-color: #6b2a22;
      box-shadow: inset 0 0 0 1px #1b0c0a;
    }

    .eq-login-submit {
      width: 100%;
      padding: 8px;
      margin-top: 8px;
      background: #120606;
      border: 2px solid #6b2a22;
      color: #e6d6bd;
      font-family: Arial, Helvetica, sans-serif;
      font-size: 13px;
      box-shadow: inset 0 0 0 1px #1b0806;
    }

    .eq-login-submit:hover {
      background: #3a100d;
      border-color: #8c3026;
      color: #fff0d8;
      box-shadow: inset 0 0 0 1px #280b08;
    }

    .eq-login-submit:disabled {
      cursor: default;
      opacity: 0.72;
    }
  `;
  document.head.appendChild(style);
}
