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

export function requiresAuthenticatedGameStaticAsset(pathname: string): boolean {
  const decoded = decodePathname(pathname);
  if (decoded.startsWith('/models/')) return true;
  if (decoded.startsWith('/Character models/')) return true;
  if (decoded.startsWith('/items/3d/')) return true;
  if (decoded.startsWith('/assets/') && !isPublicBundle(decoded)) return true;
  return false;
}

export function hasForbiddenStaticSourceExtension(pathname: string): boolean {
  return /\.(?:blend\d*|fbx|psd|kra|xcf)$/i.test(decodePathname(pathname));
}
