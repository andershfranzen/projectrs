/**
 * Item-thumbnail bake launcher.
 *
 * The actual rendering happens in the browser at `?bake=1` so the same
 * Babylon engine that the game uses also produces the PNGs (no headless-gl
 * infra required). This script just prints the workflow and verifies the
 * server is reachable.
 *
 * Usage:
 *   bun tools/generate-item-thumbnails.ts
 *
 * Workflow:
 *   1. Start the server         : `bun run dev:server`
 *   2. Start the client (vite)  : `bun run dev:client`
 *   3. Open                     : http://localhost:5173/?bake=1
 *   4. Wait for "Done"          : PNGs land in client/public/items/3d/
 *   5. Commit                   : client/public/items/3d/*.png + manifest.json
 *
 * After bake, every item with a `model` in items.json gets a baked PNG plus a
 * pose-aware manifest entry. The UI only uses a baked PNG when its manifest
 * poseKey still matches the current editor thumbnail pose; otherwise it falls
 * back to the runtime renderer. Items added later still work via the runtime
 * fallback in ThumbnailRenderer; re-run the bake to upgrade them.
 */

export {};

const SERVER_URL = 'http://localhost:4000';
const CLIENT_URL = 'http://localhost:5173';

async function probe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok || res.status === 404; // any response means it's up
  } catch {
    return false;
  }
}

const [serverUp, clientUp] = await Promise.all([
  probe(SERVER_URL),
  probe(CLIENT_URL),
]);

console.log('Item Thumbnail Bake');
console.log('===================');
console.log(`  Server  (${SERVER_URL}) ........ ${serverUp ? 'up' : 'DOWN — start with `bun run dev:server`'}`);
console.log(`  Client  (${CLIENT_URL}) ........ ${clientUp ? 'up' : 'DOWN — start with `bun run dev:client`'}`);
console.log('');

if (!serverUp || !clientUp) {
  console.log('Bring the missing service up, then re-run this script.');
  process.exit(1);
}

console.log('Both services are up. Open the bake page:');
console.log(`  ${CLIENT_URL}/?bake=1`);
console.log('');
console.log('Output:');
console.log('  client/public/items/3d/{itemId}.png');
console.log('  client/public/items/3d/manifest.json');
