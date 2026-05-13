/**
 * Browser-scoped device identifier. Generated on first visit, persisted in
 * localStorage. Used by the server's one-account-per-device enforcement to
 * refuse a second account login from the same browser while the first is
 * still active — a deterrent paired with the ToS rule.
 *
 * Threat model: deterrent, not a security boundary.
 * - Clearing localStorage gives a fresh ID → bypass. Same effect as cookies.
 * - Incognito tab starts with empty localStorage → effective new device.
 * - Different browser → different ID.
 * - Malicious client can omit the field entirely; the server treats missing
 *   IDs as "no enforcement" rather than refusing connection.
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
export function getDeviceId(): string {
  if (cached) return cached;
  try {
    const existing = localStorage.getItem(STORAGE_KEY);
    if (existing && existing.length >= 8 && existing.length <= 64) {
      cached = existing;
      return existing;
    }
    const fresh = genUuid();
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
