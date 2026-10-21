/**
 * App data never goes into an iOS backup (iCloud, Finder, or a Quick Start transfer).
 *
 * The iOS counterpart of androidBackupDisabled.test.ts. iOS backs up `Documents`
 * and `Library/Application Support` by default, and that is where the MMKV stores,
 * the message database and the App Group mirror live. `AppDelegate.swift` flags those
 * directories excluded from backup on every launch.
 *
 * ## Why a test, for one function call
 *
 * `AppDelegate.swift` is Expo's generated template. A clean prebuild regenerates it
 * without the call, and nothing about the app behaves differently afterwards: the
 * data just starts going into backups again. Native code cannot be unit-tested here,
 * so this pins the source. That is weaker than running it, and it is the only
 * guard that runs on every `yarn test`.
 *
 * Every assertion fails against the stock template (proved by the first block).
 */
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const APP_DELEGATE = join(ROOT, 'ios', 'Quorum', 'AppDelegate.swift');

const stripComments = (swift: string) => swift.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

/** The body of didFinishLaunchingWithOptions, up to the call that starts React Native. */
const launchPrologue = (swift: string): string | undefined =>
  stripComments(swift).match(/didFinishLaunchingWithOptions[\s\S]*?\{([\s\S]*?)ReactNativeDelegate\(\)/)?.[1];

/** The body of the exclusion function, comments removed. */
const exclusionBody = (swift: string): string | undefined =>
  stripComments(swift).match(/func excludeAppDataFromBackup\(\)\s*\{([\s\S]*?)\n  \}/)?.[1];

describe('the source helpers are not vacuous', () => {
  it('find no exclusion in the stock Expo AppDelegate', () => {
    const stock = `
      public override func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
      ) -> Bool {
        let delegate = ReactNativeDelegate()
        return super.application(application, didFinishLaunchingWithOptions: launchOptions)
      }`;
    expect(launchPrologue(stock)).toBeDefined();
    expect(launchPrologue(stock)).not.toContain('excludeAppDataFromBackup()');
    expect(exclusionBody(stock)).toBeUndefined();
  });

  it('ignore a call that is only mentioned in a comment', () => {
    const commented = `
      didFinishLaunchingWithOptions launchOptions: Any) -> Bool {
        // AppDelegate.excludeAppDataFromBackup()
        let delegate = ReactNativeDelegate()
      }`;
    expect(launchPrologue(commented)).not.toContain('excludeAppDataFromBackup()');
  });
});

describe('iOS app data is excluded from backup', () => {
  const swift = readFileSync(APP_DELEGATE, 'utf8');
  const body = exclusionBody(swift) ?? '';

  it('runs at launch, before React Native starts (so before any store is opened)', () => {
    expect(launchPrologue(swift)).toContain('AppDelegate.excludeAppDataFromBackup()');
  });

  it('sets isExcludedFromBackup on each directory', () => {
    expect(body).toMatch(/isExcludedFromBackup\s*=\s*true/);
    expect(body).toMatch(/setResourceValues\(/);
  });

  it.each([
    ['Documents (MMKV, SQLite)', /\.documentDirectory/],
    ['Library/Application Support', /\.applicationSupportDirectory/],
    ['the App Group container (notification-extension mirror)', /containerURL\(forSecurityApplicationGroupIdentifier:\s*appGroupId\)/],
  ])('covers %s', (_name, pattern) => {
    expect(body).toMatch(pattern);
  });

  it('uses the same App Group id as the entitlement and the native module', () => {
    const id = stripComments(swift).match(/appGroupId\s*=\s*"([^"]+)"/)?.[1];
    expect(id).toBeDefined();

    const entitlements = readFileSync(join(ROOT, 'ios', 'Quorum', 'Quorum.entitlements'), 'utf8');
    expect(entitlements).toContain(`<string>${id}</string>`);

    const nativeModule = readFileSync(join(ROOT, 'modules', 'quorum-crypto', 'ios', 'QuorumCryptoModule.swift'), 'utf8');
    expect(nativeModule).toContain(`"${id}"`);
  });
});
