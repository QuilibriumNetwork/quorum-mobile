// Browser-surface shim. Side-effect only.
//
// MUST evaluate before the SDK bundle. The SDK ships a BROWSER build that does
// `window.Buffer = buffer.Buffer` at module scope, so merely importing it in a
// bare Node environment throws `ReferenceError: window is not defined` before a
// single line of harness code runs.
//
// Wired via jest.harness.config.js `setupFiles`, which jest evaluates before the
// test module and therefore before any import inside it. Doing it with a plain
// `import './shim'` at the top of a scenario also works, but relies on every
// future scenario author remembering — setupFiles makes it structural.
//
// This is NOT jsdom and NOT a mock. It is the few globals a browser bundle
// touches at load, deliberately kept minimal so the harness keeps Node's REAL
// WebSocket and REAL webcrypto — faking either would defeat the point of running
// the client for real.
import { Buffer as NodeBuffer } from 'node:buffer';

const g = globalThis as unknown as {
  window?: unknown;
  Buffer?: unknown;
  crypto?: unknown;
};

if (!g.window) g.window = g;
const w = g.window as { location?: unknown; Buffer?: unknown; crypto?: unknown };

// A concrete origin so any config reader that inspects window.location does not
// throw. The value is never used: the harness passes explicit URLs to the API
// client and the transport.
if (!w.location) w.location = { origin: 'http://localhost' };

if (!g.Buffer) g.Buffer = NodeBuffer;
if (!w.Buffer) w.Buffer = NodeBuffer;

// Node 22 provides globalThis.crypto (webcrypto). Mirror it onto window for the
// SDK's window.crypto.subtle paths.
if (g.crypto && !w.crypto) w.crypto = g.crypto;
