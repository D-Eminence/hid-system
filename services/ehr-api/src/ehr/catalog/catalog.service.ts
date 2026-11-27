import { Injectable, Logger } from '@nestjs/common';
import type { PoolClient, QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import { DatabaseService, type StaffTransactionContext } from '../../database/database.service';
import { CATALOG_SEARCH_MAX_LENGTH, CATALOG_SEARCH_MAX_LIMIT } from './catalog.dto';
import type { CATALOG_LAB_CATEGORIES, CatalogDoseForm, SearchCatalogLabTestsQueryDto,
  SearchCatalogMedicinesQueryDto } from './catalog.dto';

/**
 * ORD-7, first slice (0149): the national medicine and lab-test lists'
 * status and search; third slice (0155): this facility's own items in both.
 * The lists hold no patient: no X-Purpose-Of-Use, no patient audit row, and
 * q is never written to an audit row or a log. The database functions are
 * SECURITY DEFINER. The status and the medicine and lab-test searches run in
 * a read-only staff transaction that sets the session's facility
 * (app.facility_id), because 0155's status counts, and its search returns,
 * that facility's own items only; with none, the answers are 0149's. The
 * diagnosis search (0152) reads no facility item and stays on the pool.
 */

/** Who asks: the guards' actor at this facility (the session a transaction sets, and whose searches count together). */
export interface CatalogCaller extends StaffTransactionContext {
  accountId?: string;
  organizationId?: string;
}

/** 0155: the code system of a facility's own items; the code is the item's id (Billing's option 2 matches the pair). */
export const FACILITY_CODE_SYSTEM = 'HID-FACILITY';

/** 300 searches per 5 minutes per membership, in each ehr-api instance (planned contract, 429). */
export const CATALOG_SEARCHES_PER_WINDOW = 300;
export const CATALOG_SEARCH_WINDOW_MS = 300_000;
/** Memberships tracked at once; past this, a new one is limited until the oldest windows end. */
export const CATALOG_SEARCH_TRACKED_MEMBERSHIPS = 10_000;

export interface CatalogListStatus {
  available: boolean;
  version: string | null;
  /** The clinical lead's sign-off day (Lagos), YYYY-MM-DD. */
  approvedAt: string | null;
  /** The sha256 of the signed seed file the active version was loaded from, so support can tell which list was searched. */
  fileSha256: string | null;
}

export interface CatalogStatus {
  medicines: CatalogListStatus;
  labTests: CatalogListStatus;
  /** ORD-9 (0152): the ICD-11 release the diagnosis search uses, when one is loaded. */
  diagnoses: { available: boolean; release: string | null; fileSha256: string | null };
  /** The name-only lab request (a later ORD-7 slice). */
  labTestNameOnly: false;
  /** ORD-9. */
  diagnosisNameOnly: false;
  /** ORD-10 phase 2. */
  classDuplicateCheck: false;
  /** The notices the active lists' sources require (LOINC's, the WHO Model List's), for the About page. */
  attribution: string[];
}

/**
 * A medicine of the national list (HID-MED, scope national) or, since 0155,
 * of this facility's own (HID-FACILITY with the item's id as the code, scope
 * and source facility, its own display; doseForm may be null, doseFormText,
 * commonAdultDose and matchedName are).
 */
export interface CatalogMedicine {
  codeSystem: 'HID-MED' | typeof FACILITY_CODE_SYSTEM;
  code: string;
  display: string;
  genericName: string;
  strength: string | null;
  doseForm: CatalogDoseForm | null;
  doseFormText: string | null;
  routes: string[];
  /** Always null until the WHOCC terms for ATC codes are settled (planned contract, open points). */
  atcCode: null;
  commonAdultDose: string | null;
  matchedName: string | null;
  scope: 'national' | 'facility';
  source: string;
}

/** A lab test of the national list, or (0155) of this facility's own: HID-FACILITY, no other names, category may be null. */
export interface CatalogLabTest {
  codeSystem: 'LOINC' | 'HID-LAB' | typeof FACILITY_CODE_SYSTEM;
  code: string;
  display: string;
  otherNames: string[];
  specimen: string | null;
  category: (typeof CATALOG_LAB_CATEGORIES)[number] | null;
  matchedName: string | null;
  scope: 'national' | 'facility';
}

/** ORD-9: one ICD-11 entry, WHO's title verbatim (CC BY-ND 3.0 IGO). */
export interface TerminologyDiagnosis {
  codeSystem: 'ICD-11';
  code: string;
  display: string;
  /** Our own other name that matched, or null. */
  matchedName: string | null;
}

export interface TerminologyDiagnosisAnswer {
  /** "ICD-11 MMS 2026-01"; null when nothing matched. */
  release: string | null;
  more: boolean;
  results: TerminologyDiagnosis[];
  /** q shaped like an ICD-10 code, upper-cased: accepted as typed (Q124 A); no ICD-10 title is shipped or looked up. */
  typedIcd10: { codeSystem: 'ICD-10'; code: string } | null;
}

interface DiagnosisRow extends QueryResultRow {
  code: string;
  title: string;
  matched_name: string | null;
  list_version: string;
  more: boolean;
}

export interface CatalogSearchAnswer<Item> {
  /** The active list's version; null when nothing matched. */
  listVersion: string | null;
  more: boolean;
  items: Item[];
}

interface StatusRow extends QueryResultRow {
  kind: 'medicine' | 'lab_test' | 'diagnosis';
  available: boolean;
  list_version: string | null;
  approved_day: string | null;
  offered: number;
  attribution: string[] | null;
  file_sha256: string | null;
}

interface MedicineRow extends QueryResultRow {
  list_id: string;
  generic_name: string;
  strength: string | null;
  dose_form: CatalogDoseForm;
  dose_form_text: string | null;
  routes: string[] | null;
  common_adult_dose: string | null;
  matched_name: string | null;
  source: string;
  list_version: string;
  more: boolean;
}

interface LabTestRow extends QueryResultRow {
  list_id: string;
  code_system: 'LOINC' | 'HID-LAB';
  code: string;
  display: string;
  other_names: string[] | null;
  specimen: string | null;
  category: (typeof CATALOG_LAB_CATEGORIES)[number];
  matched_name: string | null;
  list_version: string;
  more: boolean;
}

export const STATUS_SQL = `select kind, available, list_version,
  to_char(approved_at at time zone 'Africa/Lagos', 'YYYY-MM-DD') as approved_day, offered, attribution, file_sha256
  from ehr.catalog_status()`;
export const MEDICINES_SQL = `select list_id, generic_name, strength, dose_form, dose_form_text, routes,
  common_adult_dose, matched_name, source, list_version, more
  from ehr.search_catalog_medicines($1, $2, $3, $4)`;
export const DIAGNOSES_SQL = `select code, title, matched_name, list_version, more
  from ehr.search_catalog_diagnoses($1, $2)`;
export const LAB_TESTS_SQL = `select list_id, code_system, code, display, other_names, specimen, category, matched_name,
  list_version, more
  from ehr.search_catalog_lab_tests($1, $2)`;
/** 0155: the session facility's active items of a kind (none without a session facility), in 0149's order. */
export const FACILITY_ITEMS_SEARCH_SQL = `select item_id, display, generic_name, strength, dose_form, routes, specimen,
  category, more
  from ehr.search_catalog_facility_items($1, $2, $3)`;

interface FacilitySearchRow extends QueryResultRow {
  item_id: string;
  display: string;
  generic_name: string | null;
  strength: string | null;
  dose_form: CatalogDoseForm | null;
  routes: string[] | null;
  specimen: string | null;
  category: (typeof CATALOG_LAB_CATEGORIES)[number] | null;
  more: boolean;
}

/** One answer row and where 0149's order puts it: names that start with q first, then the name in the "C" collation. */
interface Ranked<Item> {
  starts: boolean;
  name: string;
  item: Item;
}

const startsWith = (name: string | null | undefined, q: string): boolean =>
  typeof name === 'string' && name.toLowerCase().startsWith(q.toLowerCase());
/** The "C" collation compares UTF-8 bytes. */
const byName = (left: string, right: string): number => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));

/**
 * The national answer and the facility's, each already in its own search's
 * order, merged into one in 0149's order: names that start with q first, then
 * by name ("C" collation; a national item's generic name or display, a
 * facility item's display), a national item before a facility item of the
 * same name, then each list's own order. At most `limit`; `more` when either
 * search had more, or the two together pass the limit.
 */
export function mergeInListOrder<Item>(national: readonly Ranked<Item>[], own: readonly Ranked<Item>[], limit: number):
{ items: Item[]; overLimit: boolean } {
  const merged: Item[] = [];
  let left = 0;
  let right = 0;
  while (left < national.length || right < own.length) {
    const a = national[left];
    const b = own[right];
    const takeNational = b === undefined
      || (a !== undefined && (a.starts !== b.starts ? a.starts : byName(a.name, b.name) <= 0));
    merged.push(takeNational ? a!.item : b!.item);
    if (takeNational) left += 1; else right += 1;
  }
  return { items: merged.slice(0, limit), overLimit: merged.length > limit };
}

/**
 * A Health ID typed into the search: HID- and its characters, or a bare
 * six-character code of the Health ID alphabet mixing letters and digits
 * (identity-api's HidCodeGenerator). The alphabet has no 0, 1, I or O, so
 * strengths such as "500mg" or "B12" never match.
 */
const HEALTH_ID_TEXT = /HID-[A-HJ-NP-Z2-9]{2,}/i;
const HEALTH_ID_ALPHABET_WORD = /^[A-HJ-NP-Z2-9]{6}$/i;
/** An 11-digit NIN (or any longer run of digits, such as a phone number), with spaces and hyphens ignored. */
const LONG_DIGIT_RUN = /\d{11,}/;

/**
 * Whether q looks like a Health ID or a NIN. Such a q is refused before any
 * search, so neither is looked up, kept in a cache or written anywhere.
 */
export function looksLikePersonIdentifier(q: string): boolean {
  if (HEALTH_ID_TEXT.test(q) || LONG_DIGIT_RUN.test(q.replace(/[\s-]+/g, ''))) return true;
  return q.split(/[^A-Za-z0-9]+/).some((word) => HEALTH_ID_ALPHABET_WORD.test(word)
    && /[A-Za-z]/.test(word) && /\d/.test(word));
}

/** The words a medicine is offered as: the generic name with a capital, its strength, its form in the list's words. */
export function medicineDisplay(row: Pick<MedicineRow, 'generic_name' | 'strength' | 'dose_form_text'>): string {
  const name = row.generic_name.charAt(0).toUpperCase() + row.generic_name.slice(1);
  return [name, row.strength, row.dose_form_text?.toLowerCase()].filter((part) => part).join(' ');
}

export function searchTextTooShort(): DomainProblem {
  return new DomainProblem(400, 'CATALOG_SEARCH_TEXT_TOO_SHORT', 'Type at least 2 letters to search.');
}

/**
 * q over 100 characters counted as the database counts them (code points), as
 * the query's VALIDATION_FAILED: a text the validator's own count let through
 * (it leaves out emoji presentation selectors) never reaches the database.
 */
export function searchTextTooLong(): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.', [
    { field: 'q', messages: [`q must be shorter than or equal to ${CATALOG_SEARCH_MAX_LENGTH} characters`] },
  ]);
}

/**
 * A C0 control character other than tab (U+0000 to U+0008, U+000A to U+001F).
 * U+0000 is not a character PostgreSQL's text can hold (22021, answered as
 * 503), and none is a search; refused as VALIDATION_FAILED before the
 * database (Rahman's re-review of #320, nit 9c).
 */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000A-\u001F]/;
export function searchTextHasControlCharacter(): DomainProblem {
  return new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.', [
    { field: 'q', messages: ['q must not contain control characters'] },
  ]);
}

/**
 * The diagnosis search's words say what to do: a code typed without its dot
 * can have a Health ID's shape (582 ICD-11 codes, such as 2B6B2Y for
 * 2B6B.2Y), which the API cannot tell from a Health ID, so it asks for the
 * dot (Rahman's re-review of #320, nit 9b). The medicine and lab-test
 * searches keep their words.
 */
export function searchTextNotAllowed(list: 'catalogue' | 'diagnoses' = 'catalogue'): DomainProblem {
  return new DomainProblem(400, 'CATALOG_SEARCH_TEXT_NOT_ALLOWED', list === 'diagnoses'
    ? 'Search by diagnosis name or code, and type a code with its dot (such as 2B6B.2Y). Do not type a Health ID or NIN here.'
    : 'Search by medicine or test name. Do not type a Health ID or NIN here.');
}

/**
 * An ICD-10 code as typed (planned contract, ORD-9): a letter, two digits or
 * a digit and a letter, then optionally a dot and up to 4 more. No ICD-11
 * code has this shape (an ICD-11 code's second character is a letter). As
 * for an ICD-11 code (0152), any run of characters that are neither letters
 * nor digits is taken off both ends first, so a code copied with punctuation
 * around it is still that code ("B50.9.", "(B50.9)"); its own dot stays
 * (Rahman's re-review of #320, nit 9d).
 */
const ICD10_CODE = /^[A-Za-z](?:[0-9]{2}|[0-9][A-Za-z])(?:\.[0-9A-Za-z]{1,4})?$/;
const AROUND_A_CODE = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
export function typedIcd10(q: string): { codeSystem: 'ICD-10'; code: string } | null {
  const code = q.replace(AROUND_A_CODE, '');
  return ICD10_CODE.test(code) ? { codeSystem: 'ICD-10', code: code.toUpperCase() } : null;
}

export function catalogUnavailable(): DomainProblem {
  return new DomainProblem(503, 'CATALOG_UNAVAILABLE', 'The list cannot be searched right now. You can type the name instead.');
}

/**
 * ORD-9's 503, the catalogue's code with words that are true in every case,
 * a schema without 0152 included, so they give no advice: trying again in a
 * minute does not help while 0152 is not there, and a diagnosis still needs
 * its code (clinical.dto.ts), so typing a name instead is not offered until
 * diagnoses by name only ship. These words stay in the service: on the wire,
 * ProblemDetailsFilter replaces every 5xx detail with "The service could not
 * complete the request.", so a client reads the status and the code
 * (Rahman's re-review of #320, nit 9a).
 */
export function diagnosisSearchUnavailable(): DomainProblem {
  return new DomainProblem(503, 'CATALOG_UNAVAILABLE', 'Diagnosis search is not available right now.');
}

export function catalogNotAvailable(): DomainProblem {
  return new DomainProblem(404, 'CATALOG_NOT_AVAILABLE', 'The medicine and lab-test lists are not available yet.');
}

function databaseCode(error: unknown): unknown {
  return typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
}

@Injectable()
export class CatalogService {
  private readonly logger = new Logger(CatalogService.name);
  private readonly searches = new Map<string, { windowEnds: number; count: number }>();

  constructor(private readonly database: DatabaseService) {}

  /**
   * What the screens may use. A list is available when its active, signed
   * version, or (0155) this facility's own items, offer at least one row;
   * the version, sign-off day, seed file and notices stay the national
   * list's. Read in a read-only staff transaction, so 0155's status counts
   * this facility's items. On a schema without 0149 this answers 404
   * CATALOG_NOT_AVAILABLE, as the contract says it does before ORD-7 ships,
   * so the screens keep their built-in lists; on one without 0155, 0152's
   * status answers without facility items.
   */
  async status(caller: CatalogCaller): Promise<CatalogStatus> {
    let rows: StatusRow[];
    try {
      rows = await this.database.withStaffTransaction(caller,
        async (client) => (await client.query<StatusRow>(STATUS_SQL)).rows, { readOnly: true });
    } catch (error) {
      const code = databaseCode(error);
      if (code === '42883' || code === '42P01') throw catalogNotAvailable();
      this.logger.warn(`Catalogue status failed (${typeof code === 'string' ? code : 'no database code'})`);
      throw catalogUnavailable();
    }
    const list = (kind: StatusRow['kind']): CatalogListStatus => {
      const row = rows.find((candidate) => candidate.kind === kind);
      const available = row?.available === true && Number(row.offered) > 0;
      return { available, version: available ? row.list_version : null, approvedAt: available ? row.approved_day : null,
        fileSha256: available ? row.file_sha256 : null };
    };
    const medicines = list('medicine');
    const labTests = list('lab_test');
    const diagnosisList = list('diagnosis');
    const availableKinds = new Set(([['medicine', medicines], ['lab_test', labTests], ['diagnosis', diagnosisList]] as const)
      .filter(([, listStatus]) => listStatus.available).map(([kind]) => kind));
    const attribution = [...new Set(rows
      .filter((row) => availableKinds.has(row.kind))
      .flatMap((row) => row.attribution ?? []))];
    return {
      medicines,
      labTests,
      diagnoses: { available: diagnosisList.available,
        release: diagnosisList.available ? `ICD-11 MMS ${diagnosisList.version}` : null,
        fileSha256: diagnosisList.fileSha256 },
      labTestNameOnly: false,
      diagnosisNameOnly: false,
      classDuplicateCheck: false,
      attribution,
    };
  }

  /**
   * The national list's medicines and (0155) this facility's own, merged in
   * 0149's order. A facility item is filtered by doseForm and route here (its
   * search takes no filter): with a filter, up to 25 of its matches are read
   * and filtered, and `more` is true when it had more than 25.
   */
  async searchMedicines(caller: CatalogCaller, query: SearchCatalogMedicinesQueryDto):
  Promise<CatalogSearchAnswer<CatalogMedicine>> {
    const q = this.admit(searchKey(caller), query.q);
    const route = query.route === undefined ? null : query.route.toLowerCase();
    const filtered = query.doseForm !== undefined || route !== null;
    const { national, own } = await this.searchWithFacility<MedicineRow>(caller, MEDICINES_SQL,
      [q, query.limit, query.doseForm ?? null, route], 'medicine', q, filtered ? CATALOG_SEARCH_MAX_LIMIT : query.limit);
    const kept = own.filter((row) => (query.doseForm === undefined || row.dose_form === query.doseForm)
      && (route === null || (row.routes ?? []).some((each) => each.toLowerCase() === route)));
    const merged = mergeInListOrder<CatalogMedicine>(
      national.map((row) => ({ starts: startsWith(row.matched_name ?? row.generic_name, q),
        name: row.generic_name.toLowerCase(), item: {
          codeSystem: 'HID-MED',
          code: row.list_id,
          display: medicineDisplay(row),
          genericName: row.generic_name,
          strength: row.strength,
          doseForm: row.dose_form,
          doseFormText: row.dose_form_text,
          routes: row.routes ?? [],
          atcCode: null,
          commonAdultDose: row.common_adult_dose,
          matchedName: row.matched_name,
          scope: 'national',
          source: row.source,
        } })),
      kept.map((row) => ({ starts: startsWith(row.display, q) || startsWith(row.generic_name, q),
        name: row.display.toLowerCase(), item: {
          codeSystem: FACILITY_CODE_SYSTEM,
          code: row.item_id,
          display: row.display,
          genericName: row.generic_name ?? '',
          strength: row.strength,
          doseForm: row.dose_form,
          doseFormText: null,
          routes: row.routes ?? [],
          atcCode: null,
          commonAdultDose: null,
          matchedName: null,
          scope: 'facility',
          source: 'facility',
        } })),
      query.limit);
    return {
      listVersion: national[0]?.list_version ?? null,
      more: national.some((row) => row.more) || own.some((row) => row.more) || merged.overLimit,
      items: merged.items,
    };
  }

  /** The national list's lab tests and (0155) this facility's own, merged in 0149's order. */
  async searchLabTests(caller: CatalogCaller, query: SearchCatalogLabTestsQueryDto):
  Promise<CatalogSearchAnswer<CatalogLabTest>> {
    const q = this.admit(searchKey(caller), query.q);
    const { national, own } = await this.searchWithFacility<LabTestRow>(caller, LAB_TESTS_SQL, [q, query.limit],
      'lab_test', q, query.limit);
    const merged = mergeInListOrder<CatalogLabTest>(
      national.map((row) => ({ starts: startsWith(row.matched_name ?? row.display, q), name: row.display.toLowerCase(),
        item: {
          codeSystem: row.code_system,
          code: row.code,
          display: row.display,
          otherNames: row.other_names ?? [],
          specimen: row.specimen,
          category: row.category,
          matchedName: row.matched_name,
          scope: 'national',
        } })),
      own.map((row) => ({ starts: startsWith(row.display, q), name: row.display.toLowerCase(), item: {
        codeSystem: FACILITY_CODE_SYSTEM,
        code: row.item_id,
        display: row.display,
        otherNames: [],
        specimen: row.specimen,
        category: row.category,
        matchedName: null,
        scope: 'facility',
      } })),
      query.limit);
    return {
      listVersion: national[0]?.list_version ?? null,
      more: national.some((row) => row.more) || own.some((row) => row.more) || merged.overLimit,
      items: merged.items,
    };
  }

  /**
   * ORD-9 (0152): the active ICD-11 release's entries for q, in the
   * contract's shape, and q as an ICD-10 code when it is shaped like one.
   */
  async searchDiagnoses(membershipKey: string, query: SearchCatalogLabTestsQueryDto): Promise<TerminologyDiagnosisAnswer> {
    const q = this.admit(membershipKey, query.q, 'diagnoses');
    const rows = await this.search<DiagnosisRow>(DIAGNOSES_SQL, [q, query.limit], diagnosisSearchUnavailable);
    return {
      release: rows[0] ? `ICD-11 MMS ${rows[0].list_version}` : null,
      more: rows.some((row) => row.more),
      results: rows.map((row) => ({ codeSystem: 'ICD-11', code: row.code, display: row.title, matchedName: row.matched_name })),
      typedIcd10: typedIcd10(q),
    };
  }

  /**
   * The search text's checks, in the contract's order (too short, then a
   * person's identifier), and then this membership's search count. A
   * refused text does not count. Its length is counted in code points, as
   * the database's char_length counts it: an emoji or "𝔸" is one character,
   * not two UTF-16 units, so alone it is too short (400), never a database
   * refusal answered as 503. A control character other than tab (U+0000
   * included) is VALIDATION_FAILED, never sent to the database.
   */
  private admit(membershipKey: string, q: string | undefined, list: 'catalogue' | 'diagnoses' = 'catalogue'): string {
    const characters = q === undefined ? 0 : [...q].length;
    if (q === undefined || characters < 2) throw searchTextTooShort();
    if (characters > CATALOG_SEARCH_MAX_LENGTH) throw searchTextTooLong();
    if (CONTROL_CHARACTER.test(q)) throw searchTextHasControlCharacter();
    if (looksLikePersonIdentifier(q)) throw searchTextNotAllowed(list);
    const now = Date.now();
    let entry = this.searches.get(membershipKey);
    if (entry === undefined || entry.windowEnds <= now) {
      if (entry === undefined && this.searches.size >= CATALOG_SEARCH_TRACKED_MEMBERSHIPS) {
        for (const [key, value] of this.searches) if (value.windowEnds <= now) this.searches.delete(key);
        if (this.searches.size >= CATALOG_SEARCH_TRACKED_MEMBERSHIPS) throw this.limited();
      }
      entry = { windowEnds: now + CATALOG_SEARCH_WINDOW_MS, count: 0 };
      this.searches.set(membershipKey, entry);
    }
    if (entry.count >= CATALOG_SEARCHES_PER_WINDOW) throw this.limited();
    entry.count += 1;
    return q;
  }

  private limited(): DomainProblem {
    return new DomainProblem(429, 'CATALOG_SEARCH_LIMITED', 'Too many searches. Please wait a minute and try again.');
  }

  /**
   * Any database failure is 503 CATALOG_UNAVAILABLE (for medicines and lab
   * tests the screens fall back to typing; for diagnoses to their built-in
   * list); q is never logged.
   */
  private async search<Row extends QueryResultRow>(sql: string, values: readonly unknown[],
    unavailable: () => DomainProblem = catalogUnavailable): Promise<Row[]> {
    try {
      return (await this.database.query<Row>(sql, values)).rows;
    } catch (error) {
      throw this.searchFailed(error, unavailable);
    }
  }

  /**
   * The national search and (0155) the facility's, in one read-only staff
   * transaction with the session's facility. A schema without 0155 (no
   * facility search: 42883) is 503 CATALOG_UNAVAILABLE, as any failure is.
   */
  private async searchWithFacility<Row extends QueryResultRow>(caller: CatalogCaller, sql: string,
    values: readonly unknown[], kind: 'medicine' | 'lab_test', q: string, facilityLimit: number):
  Promise<{ national: Row[]; own: FacilitySearchRow[] }> {
    try {
      return await this.database.withStaffTransaction(caller, async (client: PoolClient) => {
        const national = (await client.query<Row>(sql, [...values])).rows;
        const own = (await client.query<FacilitySearchRow>(FACILITY_ITEMS_SEARCH_SQL, [kind, q, facilityLimit])).rows;
        return { national, own };
      }, { readOnly: true });
    } catch (error) {
      throw this.searchFailed(error, catalogUnavailable);
    }
  }

  private searchFailed(error: unknown, unavailable: () => DomainProblem): DomainProblem {
    const code = databaseCode(error);
    if (code !== '42883' && code !== '42P01') {
      this.logger.warn(`Catalogue search failed (${typeof code === 'string' ? code : 'no database code'})`);
    }
    return unavailable();
  }
}

/** Whose searches count together: the membership at this facility (the guard has set it). */
function searchKey(caller: CatalogCaller): string {
  return caller.membershipId || `${caller.subject}@${caller.facilityId}`;
}
