#!/usr/bin/env node
/**
 * verify-settings-mirror.mjs — executes the Parent ⇄ Child settings gate.
 *
 * WHY: `src/store/settingsMirror.ts` is the ONLY thing standing between a
 * peer/cloud payload and the child's store. It is pure by design (no React,
 * no Supabase), so it can be compiled and exercised in plain Node — unlike the
 * rest of the app, which needs Metro/RN to run. This keeps the validation
 * rules honest without adding a test runner dependency.
 *
 * Usage: node scripts/verify-settings-mirror.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src', 'store', 'settingsMirror.ts');

const loaded = (() => {
  const source = readFileSync(SRC, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: SRC,
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  new Function('exports', 'require', 'module', outputText)(module.exports, () => ({}), module);
  return module.exports;
})();

const { sanitizeSettingsPatch, diffSettingsPatch, SYNCED_SETTING_KEYS } = loaded;

let failures = 0;
/** Canonical JSON (sorted keys) — object key ORDER is not part of the contract. */
const canon = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  const entries = Object.keys(value)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canon(value[k])}`);
  return `{${entries.join(',')}}`;
};
const check = (name, actual, expected) => {
  const a = canon(actual);
  const e = canon(expected);
  const ok = a === e;
  if (!ok) failures += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` → got ${a}, want ${e}`}`);
};

// 1 ── unknown / foreign keys never enter the store
check('drops unknown keys', sanitizeSettingsPatch({ cardSize: 'L', evil: 1 }), { cardSize: 'L' });
check('drops language + nickname (not mirrored)', sanitizeSettingsPatch({ language: 'en', nickname: 'A' }), {});

// 2 ── enums
check('keeps valid enum', sanitizeSettingsPatch({ cardSize: 'XL', textSize: 'A+' }), { cardSize: 'XL', textSize: 'A+' });
check('rejects invalid enum', sanitizeSettingsPatch({ cardSize: 'XX', textSize: 'A++' }), {});

// 3 ── numeric ranges
check('keeps in-range numbers', sanitizeSettingsPatch({ speechRate: 1.4, volume: 0.3, cardSpacing: 20, holdDuration: 1.5 }), {
  speechRate: 1.4,
  volume: 0.3,
  cardSpacing: 20,
  holdDuration: 1.5,
});
check('rejects out-of-range numbers', sanitizeSettingsPatch({ speechRate: 50, volume: 12, cardSpacing: -4, holdDuration: 9 }), {});
check('rejects non-finite numbers', sanitizeSettingsPatch({ speechRate: NaN, volume: Infinity }), {});

// 4 ── booleans must be booleans
check('keeps real booleans', sanitizeSettingsPatch({ highContrast: true, visualRepliesEnabled: false, notificationsEnabled: false }), {
  highContrast: true,
  visualRepliesEnabled: false,
  notificationsEnabled: false,
});
check('rejects stringified booleans', sanitizeSettingsPatch({ highContrast: 'true', ignoreRepeat: 0 }), {});

// 5 ── voice id
check('keeps a non-empty voice id', sanitizeSettingsPatch({ selectedVoice: 'id-male-1' }), { selectedVoice: 'id-male-1' });
check('rejects empty / non-string voice', sanitizeSettingsPatch({ selectedVoice: '', volume: 1, selectedVoice2: 1 }), { volume: 1 });

// 6 ── null / undefined mean "not provided"
check('ignores null values', sanitizeSettingsPatch({ cardSize: null, volume: 0.5 }), { volume: 0.5 });

// 7 ── junk payloads degrade to an empty patch, never throw
check('null payload', sanitizeSettingsPatch(null), {});
check('string payload', sanitizeSettingsPatch('nope'), {});
check('array payload', sanitizeSettingsPatch([1, 2]), {});

// 8 ── diff-only writes (no needless re-renders, no echo loops)
check('diff drops unchanged keys', diffSettingsPatch({ volume: 0.5, highContrast: true }, { volume: 0.5, highContrast: false }), { highContrast: false });
check('diff keeps changed keys', diffSettingsPatch({ volume: 0.5 }, { volume: 0.9 }), { volume: 0.9 });

// 9 ── whitelist integrity: every key is a real mirrored setting, no duplicates
const unique = new Set(SYNCED_SETTING_KEYS);
check('whitelist has no duplicates', unique.size, SYNCED_SETTING_KEYS.length);
check('whitelist is non-empty', SYNCED_SETTING_KEYS.length, 15);

console.log(failures === 0 ? '\nALL SETTINGS MIRROR CHECKS PASS' : `\nFAILURES: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
