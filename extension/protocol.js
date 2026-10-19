// Shared browser + Node protocol source; imported directly by both consumers.
export const PROTOCOL_VERSION = 1;
export function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(key => value[key] !== undefined).map(key => [key, stable(value[key])]));
  return value;
}
export const canonicalJson = value => JSON.stringify(stable(value));
export async function sha256Hex(value) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  const hash = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}
// null means there is no bound world. Object key order and formatting are not semantic changes.
export const worldDigest = world => world === null ? Promise.resolve(null) : sha256Hex(canonicalJson(world));
