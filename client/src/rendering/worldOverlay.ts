const WORLD_OVERLAY_LAYER_ID = 'world-overlay-layer';

export function getWorldOverlayLayer(): HTMLElement {
  return document.getElementById(WORLD_OVERLAY_LAYER_ID) ?? document.body;
}

export function mountWorldOverlayElement(element: HTMLElement): void {
  getWorldOverlayLayer().appendChild(element);
}
