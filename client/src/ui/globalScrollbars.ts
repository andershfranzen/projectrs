const STYLE_ID = 'evilquest-global-scrollbars';

export function installGlobalScrollbars(): void {
  if (document.getElementById(STYLE_ID)) return;

  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = `
    :where(#game-frame, #game-frame *, .eq-context-menu, [role="dialog"]) {
      scrollbar-width: thin;
      scrollbar-color: #71372d #15110d;
    }

    :where(#game-frame, #game-frame *, .eq-context-menu, [role="dialog"])::-webkit-scrollbar {
      width: 12px;
      height: 12px;
    }

    :where(#game-frame, #game-frame *, .eq-context-menu, [role="dialog"])::-webkit-scrollbar-track {
      background:
        repeating-linear-gradient(0deg, rgba(255,255,255,0.025) 0 1px, transparent 1px 4px),
        linear-gradient(90deg, #0f0c09 0%, #18130f 45%, #0b0907 100%);
      border-left: 1px solid #2d241b;
      border-top: 1px solid #2d241b;
      box-shadow: inset 1px 1px 0 rgba(0,0,0,0.65), inset -1px -1px 0 rgba(255,255,255,0.035);
    }

    :where(#game-frame, #game-frame *, .eq-context-menu, [role="dialog"])::-webkit-scrollbar-thumb {
      min-height: 24px;
      background:
        repeating-linear-gradient(0deg, rgba(255,210,150,0.08) 0 1px, transparent 1px 4px),
        linear-gradient(90deg, #52281f 0%, #7a3a2f 45%, #3b1c16 100%);
      border: 1px solid #110b08;
      box-shadow:
        inset 1px 1px 0 rgba(255,200,130,0.14),
        inset -1px -1px 0 rgba(0,0,0,0.55);
    }

    :where(#game-frame, #game-frame *, .eq-context-menu, [role="dialog"])::-webkit-scrollbar-thumb:hover {
      background:
        repeating-linear-gradient(0deg, rgba(255,220,160,0.1) 0 1px, transparent 1px 4px),
        linear-gradient(90deg, #633026 0%, #8a4638 45%, #442018 100%);
    }

    :where(#game-frame, #game-frame *, .eq-context-menu, [role="dialog"])::-webkit-scrollbar-corner {
      background: #0f0c09;
      border: 1px solid #2d241b;
    }
  `;
  document.head.appendChild(style);
}
