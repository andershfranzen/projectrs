import { describe, expect, test } from 'bun:test';
import { hasForbiddenStaticSourceExtension, requiresAdminStaticAsset, requiresAuthenticatedGameStaticAsset } from '../src/security/StaticAssetAccess';

describe('static game asset access', () => {
  test('protects game model and thumbnail assets but not public bundles', () => {
    expect(requiresAuthenticatedGameStaticAsset('/models/sTree_1.glb')).toBe(true);
    expect(requiresAuthenticatedGameStaticAsset('/models/npcs/wolf.glb')).toBe(true);
    expect(requiresAuthenticatedGameStaticAsset('/Character%20models/main%20character.glb')).toBe(true);
    expect(requiresAuthenticatedGameStaticAsset('/assets/models/Potato.glb')).toBe(true);
    expect(requiresAuthenticatedGameStaticAsset('/assets/modular-assets/foo/mesh.bin')).toBe(true);
    expect(requiresAuthenticatedGameStaticAsset('/assets/textures/1.png')).toBe(true);
    expect(requiresAuthenticatedGameStaticAsset('/assets/assets.json')).toBe(true);
    expect(requiresAuthenticatedGameStaticAsset('/items/3d/manifest.json')).toBe(true);
    expect(requiresAuthenticatedGameStaticAsset('/items/3d/58.png')).toBe(true);

    expect(requiresAuthenticatedGameStaticAsset('/assets/GameManager-Kg0KN_Zj.js')).toBe(false);
    expect(requiresAuthenticatedGameStaticAsset('/assets/index-DACAJEQL.css')).toBe(false);
    expect(requiresAuthenticatedGameStaticAsset('/sprites/items/coins.png')).toBe(false);
    expect(requiresAuthenticatedGameStaticAsset('/favicon.ico')).toBe(false);
  });

  test('protects the admin panel chunk separately from normal game auth', () => {
    expect(requiresAdminStaticAsset('/assets/admin-panel-AbC_123.js')).toBe(true);
    expect(requiresAuthenticatedGameStaticAsset('/assets/admin-panel-AbC_123.js')).toBe(false);
    expect(requiresAdminStaticAsset('/assets/GameManager-Kg0KN_Zj.js')).toBe(false);
  });

  test('blocks source asset formats regardless of URL encoding', () => {
    expect(hasForbiddenStaticSourceExtension('/assets/models/source.blend')).toBe(true);
    expect(hasForbiddenStaticSourceExtension('/assets/models/source.blend1')).toBe(true);
    expect(hasForbiddenStaticSourceExtension('/assets/models/source%20mesh.fbx')).toBe(true);
    expect(hasForbiddenStaticSourceExtension('/assets/models/tree.glb')).toBe(false);
  });
});
