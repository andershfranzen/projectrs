/**
 * Browser-scoped device identifier. Issued by the server and mirrored in
 * localStorage. The server also sets an HttpOnly cookie and requires signup
 * requests to echo the matching ID, so hand-written signup requests cannot
 * omit the device identifier or invent arbitrary values.
 *
 * Threat model: deterrent, not a security boundary.
 * - Clearing localStorage gives a fresh ID → bypass. Same effect as cookies.
 * - Incognito tab starts with empty localStorage → effective new device.
 * - Different browser → different ID.
 * - A malicious same-origin script can still request a fresh server-issued ID,
 *   but arbitrary/missing IDs are rejected server-side.
 *
 * The point is friction for casual rule-breakers and a visible "you can't do
 * that" message that pairs with the ToS — anyone who works around it has
 * actively chosen to break the rule, which makes manual moderation easier.
 *
 * Per-browser, NOT per-IP: housemates / dorm-mates / cafe patrons each have
 * their own browser localStorage and pass freely.
 */

const STORAGE_KEY = 'evilmud_device_id';

function genUuid(): string {
  // crypto.randomUUID is available in all modern browsers (Chrome 92+, Firefox
  // 95+, Safari 15.4+, Edge 92+). Fall back to a v4-shaped Math.random string
  // for ancient browsers that somehow reach the login screen — not crypto-
  // strong, but device IDs aren't secrets, they're collision-avoidance keys.
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.random() * 16 | 0;
    const v = c === 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}

let cached: string | null = null;

/** Get this browser's device ID. Generates + persists one if missing. */
export async function getDeviceId(): Promise<string> {
  if (cached) return cached;
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing && existing.length >= 8 && existing.length <= 64) {
      cached = existing;
      return await ensureServerDevice(existing);
    }
    const fresh = await fetchServerDeviceId() ?? genUuid();
    localStorage.setItem(STORAGE_KEY, fresh);
    cached = fresh;
    return fresh;
  } catch {
    // localStorage disabled (private mode in some browsers, or sandboxed
    // iframe). Fall back to an in-memory ID so the session still works,
    // but every page load looks like a fresh device. Acceptable degraded
    // behavior — the enforcement just doesn't fire for these users.
    if (!cached) cached = genUuid();
    return cached;
  }
}

async function ensureServerDevice(existing: string): Promise<string> {
  const serverDevice = await fetchServerDeviceId();
  if (!serverDevice) return existing;
  if (serverDevice !== existing) {
    localStorage.setItem(STORAGE_KEY, serverDevice);
    cached = serverDevice;
    return serverDevice;
  }
  return existing;
}

async function fetchServerDeviceId(): Promise<string | null> {
  try {
    const res = await fetch('/api/device-id', {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const data = await res.json() as { ok?: boolean; deviceId?: string };
    if (data.ok && typeof data.deviceId === 'string' && data.deviceId.length >= 8 && data.deviceId.length <= 64) {
      return data.deviceId;
    }
  } catch {
    // Fall back below.
  }
  return null;
}
