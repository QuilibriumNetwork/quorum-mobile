// `expo-constants` for the harness.
//
// Only one thing in the code under test reads it: `services/api/qnsClient.ts`
// takes `expoConfig.extra.qnsApiUrl` and falls back to the production QNS host
// when it is absent. Returning an empty `extra` therefore selects exactly the
// endpoint the harness is supposed to talk to, and does so through the app's
// own fallback rather than by hardcoding a URL here.
//
// Deliberately minimal. A richer fake would invite code to depend on values the
// harness invented, and a bench that quietly supplies its own configuration is
// no longer running the app's.
export default {
  expoConfig: { extra: {} as Record<string, unknown> },
};
