import { createHash } from 'node:crypto';
import { BRAND_ROWS } from './brand-names';
import { DIAGNOSIS_SYNONYMS, ICD11_TITLES, UNGROUNDED_ABBREVIATIONS, UNLISTED_DIAGNOSIS_LOOKALIKES } from './diagnosis-list';
import { NEML_GENERICS, SYNONYMS, UNLISTED_LOOKALIKES } from './drug-list';
import { FREQUENCY_WORDS } from './hard-page';
import { LAB_TESTS, UNLISTED_LAB_LOOKALIKES } from './lab-list';
import { ABBREVIATION_TABLE, SIGN_TABLE } from './signs';

/**
 * listVersion: which reference lists and tables the reader used, recorded beside promptVersion in the extraction's
 * provenance (provenance.reading.listVersion) and in the ocr.job.completed log line. A list can change without the
 * prompt text changing (a brand added, a synonym fixed), and a reading made with the older lists should be told
 * apart when the readings are measured.
 *
 * It is the first LIST_VERSION_HEX_LENGTH hex characters of the SHA-256 of a canonical JSON serialisation of
 * READER_LISTS: object keys sorted at every level, arrays kept in their order (an entry's place in a list or a
 * tuple can matter to matching), no whitespace. It depends only on the lists' contents: computed once at module
 * load, the same on every worker built from the same source, and changed by any edit to any list.
 */
export const LIST_VERSION_HEX_LENGTH = 16;
export const LIST_VERSION_PATTERN = /^[0-9a-f]{16}$/;

/**
 * The lists hashed, under stable names (renaming one, or adding a list, changes listVersion once, as it should).
 * Drug/brand list, diagnosis list, lab test names, signs table and the hard-page frequency words.
 */
export const READER_LISTS = {
  brandRows: BRAND_ROWS,
  drugGenerics: NEML_GENERICS,
  drugSynonyms: SYNONYMS,
  drugUnlistedLookalikes: UNLISTED_LOOKALIKES,
  diagnosisTitles: ICD11_TITLES,
  diagnosisSynonyms: DIAGNOSIS_SYNONYMS,
  diagnosisUngroundedAbbreviations: UNGROUNDED_ABBREVIATIONS,
  diagnosisUnlistedLookalikes: UNLISTED_DIAGNOSIS_LOOKALIKES,
  labTests: LAB_TESTS,
  labUnlistedLookalikes: UNLISTED_LAB_LOOKALIKES,
  signTable: SIGN_TABLE,
  abbreviationTable: ABBREVIATION_TABLE,
  frequencyWords: FREQUENCY_WORDS,
} as const;

/** JSON with object keys sorted at every level; arrays in order. Only plain JSON values are accepted. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('LIST_VERSION_NOT_JSON');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new TypeError('LIST_VERSION_NOT_JSON');
}

export function computeListVersion(lists: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(canonicalJson(lists), 'utf8').digest('hex').slice(0, LIST_VERSION_HEX_LENGTH);
}

/** listVersion, or null (with LIST_VERSION_ERROR a code) if it could not be computed: a reading never fails on it. */
export let LIST_VERSION: string | null = null;
export let LIST_VERSION_ERROR: string | null = null;
try {
  LIST_VERSION = computeListVersion(READER_LISTS);
} catch {
  LIST_VERSION_ERROR = 'LIST_VERSION_UNAVAILABLE';
}
