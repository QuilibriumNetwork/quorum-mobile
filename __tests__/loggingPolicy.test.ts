/**
 * The logging policy, pinned at the only two points that matter: does a
 * warning survive a release build, and does logger.debug work in dev.
 *
 * Both were broken, and both were broken *invisibly* — reading the code is
 * what convinced everyone the logs were there. So these tests assert against
 * the real shared logger rather than a mock: they call logger.warn and check
 * console.warn actually received it. A test that mocked the logger would pass
 * against the bug it exists to catch.
 *
 * The shared logger decides `enabled` from __DEV__ at import time, so each
 * case resets the module registry and re-imports with __DEV__ set. That is
 * the only way to exercise the release-build branch from a dev test run.
 */

type SharedLogger = {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
  log: (...args: unknown[]) => void;
};

/**
 * Load the logger and apply the policy as if this were a build with the given
 * __DEV__. Mirrors what index.js does at startup.
 */
function bootWith(dev: boolean): SharedLogger {
  (globalThis as unknown as { __DEV__: boolean }).__DEV__ = dev;
  jest.resetModules();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { logger } = require('@quilibrium/quorum-shared') as { logger: SharedLogger };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../services/observability/loggingPolicy').installLoggingPolicy();
  return logger;
}

const DEV_BEFORE = (globalThis as unknown as { __DEV__?: boolean }).__DEV__;

afterAll(() => {
  (globalThis as unknown as { __DEV__?: boolean }).__DEV__ = DEV_BEFORE;
});

describe('release build', () => {
  it('lets a warning reach the console', () => {
    const logger = bootWith(false);
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logger.warn('[test] a control message was dropped');
      expect(spy).toHaveBeenCalledWith('[test] a control message was dropped');
    } finally {
      spy.mockRestore();
    }
  });

  it('lets an error reach the console', () => {
    const logger = bootWith(false);
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      logger.error('[test] a receive path threw');
      expect(spy).toHaveBeenCalledWith('[test] a receive path threw');
    } finally {
      spy.mockRestore();
    }
  });

  it('still drops debug and log, so routine chatter stays off real devices', () => {
    const logger = bootWith(false);
    const debugSpy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      logger.debug('[test] routine');
      logger.log('[test] routine');
      expect(debugSpy).not.toHaveBeenCalled();
      expect(logSpy).not.toHaveBeenCalled();
    } finally {
      debugSpy.mockRestore();
      logSpy.mockRestore();
    }
  });
});

describe('dev build', () => {
  it('lets debug reach the console', () => {
    const logger = bootWith(true);
    const spy = jest.spyOn(console, 'debug').mockImplementation(() => {});
    try {
      logger.debug('[test] control-auth join accepted');
      expect(spy).toHaveBeenCalledWith('[test] control-auth join accepted');
    } finally {
      spy.mockRestore();
    }
  });

  it('still lets warnings through', () => {
    const logger = bootWith(true);
    const spy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      logger.warn('[test] dropped');
      expect(spy).toHaveBeenCalledWith('[test] dropped');
    } finally {
      spy.mockRestore();
    }
  });
});
