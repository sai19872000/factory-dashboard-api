// @ts-nocheck
// Polyfill Web Crypto API for vitest's Node VM context.
// Cloudflare Workers expose `crypto` as a global; Node 18 does too on
// globalThis, but vitest's isolated VM context may not inherit it.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { webcrypto } = require("crypto");
if (typeof globalThis.crypto === "undefined" || typeof globalThis.crypto.subtle === "undefined") {
  Object.defineProperty(globalThis, "crypto", {
    value: webcrypto,
    writable: true,
    configurable: true,
  });
}
