let counter = 0

/** Unique id for pages, objects and sources. */
export function createId(prefix = 'id'): string {
  counter = (counter + 1) % 1_000_000
  const rand =
    typeof globalThis.crypto?.randomUUID === 'function'
      ? globalThis.crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10)
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${rand}`
}
