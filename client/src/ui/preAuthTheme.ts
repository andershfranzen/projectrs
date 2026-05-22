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
      left: var(--eq-viewport-left, 0px);
      top: var(--eq-viewport-top, 0px);
      width: var(--eq-viewport-width, 100vw);
      height: var(--eq-viewport-height, 100vh);
      background: #050505;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      font-family: Arial, Helvetica, sans-serif;
    }

    .eq-preauth-overlay::before {
      content: "";
      position: absolute;
      inset: -50vmax;
      z-index: 0;
      background:
        linear-gradient(rgba(0, 0, 0, 0.72), rgba(0, 0, 0, 0.86)),
        url('/ui/stone-bg.png') repeat;
      transform: rotate(90deg);
      transform-origin: center;
      pointer-events: none;
    }

    .eq-preauth-overlay > * {
      position: relative;
      z-index: 1;
    }

    .eq-preauth-brand {
      font-family: 'Cinzel', 'Times New Roman', serif;
      font-size: clamp(34px, 14vw, 68px);
      font-weight: 900;
      letter-spacing: clamp(1px, 1vw, 7px);
      line-height: 1;
      max-width: calc(var(--eq-viewport-width, 100vw) - 24px);
      white-space: nowrap;
      text-align: center;
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
      max-width: min(70vw, calc(var(--eq-viewport-width, 100vw) - 24px));
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
      max-width: min(70vw, calc(var(--eq-viewport-width, 100vw) - 24px));
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

    .eq-login-vignette {
      position: absolute;
      left: calc(50% + 160px);
      top: 226px;
      width: 280px;
      height: 420px;
      z-index: 1;
      opacity: 0.86;
      pointer-events: none;
      filter: saturate(0.86) contrast(1.18) brightness(1.18)
        drop-shadow(0 24px 28px rgba(0, 0, 0, 0.78));
      mask-image: radial-gradient(ellipse at center, #000 42%, rgba(0,0,0,0.84) 62%, rgba(0,0,0,0) 84%);
    }

    .eq-login-vignette::after {
      content: "";
      position: absolute;
      inset: 0;
      background:
        radial-gradient(ellipse at 50% 78%, rgba(144, 38, 28, 0.16), rgba(0,0,0,0) 46%),
        linear-gradient(90deg, rgba(0,0,0,0.88), rgba(0,0,0,0) 36%, rgba(0,0,0,0.42));
      pointer-events: none;
    }

    .eq-login-vignette-image {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: contain;
      image-rendering: auto;
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
      font-size: 16px;
      box-shadow: inset 0 0 0 1px #101010;
    }

    .eq-login-input:focus {
      border-color: #6b2a22;
      box-shadow: inset 0 0 0 1px #1b0c0a;
    }

    .eq-login-remember {
      display: flex;
      align-items: center;
      gap: 7px;
      margin: 2px 0 9px;
      color: #a79f90;
      font-size: 11px;
      font-weight: bold;
      line-height: 1.2;
      cursor: pointer;
      user-select: none;
      text-shadow: 1px 1px 0 #000;
    }

    .eq-login-remember input {
      position: absolute;
      opacity: 0;
      pointer-events: none;
    }

    .eq-login-checkbox-box {
      width: 14px;
      height: 14px;
      flex: 0 0 14px;
      background: #020202;
      border: 2px solid #2a2a2a;
      outline: 1px solid #000;
      box-shadow: inset 0 0 0 1px #101010;
    }

    .eq-login-remember input:checked + .eq-login-checkbox-box {
      background:
        linear-gradient(135deg, transparent 0 36%, #d7c7a8 36% 52%, transparent 52%),
        linear-gradient(45deg, transparent 0 44%, #d7c7a8 44% 60%, transparent 60%),
        #3a100d;
      border-color: #6b2a22;
      box-shadow: inset 0 0 0 1px #1b0c0a;
    }

    .eq-login-remember:hover {
      color: #d7d0c2;
    }

    .eq-login-signup-closed {
      padding: 12px 10px;
      margin-top: 2px;
      background: #080202;
      border: 1px solid #672019;
      box-shadow: inset 0 0 0 1px #1b0806;
      color: #d7d0c2;
      font-size: 12px;
      line-height: 1.45;
      text-align: center;
      text-shadow: 1px 1px 0 #000;
    }

    .eq-login-signup-closed p {
      margin: 0 0 8px;
    }

    .eq-login-signup-closed p:last-child {
      margin-bottom: 0;
    }

    .eq-login-signup-closed a {
      color: #c85a4d;
      font-weight: bold;
      text-decoration: none;
    }

    .eq-login-signup-closed a:hover {
      color: #e07163;
      text-decoration: underline;
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

    @media (max-width: 820px) {
      .eq-login-vignette {
        display: none;
      }
    }

  `;
  document.head.appendChild(style);
}
