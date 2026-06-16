function decodePathname(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return pathname;
  }
}

function isPublicBundle(pathname: string): boolean {
  return /\.(?:js|css)$/i.test(pathname);
}

export function requiresAdminStaticAsset(pathname: string): boolean {
  const decoded = decodePathname(pathname);
  return /^\/assets\/admin-panel-[\w.-]+\.(?:js|css)$/i.test(decoded);
}

export function requiresAuthenticatedGameStaticAsset(pathname: string): boolean {
  const decoded = decodePathname(pathname);
  if (requiresAdminStaticAsset(decoded)) return false;
  if (decoded.startsWith('/models/')) return true;
  if (decoded.startsWith('/Character models/')) return true;
  if (decoded.startsWith('/items/3d/')) return true;
  if (decoded.startsWith('/assets/') && !isPublicBundle(decoded)) return true;
  return false;
}

export function hasForbiddenStaticSourceExtension(pathname: string): boolean {
  return /\.(?:blend\d*|fbx|psd|kra|xcf)$/i.test(decodePathname(pathname));
}

/**
 * Cache-Control for non-bundle game static assets (GLBs, textures, item PNGs).
 *
 * Production serves these from the browser's private cache (`private` keeps
 * them out of shared/proxy caches; the auth gate only protects the first
 * download). The old `no-cache, must-revalidate` — with no ETag/Last-Modified
 * validator — forced a full re-download of every model on each load, which the
 * serial object loader turned into multi-minute loads for distant clients.
 *
 * Dev keeps `no-cache` so editor asset swaps appear on a plain reload; the
 * client already appends `?v=<ts>` cache-busts to GLB/JSON fetches in dev, so a
 * long cache window would be bypassed there anyway.
 *
 * Hashed JS/CSS bundles are handled by the caller (content-addressed, immutable).
 */
export function staticGameAssetCacheControl(pathname: string, isProductionLike: boolean): string {
  const isProtected = requiresAuthenticatedGameStaticAsset(pathname);
  if (!isProductionLike) {
    return isProtected ? 'private, no-cache, must-revalidate' : 'no-cache, must-revalidate';
  }
  return isProtected ? 'private, max-age=3600' : 'public, max-age=3600';
}
