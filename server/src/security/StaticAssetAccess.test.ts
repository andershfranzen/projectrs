import { describe, expect, test } from 'bun:test';
import { requiresAuthenticatedGameStaticAsset, staticGameAssetCacheControl } from './StaticAssetAccess';

describe('staticGameAssetCacheControl', () => {
  test('production caches protected game art privately (no per-load re-download)', () => {
    expect(staticGameAssetCacheControl('/assets/models/oaktree.glb', true)).toBe('private, max-age=3600');
    expect(staticGameAssetCacheControl('/models/willow_tree.glb', true)).toBe('private, max-age=3600');
    expect(staticGameAssetCacheControl('/Character models/main character.glb', true)).toBe('private, max-age=3600');
    expect(staticGameAssetCacheControl('/items/3d/42.png', true)).toBe('private, max-age=3600');
  });

  test('production caches non-protected static assets publicly', () => {
    // Not under a protected prefix.
    expect(requiresAuthenticatedGameStaticAsset('/sprites/goblin.png')).toBe(false);
    expect(staticGameAssetCacheControl('/sprites/goblin.png', true)).toBe('public, max-age=3600');
  });

  test('dev keeps no-cache so editor asset swaps appear on reload', () => {
    expect(staticGameAssetCacheControl('/assets/models/oaktree.glb', false)).toBe('private, no-cache, must-revalidate');
    expect(staticGameAssetCacheControl('/sprites/goblin.png', false)).toBe('no-cache, must-revalidate');
  });
});
