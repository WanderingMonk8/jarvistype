/**
 * RFC 4122 version 4 UUIDs that work outside secure contexts.
 *
 * `crypto.randomUUID()` is restricted to secure contexts, which leaves remote
 * Lumiverse hosts (plain HTTP) with no usable crypto at all. `crypto.getRandomValues()`
 * has no such restriction, so prefer it and fall back to `Math.random()` when even
 * that is missing. Never use `crypto.randomUUID()` here.
 */
export function createId(): string {
  const bytes = new Uint8Array(16)
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.getRandomValues === 'function') {
    cryptoApi.getRandomValues(bytes)
  } else {
    for (let index = 0; index < bytes.length; index += 1)
      bytes[index] = Math.floor(Math.random() * 256)
  }
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40 // version 4
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80 // variant 10
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
