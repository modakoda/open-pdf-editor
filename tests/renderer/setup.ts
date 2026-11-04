import '@testing-library/jest-dom/vitest'

// jsdom has no 2D canvas (it returns null and logs "Not implemented" on every call).
// Return null silently; code under test already handles a missing context.
if (typeof HTMLCanvasElement !== 'undefined') {
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    writable: true,
    value: () => null
  })
}
