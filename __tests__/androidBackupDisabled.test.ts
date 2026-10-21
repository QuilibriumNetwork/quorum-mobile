/**
 * App data never leaves an Android device through backup or device-to-device transfer.
 *
 * App-private storage is end-to-end-encrypted messenger state (the message database, ratchet
 * state, MMKV stores) bound to this device's keys. SecureStore values are sealed with Android
 * Keystore keys that are never backed up. None of it is useful restored on another device, and
 * none of it should be copied there.
 *
 * ## Why a test, for two lines of XML
 *
 * The setting lives in the committed native project, which `expo prebuild` regenerates. A
 * `prebuild --clean` drops the rules file and the manifest attribute without a sound, and
 * `allowBackup="true"` is Expo's default, so a rebuilt manifest looks perfectly normal. Nothing
 * in the app would behave differently afterwards. The data would just start leaving the device.
 *
 * ## Why both switches
 *
 * `android:allowBackup="false"` is the primary switch. On Android 12+ some manufacturers honour it
 * for cloud backup only and still copy app data during a device-to-device transfer. The
 * data-extraction rules close that gap, and only if BOTH sections exclude everything: a missing
 * `<device-transfer>` section means "transfer everything" for that mode.
 *
 * Every assertion below fails against the pre-fix tree (`allowBackup="true"`, no rules file).
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const ANDROID_SRC = join(ROOT, 'android', 'app', 'src');
const MAIN_MANIFEST = join(ANDROID_SRC, 'main', 'AndroidManifest.xml');
const RULES_REF = '@xml/data_extraction_rules';
const RULES_FILE = join(ANDROID_SRC, 'main', 'res', 'xml', 'data_extraction_rules.xml');

const stripComments = (xml: string) => xml.replace(/<!--[\s\S]*?-->/g, '');

/** The `<application ...>` start tag, comments removed. */
const applicationTag = (manifestXml: string): string | undefined =>
  stripComments(manifestXml).match(/<application\b[^>]*>/)?.[0];

/** An attribute's value on a start tag, or undefined when absent. */
const attr = (tag: string, name: string): string | undefined =>
  tag.match(new RegExp(`\\s${name.replace(':', '\\:')}\\s*=\\s*"([^"]*)"`))?.[1];

/** The body of a top-level rules section, or undefined when the section is missing. */
const section = (rulesXml: string, name: string): string | undefined =>
  stripComments(rulesXml).match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`))?.[1];

const manifestsUnder = (dir: string, out: string[] = []): string[] => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) manifestsUnder(full, out);
    else if (entry === 'AndroidManifest.xml') out.push(full);
  }
  return out;
};

describe('the parsing helpers are not vacuous', () => {
  // A regex that never matches would make every "must not be true" check pass. Prove the
  // helpers read the pre-fix manifest the way the real one would be read.
  it('reads allowBackup="true" off the pre-fix application tag', () => {
    const preFix =
      '<manifest><application android:name=".MainApplication" android:allowBackup="true" ' +
      'android:theme="@style/AppTheme"></application></manifest>';
    const tag = applicationTag(preFix);
    expect(tag).toBeDefined();
    expect(attr(tag!, 'android:allowBackup')).toBe('true');
    expect(attr(tag!, 'android:dataExtractionRules')).toBeUndefined();
  });
});

describe('Android backup and device transfer are off', () => {
  const manifest = readFileSync(MAIN_MANIFEST, 'utf8');
  const tag = applicationTag(manifest);

  it('the main manifest sets android:allowBackup="false"', () => {
    expect(tag).toBeDefined();
    expect(attr(tag!, 'android:allowBackup')).toBe('false');
  });

  it('the main manifest points android:dataExtractionRules at the rules file, which exists', () => {
    expect(attr(tag!, 'android:dataExtractionRules')).toBe(RULES_REF);
    expect(existsSync(RULES_FILE)).toBe(true);
  });

  it('the rules file has no "--" inside a comment, which aapt2 rejects as malformed XML', () => {
    // Not hypothetical: the first version of this file said "prebuild --clean" in its header
    // comment and failed the release build in :app:mergeReleaseResources.
    const rules = existsSync(RULES_FILE) ? readFileSync(RULES_FILE, 'utf8') : '';
    const commentBodies = [...rules.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
    expect(commentBodies.filter((body) => body.includes('--'))).toEqual([]);
  });

  describe.each(['cloud-backup', 'device-transfer'])('the <%s> rules', (name) => {
    const rules = existsSync(RULES_FILE) ? readFileSync(RULES_FILE, 'utf8') : '';
    const body = section(rules, name);

    it('are present (a missing section transfers everything)', () => {
      expect(body).toBeDefined();
    });

    it('include nothing (an <include> switches to "only these files")', () => {
      expect(body ?? '').not.toMatch(/<include\b/);
    });

    it.each(['root', 'device_root', 'external'])('exclude the whole "%s" domain', (domain) => {
      expect(body ?? '').toMatch(
        new RegExp(`<exclude\\s+domain="${domain}"\\s+path="\\.\\/?"\\s*/>`),
      );
    });
  });

  it('no other build variant manifest overrides the backup attributes', () => {
    const BACKUP_ATTRS = ['android:allowBackup', 'android:dataExtractionRules', 'android:fullBackupContent'];
    const offenders: string[] = [];
    for (const path of manifestsUnder(ANDROID_SRC).filter((p) => p !== MAIN_MANIFEST)) {
      const other = applicationTag(readFileSync(path, 'utf8'));
      if (!other) continue;
      for (const name of BACKUP_ATTRS) {
        if (attr(other, name) !== undefined) offenders.push(`${path}: sets ${name}`);
      }
      if (/allowBackup|dataExtractionRules|fullBackupContent/.test(attr(other, 'tools:replace') ?? '')) {
        offenders.push(`${path}: tools:replace overrides a backup attribute`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('app.json agrees, so a prebuild regenerates allowBackup="false" rather than Expo\'s default', () => {
    const appJson = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8'));
    expect(appJson.expo.android.allowBackup).toBe(false);
  });
});
