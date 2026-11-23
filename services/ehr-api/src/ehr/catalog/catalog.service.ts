import { Injectable, Logger } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../../common/problem';
import { DatabaseService } from '../../database/database.service';
import type { CATALOG_LAB_CATEGORIES, CatalogDoseForm, SearchCatalogLabTestsQueryDto,
  SearchCatalogMedicinesQueryDto } from './catalog.dto';

/**
 * ORD-7, first slice (0149): the national medicine and lab-test lists'
 * status and search. The lists hold no patient: no X-Purpose-Of-Use, no
 * patient audit row, and q is never written to an audit row or a log. The
 * database functions are SECURITY DEFINER and read only the active, signed
 * version, so they run on the pool without a request transaction.
 */

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
  /** ORD-9 (0150): the ICD-11 release the diagnosis search uses, when one is loaded. */
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

export interface CatalogMedicine {
  codeSystem: 'HID-MED';
  code: string;
  display: string;
  genericName: string;
  strength: string | null;
  doseForm: CatalogDoseForm;
  doseFormText: string | null;
  routes: string[];
  /** Always null until the WHOCC terms for ATC codes are settled (planned contract, open points). */
  atcCode: null;
  commonAdultDose: string | null;
  matchedName: string | null;
  scope: 'national';
  source: string;
}

export interface CatalogLabTest {
  codeSystem: 'LOINC' | 'HID-LAB';
  code: string;
  display: string;
  otherNames: string[];
  specimen: string | null;
  category: (typeof CATALOG_LAB_CATEGORIES)[number];
  matchedName: string | null;
  scope: 'national';
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

export function searchTextNotAllowed(list: 'catalogue' | 'diagnoses' = 'catalogue'): DomainProblem {
  return new DomainProblem(400, 'CATALOG_SEARCH_TEXT_NOT_ALLOWED', list === 'diagnoses'
    ? 'Search by diagnosis name or code. Do not type a Health ID or NIN here.'
    : 'Search by medicine or test name. Do not type a Health ID or NIN here.');
}

/**
 * An ICD-10 code as typed (planned contract, ORD-9): a letter, two digits or
 * a digit and a letter, then optionally a dot and up to 4 more. No ICD-11
 * code has this shape (an ICD-11 code's second character is a letter).
 */
const ICD10_CODE = /^[A-Za-z](?:[0-9]{2}|[0-9][A-Za-z])(?:\.[0-9A-Za-z]{1,4})?$/;
export function typedIcd10(q: string): { codeSystem: 'ICD-10'; code: string } | null {
  return ICD10_CODE.test(q) ? { codeSystem: 'ICD-10', code: q.toUpperCase() } : null;
}

export function catalogUnavailable(): DomainProblem {
  return new DomainProblem(503, 'CATALOG_UNAVAILABLE', 'The list cannot be searched right now. You can type the name instead.');
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
   * version offers at least one row. On a schema without 0149 this answers
   * 404 CATALOG_NOT_AVAILABLE, as the contract says it does before ORD-7
   * ships, so the screens keep their built-in lists.
   */
  async status(): Promise<CatalogStatus> {
    let rows: StatusRow[];
    try {
      rows = (await this.database.query<StatusRow>(STATUS_SQL)).rows;
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

  async searchMedicines(membershipKey: string, query: SearchCatalogMedicinesQueryDto):
  Promise<CatalogSearchAnswer<CatalogMedicine>> {
    const q = this.admit(membershipKey, query.q);
    const rows = await this.search<MedicineRow>(MEDICINES_SQL,
      [q, query.limit, query.doseForm ?? null, query.route === undefined ? null : query.route.toLowerCase()]);
    return {
      listVersion: rows[0]?.list_version ?? null,
      more: rows.some((row) => row.more),
      items: rows.map((row) => ({
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
      })),
    };
  }

  async searchLabTests(membershipKey: string, query: SearchCatalogLabTestsQueryDto):
  Promise<CatalogSearchAnswer<CatalogLabTest>> {
    const q = this.admit(membershipKey, query.q);
    const rows = await this.search<LabTestRow>(LAB_TESTS_SQL, [q, query.limit]);
    return {
      listVersion: rows[0]?.list_version ?? null,
      more: rows.some((row) => row.more),
      items: rows.map((row) => ({
        codeSystem: row.code_system,
        code: row.code,
        display: row.display,
        otherNames: row.other_names ?? [],
        specimen: row.specimen,
        category: row.category,
        matchedName: row.matched_name,
        scope: 'national',
      })),
    };
  }

  /**
   * ORD-9 (0150): the active ICD-11 release's entries for q, in the
   * contract's shape, and q as an ICD-10 code when it is shaped like one.
   */
  async searchDiagnoses(membershipKey: string, query: SearchCatalogLabTestsQueryDto): Promise<TerminologyDiagnosisAnswer> {
    const q = this.admit(membershipKey, query.q, 'diagnoses');
    const rows = await this.search<DiagnosisRow>(DIAGNOSES_SQL, [q, query.limit]);
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
   * refused text does not count.
   */
  private admit(membershipKey: string, q: string | undefined, list: 'catalogue' | 'diagnoses' = 'catalogue'): string {
    if (q === undefined || q.length < 2) throw searchTextTooShort();
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

  /** Any database failure is 503 CATALOG_UNAVAILABLE, on which the screens fall back to typing; q is never logged. */
  private async search<Row extends QueryResultRow>(sql: string, values: readonly unknown[]): Promise<Row[]> {
    try {
      return (await this.database.query<Row>(sql, values)).rows;
    } catch (error) {
      const code = databaseCode(error);
      if (code !== '42883' && code !== '42P01') {
        this.logger.warn(`Catalogue search failed (${typeof code === 'string' ? code : 'no database code'})`);
      }
      throw catalogUnavailable();
    }
  }
}
