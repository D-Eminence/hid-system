import { Logger, RequestMethod } from '@nestjs/common';
import type { ArgumentMetadata } from '@nestjs/common';
import { HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ANY_PERMISSIONS, AUDIT_FAILURES_ONLY, PATIENT_ALLOWED, REQUIRED_PERMISSIONS } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { HidRequest } from '../../common/request-context';
import { createValidationPipe } from '../../common/validation-pipe';
import type { DatabaseService } from '../../database/database.service';
import { EhrModule } from '../ehr.module';
import { CATALOG_CACHE_CONTROL, CatalogController, TerminologyController } from './catalog.controller';
import {
  RecentDiagnosesQueryDto, SearchCatalogLabTestsQueryDto, SearchCatalogMedicinesQueryDto, SearchDiagnosesQueryDto,
} from './catalog.dto';
import { CatalogModule } from './catalog.module';
import {
  CATALOG_SEARCHES_PER_WINDOW, CATALOG_SEARCH_WINDOW_MS, CatalogService, DIAGNOSES_SQL, LAB_TESTS_SQL, MEDICINES_SQL,
  STATUS_SQL, diagnosisSearchUnavailable, looksLikePersonIdentifier, medicineDisplay, typedIcd10,
} from './catalog.service';
import { RECENT_DIAGNOSES_SQL, RecentDiagnosesService, type RecentDiagnosesCaller } from './recent-diagnoses.service';

// Fictional identifiers only. Medicine and test names are list facts, not patient data.
const membershipA = '123e4567-e89b-42d3-a456-426614174004';
const membershipB = '123e4567-e89b-42d3-a456-426614174005';

function fakeDatabase(answer: readonly Record<string, unknown>[] | Error) {
  const calls: { sql: string; values: unknown[] }[] = [];
  const database = {
    query: jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (answer instanceof Error) throw answer;
      return { rows: answer };
    }),
    withTransaction: jest.fn(async () => { throw new Error('the catalogue needs no request transaction'); }),
  } as unknown as DatabaseService;
  return { database, calls };
}

function databaseError(code: string): Error {
  return Object.assign(new Error(`database error ${code}`), { code });
}

async function validate<T>(type: new () => T, value: unknown, kind: ArgumentMetadata['type'] = 'query'): Promise<T> {
  return createValidationPipe().transform(value, { type: kind, metatype: type }) as Promise<T>;
}

async function problemOf(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

const medicines = (overrides: Partial<SearchCatalogMedicinesQueryDto> = {}): SearchCatalogMedicinesQueryDto =>
  Object.assign(new SearchCatalogMedicinesQueryDto(), { q: 'amox', ...overrides });
const labTests = (overrides: Partial<SearchCatalogLabTestsQueryDto> = {}): SearchCatalogLabTestsQueryDto =>
  Object.assign(new SearchCatalogLabTestsQueryDto(), { q: 'fbc', ...overrides });

const medicineRow = (overrides: Record<string, unknown> = {}) => ({
  list_id: 'MED-00001', generic_name: 'amoxicillin', strength: '500 mg', dose_form: 'capsule', dose_form_text: 'Capsule',
  routes: ['oral'], common_adult_dose: null, matched_name: null, source: 'nigeria-eml-8', list_version: '2026.1',
  more: false, ...overrides,
});

describe('ORD-7 catalogue (0149, first slice)', () => {
  describe('routes', () => {
    const handlers = CatalogController.prototype as unknown as Record<string, object>;

    it('is registered in the EHR module', () => {
      expect(Reflect.getMetadata('imports', EhrModule)).toContain(CatalogModule);
      expect(Reflect.getMetadata('controllers', CatalogModule)).toEqual([CatalogController, TerminologyController]);
      expect(Reflect.getMetadata(PATH_METADATA, CatalogController)).toBe('ehr/catalog');
    });

    it.each([
      ['status', 'status', undefined],
      ['medicines', 'medicines', ['ehr.prescription.write', 'pharmacy.work-item.read']],
      ['labTests', 'lab-tests', ['ehr.lab-request.write', 'lab.work-item.read']],
    ])('%s: GET %s, any of %j, refusals audited only', (name, path, anyOf) => {
      const handler = handlers[name] as object;
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe(path);
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
      expect(Reflect.getMetadata(ANY_PERMISSIONS, handler)).toEqual(anyOf);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toBeUndefined();
      expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, handler)).toBe(true);
      expect(Reflect.getMetadata(PATIENT_ALLOWED, handler)).toBeUndefined();
      expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toBeUndefined();
    });

    it('the browser keeps an answer at most a minute, for this user only; a refusal is never kept', async () => {
      expect(CATALOG_CACHE_CONTROL).toBe('private, max-age=60');
      const setHeader = jest.fn();
      const service = {
        status: jest.fn(async () => ({ attribution: [] })),
        searchMedicines: jest.fn(async () => { throw new DomainProblem(429, 'CATALOG_SEARCH_LIMITED', 'Too many'); }),
        searchLabTests: jest.fn(async () => { throw new DomainProblem(503, 'CATALOG_UNAVAILABLE', 'Not now'); }),
      };
      const controller = new CatalogController(service as unknown as CatalogService);
      const request = { actor: { subject: 'staff:test', facility: { membershipId: membershipA } }, facilityId: 'facility',
        res: { setHeader } } as unknown as HidRequest;
      await expect(controller.medicines(request, medicines())).rejects.toMatchObject({ code: 'CATALOG_SEARCH_LIMITED' });
      await expect(controller.labTests(request, labTests())).rejects.toMatchObject({ code: 'CATALOG_UNAVAILABLE' });
      expect(setHeader).not.toHaveBeenCalled();
      await expect(controller.status(request)).resolves.toEqual({ attribution: [] });
      expect(setHeader).toHaveBeenCalledWith('Cache-Control', CATALOG_CACHE_CONTROL);
    });

    it('counts searches per membership at the facility', async () => {
      const service = { searchMedicines: jest.fn(async () => ({})), searchLabTests: jest.fn(async () => ({})) };
      const controller = new CatalogController(service as unknown as CatalogService);
      const request = { actor: { subject: 'staff:test', facility: { membershipId: membershipA } },
        facilityId: 'facility' } as unknown as HidRequest;
      await controller.medicines(request, medicines());
      await controller.labTests(request, labTests());
      expect(service.searchMedicines).toHaveBeenCalledWith(membershipA, expect.anything());
      expect(service.searchLabTests).toHaveBeenCalledWith(membershipA, expect.anything());
    });
  });

  describe('query validation', () => {
    it('takes q trimmed, limit 10 by default, and the filters', async () => {
      await expect(validate(SearchCatalogMedicinesQueryDto, { q: '  amox ' }))
        .resolves.toMatchObject({ q: 'amox', limit: 10 });
      await expect(validate(SearchCatalogMedicinesQueryDto, { q: 'amox', limit: '25', doseForm: 'capsule', route: 'Oral' }))
        .resolves.toMatchObject({ q: 'amox', limit: 25, doseForm: 'capsule', route: 'Oral' });
      await expect(validate(SearchCatalogLabTestsQueryDto, { q: 'E/U/Cr', limit: '1' }))
        .resolves.toMatchObject({ q: 'E/U/Cr', limit: 1 });
      await expect(validate(SearchCatalogLabTestsQueryDto, {})).resolves.toMatchObject({ limit: 10 });
    });

    it.each([
      ['a limit of 0', { q: 'amox', limit: '0' }],
      ['a limit of 26', { q: 'amox', limit: '26' }],
      ['a limit that is not a number', { q: 'amox', limit: 'ten' }],
      ['a limit of 2.5', { q: 'amox', limit: '2.5' }],
      ['an unknown dose form', { q: 'amox', doseForm: 'pessary' }],
      ['a route with digits', { q: 'amox', route: 'oral2' }],
      ['a route of 101 characters', { q: 'amox', route: 'o'.repeat(101) }],
      ['q of 101 characters after trimming', { q: ` ${'a'.repeat(101)} ` }],
      ['q given twice', { q: ['amox', 'para'] }],
      ['an unknown parameter', { q: 'amox', healthId: 'HID-7KQ2M9' }],
    ])('%s is VALIDATION_FAILED', async (_name, value) => {
      await expect(validate(SearchCatalogMedicinesQueryDto, value)).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });

    it('the lab-test search takes no medicine filter', async () => {
      await expect(validate(SearchCatalogLabTestsQueryDto, { q: 'fbc', doseForm: 'tablet' }))
        .rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    });
  });

  describe('a Health ID or NIN typed as q', () => {
    it.each([
      'HID-7KQ2M9', 'hid-7kq2m9', 'patient HID-7KQ2', '7KQ2M9', 'amox 7kq2m9', '12345678901', '123 4567 8901',
      '123-456-789-01', '080 1234 5678',
    ])('%j is refused', (q) => {
      expect(looksLikePersonIdentifier(q)).toBe(true);
    });

    it.each([
      'amox', 'B12', 'vitamin B12', '500mg', '125 mg/5 mL', 'co-amox', 'E/U/Cr', 'Zinc20', 'hidrasec', 'HIV 1/2',
      'paracetamol 500', 'ORS', 'G6PD', 'HbA1c', 'CD4 count', '1000000 IU',
    ])('%j is a name and is searched', (q) => {
      expect(looksLikePersonIdentifier(q)).toBe(false);
    });
  });

  describe('status', () => {
    const statusRow = (kind: string, overrides: Record<string, unknown> = {}) => ({
      kind, available: false, list_version: null, approved_day: null, offered: 0, attribution: [], file_sha256: null,
      ...overrides,
    });

    it('before a signed list is loaded: nothing is available, the later fields are off', async () => {
      const { database, calls } = fakeDatabase([statusRow('lab_test'), statusRow('medicine')]);
      await expect(new CatalogService(database).status()).resolves.toEqual({
        medicines: { available: false, version: null, approvedAt: null, fileSha256: null },
        labTests: { available: false, version: null, approvedAt: null, fileSha256: null },
        diagnoses: { available: false, release: null, fileSha256: null },
        labTestNameOnly: false, diagnosisNameOnly: false, classDuplicateCheck: false,
        attribution: [],
      });
      expect(calls).toEqual([{ sql: STATUS_SQL, values: [] }]);
      expect(STATUS_SQL).toContain("at time zone 'Africa/Lagos'");
    });

    it('a loaded list is available with its version, sign-off day, seed file and its sources\' notices, once each', async () => {
      const loinc = 'This material contains content from LOINC (http://loinc.org).';
      const who = 'WHO Model List of Essential Medicines, 24th list (2025).';
      const { database } = fakeDatabase([
        statusRow('lab_test', { available: true, list_version: '2026.1', approved_day: '2026-12-01', offered: 158,
          attribution: [loinc], file_sha256: 'b'.repeat(64) }),
        statusRow('medicine', { available: true, list_version: '2026.2', approved_day: '2026-12-02', offered: 1620,
          attribution: [who, loinc], file_sha256: 'a'.repeat(64) }),
      ]);
      await expect(new CatalogService(database).status()).resolves.toMatchObject({
        medicines: { available: true, version: '2026.2', approvedAt: '2026-12-02', fileSha256: 'a'.repeat(64) },
        labTests: { available: true, version: '2026.1', approvedAt: '2026-12-01', fileSha256: 'b'.repeat(64) },
        attribution: [loinc, who],
      });
    });

    it('an active version that offers nothing is not available, and its notices are not shown', async () => {
      const { database } = fakeDatabase([
        statusRow('lab_test', { available: true, list_version: '2026.1', approved_day: '2026-12-01', offered: 0,
          attribution: ['notice'] }),
        statusRow('medicine'),
      ]);
      await expect(new CatalogService(database).status()).resolves.toMatchObject({
        labTests: { available: false, version: null, approvedAt: null, fileSha256: null }, attribution: [],
      });
    });

    it.each(['42883', '42P01'])('on a schema without 0149 (%s) it answers 404 CATALOG_NOT_AVAILABLE', async (code) => {
      const problem = await problemOf(new CatalogService(fakeDatabase(databaseError(code)).database).status());
      expect(problem.getStatus()).toBe(404);
      expect(problem.code).toBe('CATALOG_NOT_AVAILABLE');
    });

    it('any other failure is 503 CATALOG_UNAVAILABLE', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const problem = await problemOf(new CatalogService(fakeDatabase(databaseError('57014')).database).status());
      expect([problem.getStatus(), problem.code]).toEqual([503, 'CATALOG_UNAVAILABLE']);
      expect(warn).toHaveBeenCalledWith('Catalogue status failed (57014)');
      warn.mockRestore();
    });
  });

  describe('medicine search', () => {
    it('answers the contract\'s shape: HID-MED and the fixed id, the display words, no ATC code yet', async () => {
      const { database, calls } = fakeDatabase([
        medicineRow({ more: true }),
        medicineRow({ list_id: 'MED-00003', generic_name: 'amoxicillin + clavulanic acid', strength: '625 mg',
          dose_form: 'tablet', dose_form_text: 'Tablet', matched_name: 'co-amoxiclav', common_adult_dose: '1 tablet every 12 hours',
          more: true }),
      ]);
      const answer = await new CatalogService(database).searchMedicines(membershipA,
        medicines({ q: 'amox', limit: 2, doseForm: 'capsule', route: 'Oral' }));
      expect(calls).toEqual([{ sql: MEDICINES_SQL, values: ['amox', 2, 'capsule', 'oral'] }]);
      expect(MEDICINES_SQL).not.toContain('atc_code');
      expect(answer).toEqual({
        listVersion: '2026.1',
        more: true,
        items: [
          { codeSystem: 'HID-MED', code: 'MED-00001', display: 'Amoxicillin 500 mg capsule', genericName: 'amoxicillin',
            strength: '500 mg', doseForm: 'capsule', doseFormText: 'Capsule', routes: ['oral'], atcCode: null,
            commonAdultDose: null, matchedName: null, scope: 'national', source: 'nigeria-eml-8' },
          { codeSystem: 'HID-MED', code: 'MED-00003', display: 'Amoxicillin + clavulanic acid 625 mg tablet',
            genericName: 'amoxicillin + clavulanic acid', strength: '625 mg', doseForm: 'tablet', doseFormText: 'Tablet',
            routes: ['oral'], atcCode: null, commonAdultDose: '1 tablet every 12 hours', matchedName: 'co-amoxiclav',
            scope: 'national', source: 'nigeria-eml-8' },
        ],
      });
    });

    it('sends no filter as null, and answers an empty list with no version', async () => {
      const { database, calls } = fakeDatabase([]);
      await expect(new CatalogService(database).searchMedicines(membershipA, medicines({ q: 'zzz', limit: 10 })))
        .resolves.toEqual({ listVersion: null, more: false, items: [] });
      expect(calls[0]?.values).toEqual(['zzz', 10, null, null]);
    });

    it('the display leaves out what the list does not give', () => {
      expect(medicineDisplay({ generic_name: 'oral rehydration salts', strength: null, dose_form_text: 'Powder for oral liquid' }))
        .toBe('Oral rehydration salts powder for oral liquid');
      expect(medicineDisplay({ generic_name: 'halothane', strength: null, dose_form_text: null })).toBe('Halothane');
    });
  });

  describe('lab-test search', () => {
    it('answers LOINC and HID-LAB tests with their other names and the name that matched', async () => {
      const { database, calls } = fakeDatabase([
        { list_id: 'LAB-0001', code_system: 'LOINC', code: '57021-8', display: 'Full blood count',
          other_names: ['FBC', 'CBC'], specimen: 'Blood (EDTA)', category: 'haematology', matched_name: 'FBC',
          list_version: '2026.1', more: false },
        { list_id: 'LAB-0090', code_system: 'HID-LAB', code: 'WIDAL', display: 'Widal test', other_names: null,
          specimen: null, category: 'serology', matched_name: null, list_version: '2026.1', more: false },
      ]);
      await expect(new CatalogService(database).searchLabTests(membershipA, labTests({ q: 'fbc', limit: 5 })))
        .resolves.toEqual({
          listVersion: '2026.1', more: false, items: [
            { codeSystem: 'LOINC', code: '57021-8', display: 'Full blood count', otherNames: ['FBC', 'CBC'],
              specimen: 'Blood (EDTA)', category: 'haematology', matchedName: 'FBC', scope: 'national' },
            { codeSystem: 'HID-LAB', code: 'WIDAL', display: 'Widal test', otherNames: [], specimen: null,
              category: 'serology', matchedName: null, scope: 'national' },
          ],
        });
      expect(calls).toEqual([{ sql: LAB_TESTS_SQL, values: ['fbc', 5] }]);
    });
  });

  describe('refusals before any search', () => {
    it.each([
      ['missing', undefined],
      ['of 1 character', 'a'],
      ['empty', ''],
    ])('q %s is 400 CATALOG_SEARCH_TEXT_TOO_SHORT', async (_name, q) => {
      const { database, calls } = fakeDatabase([]);
      const problem = await problemOf(new CatalogService(database).searchMedicines(membershipA, medicines({ q })));
      expect([problem.getStatus(), problem.code, problem.message]).toEqual([400, 'CATALOG_SEARCH_TEXT_TOO_SHORT',
        'Type at least 2 letters to search.']);
      expect(calls).toEqual([]);
    });

    it('a Health ID or NIN is 400 CATALOG_SEARCH_TEXT_NOT_ALLOWED, and nothing is searched', async () => {
      const { database, calls } = fakeDatabase([]);
      const service = new CatalogService(database);
      for (const q of ['HID-7KQ2M9', '12345678901']) {
        const problem = await problemOf(service.searchLabTests(membershipA, labTests({ q })));
        expect([problem.getStatus(), problem.code, problem.message]).toEqual([400, 'CATALOG_SEARCH_TEXT_NOT_ALLOWED',
          'Search by medicine or test name. Do not type a Health ID or NIN here.']);
      }
      expect(calls).toEqual([]);
    });

    // q's length in code points, as the database's char_length counts it, not in UTF-16 units.
    it.each([
      ['one emoji', '\u{1F600}'],
      ['one mathematical letter (U+1D538)', '\u{1D538}'],
    ])('q of %s is one character: 400 CATALOG_SEARCH_TEXT_TOO_SHORT, and nothing is searched', async (_name, q) => {
      expect(q).toHaveLength(2);
      const { database, calls } = fakeDatabase([]);
      const service = new CatalogService(database);
      for (const search of [service.searchMedicines(membershipA, medicines({ q })),
        service.searchLabTests(membershipA, labTests({ q }))]) {
        const problem = await problemOf(search);
        expect([problem.getStatus(), problem.code]).toEqual([400, 'CATALOG_SEARCH_TEXT_TOO_SHORT']);
      }
      expect(calls).toEqual([]);
    });

    it('q of two code points is searched, though one of them is two UTF-16 units', async () => {
      const { database, calls } = fakeDatabase([]);
      const service = new CatalogService(database);
      await service.searchMedicines(membershipA, medicines({ q: 'a\u{1D538}' }));
      await service.searchLabTests(membershipA, labTests({ q: '\u{1F600}\u{1F600}' }));
      expect(calls.map((call) => call.values[0])).toEqual(['a\u{1D538}', '\u{1F600}\u{1F600}']);
    });

    it('q of 100 code points is searched; over 100 is VALIDATION_FAILED, even where the validator counted fewer', async () => {
      const astral = '\u{1D538}'.repeat(100);
      const presented = '\u2764\uFE0F'.repeat(51);
      // The query validator counts 100 and 51 characters (it leaves out the presentation selectors); the database 100 and 102.
      await expect(validate(SearchCatalogLabTestsQueryDto, { q: astral })).resolves.toMatchObject({ q: astral });
      await expect(validate(SearchCatalogLabTestsQueryDto, { q: presented })).resolves.toMatchObject({ q: presented });
      const { database, calls } = fakeDatabase([]);
      const service = new CatalogService(database);
      await service.searchLabTests(membershipA, labTests({ q: astral }));
      const problem = await problemOf(service.searchMedicines(membershipA, medicines({ q: presented })));
      expect([problem.getStatus(), problem.code, problem.errors]).toEqual([400, 'VALIDATION_FAILED',
        [{ field: 'q', messages: ['q must be shorter than or equal to 100 characters'] }]]);
      expect(calls.map((call) => call.values[0])).toEqual([astral]);
    });
  });

  describe('300 searches per 5 minutes per membership', () => {
    afterEach(() => jest.useRealTimers());

    it('refuses the 301st with 429 CATALOG_SEARCH_LIMITED until the window ends; others are not affected', async () => {
      jest.useFakeTimers({ now: new Date('2026-11-23T10:00:00Z') });
      const { database, calls } = fakeDatabase([]);
      const service = new CatalogService(database);
      for (let index = 0; index < CATALOG_SEARCHES_PER_WINDOW; index += 1) {
        await (index % 2 === 0 ? service.searchMedicines(membershipA, medicines()) : service.searchLabTests(membershipA, labTests()));
      }
      const problem = await problemOf(service.searchLabTests(membershipA, labTests()));
      expect([problem.getStatus(), problem.code, problem.message]).toEqual([429, 'CATALOG_SEARCH_LIMITED',
        'Too many searches. Please wait a minute and try again.']);
      await expect(service.searchMedicines(membershipB, medicines())).resolves.toMatchObject({ items: [] });
      expect(calls).toHaveLength(CATALOG_SEARCHES_PER_WINDOW + 1);
      jest.setSystemTime(new Date(Date.now() + CATALOG_SEARCH_WINDOW_MS));
      await expect(service.searchMedicines(membershipA, medicines())).resolves.toMatchObject({ items: [] });
    });

    it('a refused text does not count', async () => {
      const { database } = fakeDatabase([]);
      const service = new CatalogService(database);
      for (let index = 0; index < CATALOG_SEARCHES_PER_WINDOW + 5; index += 1) {
        await problemOf(service.searchMedicines(membershipA, medicines({ q: 'a' })));
      }
      await expect(service.searchMedicines(membershipA, medicines())).resolves.toMatchObject({ items: [] });
    });
  });

  describe('ORD-9 (0150): the ICD-11 diagnosis search', () => {
    const diagnoses = (q?: string, limit = 10) => Object.assign(new SearchDiagnosesQueryDto(), { q, limit });

    it('GET ehr/terminology/diagnoses: ehr.diagnosis.write, refusals audited only, in the catalogue module', () => {
      const handler = (TerminologyController.prototype as unknown as Record<string, object>).diagnoses as object;
      expect(Reflect.getMetadata(PATH_METADATA, TerminologyController)).toBe('ehr/terminology');
      expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('diagnoses');
      expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.diagnosis.write']);
      expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, handler)).toBe(true);
      expect(Reflect.getMetadata('controllers', CatalogModule)).toEqual([CatalogController, TerminologyController]);
    });

    it('answers the contract\'s shape: ICD-11, WHO\'s title as display, our other name that matched', async () => {
      const { database, calls } = fakeDatabase([
        { code: '1F40', title: 'Malaria due to Plasmodium falciparum', matched_name: 'falciparum malaria',
          list_version: '2026-01', more: true },
        { code: 'KA64.20', title: 'Congenital falciparum malaria', matched_name: null, list_version: '2026-01', more: true },
      ]);
      await expect(new CatalogService(database).searchDiagnoses(membershipA, diagnoses('falciparum', 2))).resolves.toEqual({
        release: 'ICD-11 MMS 2026-01', more: true, typedIcd10: null,
        results: [
          { codeSystem: 'ICD-11', code: '1F40', display: 'Malaria due to Plasmodium falciparum',
            matchedName: 'falciparum malaria' },
          { codeSystem: 'ICD-11', code: 'KA64.20', display: 'Congenital falciparum malaria', matchedName: null },
        ],
      });
      expect(calls).toEqual([{ sql: DIAGNOSES_SQL, values: ['falciparum', 2] }]);
    });

    it.each([
      ['B50.9', { codeSystem: 'ICD-10', code: 'B50.9' }],
      ['b50.9', { codeSystem: 'ICD-10', code: 'B50.9' }],
      ['A09', { codeSystem: 'ICD-10', code: 'A09' }],
      ['J45.909', { codeSystem: 'ICD-10', code: 'J45.909' }],
      ['U07.1', { codeSystem: 'ICD-10', code: 'U07.1' }],
      ['1F40', null],
      ['BA00', null],
      ['5A11.Z', null],
      ['malaria', null],
      ['B50.91234', null],
    ])('q %j as an ICD-10 code: %j (accepted as typed; no ICD-10 title)', (q, expected) => {
      expect(typedIcd10(q)).toEqual(expected);
    });

    it('an ICD-10 code typed finds nothing in ICD-11 and says so', async () => {
      const { database } = fakeDatabase([]);
      await expect(new CatalogService(database).searchDiagnoses(membershipA, diagnoses('B50.9'))).resolves.toEqual({
        release: null, more: false, results: [], typedIcd10: { codeSystem: 'ICD-10', code: 'B50.9' } });
    });

    it('refuses as the catalogue does, with the diagnosis words for a Health ID or NIN', async () => {
      const { database, calls } = fakeDatabase([]);
      const service = new CatalogService(database);
      expect((await problemOf(service.searchDiagnoses(membershipA, diagnoses('m')))).code).toBe('CATALOG_SEARCH_TEXT_TOO_SHORT');
      const problem = await problemOf(service.searchDiagnoses(membershipA, diagnoses('HID-7KQ2M9')));
      expect([problem.code, problem.message]).toEqual(['CATALOG_SEARCH_TEXT_NOT_ALLOWED',
        'Search by diagnosis name or code. Do not type a Health ID or NIN here.']);
      expect(calls).toEqual([]);
    });

    // Rahman's review of #320, nit 6: admit() counts code points for the diagnosis search too, as char_length does.
    it('counts q in code points: one astral character is too short, two are searched, over 100 is VALIDATION_FAILED',
      async () => {
        const { database, calls } = fakeDatabase([]);
        const service = new CatalogService(database);
        for (const q of ['\u{1F600}', '\u{1D538}']) {
          const problem = await problemOf(service.searchDiagnoses(membershipA, diagnoses(q)));
          expect([problem.getStatus(), problem.code]).toEqual([400, 'CATALOG_SEARCH_TEXT_TOO_SHORT']);
        }
        const tooLong = await problemOf(service.searchDiagnoses(membershipA, diagnoses('\u2764\uFE0F'.repeat(51))));
        expect([tooLong.getStatus(), tooLong.code]).toEqual([400, 'VALIDATION_FAILED']);
        await service.searchDiagnoses(membershipA, diagnoses('a\u{1D538}'));
        expect(calls.map((call) => call.values[0])).toEqual(['a\u{1D538}']);
      });

    it.each(['42883', '42P01', '57014', '08006'])('%s is 503 CATALOG_UNAVAILABLE in words true in every case; q is never logged',
      async (code) => {
        const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const failed = await problemOf(new CatalogService(fakeDatabase(databaseError(code)).database)
          .searchDiagnoses(membershipA, diagnoses('malaria')));
        // The same words for a schema without 0150 (42883, 42P01) as for a passing failure, so no advice: trying again
        // does not help while 0150 is not there, and a name alone is not accepted yet (clinical.dto.ts still requires
        // the code), so no "type it instead" either.
        expect([failed.getStatus(), failed.code, failed.message]).toEqual([503, 'CATALOG_UNAVAILABLE',
          'Diagnosis search is not available right now.']);
        expect(failed.message).not.toMatch(/try|again|minute|type|instead/i);
        expect(diagnosisSearchUnavailable().message).toBe(failed.message);
        expect(warn.mock.calls.map((call) => String(call[0])).join('\n')).not.toMatch(/malaria/);
        expect(warn).toHaveBeenCalledTimes(code === '42883' || code === '42P01' ? 0 : 1);
        warn.mockRestore();
      });

    it('the status names the loaded ICD-11 release and its notice', async () => {
      const icd = 'ICD-11 notice';
      const { database } = fakeDatabase([
        { kind: 'diagnosis', available: true, list_version: '2026-01', approved_day: '2026-12-01', offered: 17255,
          attribution: [icd], file_sha256: 'd'.repeat(64) },
        { kind: 'lab_test', available: false, list_version: null, approved_day: null, offered: 0, attribution: [],
          file_sha256: null },
        { kind: 'medicine', available: false, list_version: null, approved_day: null, offered: 0, attribution: [],
          file_sha256: null },
      ]);
      await expect(new CatalogService(database).status()).resolves.toMatchObject({
        diagnoses: { available: true, release: 'ICD-11 MMS 2026-01', fileSha256: 'd'.repeat(64) },
        medicines: { available: false }, attribution: [icd],
      });
    });
  });

  describe('database failures', () => {
    it.each(['42883', '42P01', '57014', '08006', '42501'])('%s is 503 CATALOG_UNAVAILABLE, and q is never logged', async (code) => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      const service = new CatalogService(fakeDatabase(databaseError(code)).database);
      for (const promise of [service.searchMedicines(membershipA, medicines({ q: 'paracetamol' })),
        service.searchLabTests(membershipA, labTests({ q: 'malaria' }))]) {
        const problem = await problemOf(promise);
        expect([problem.getStatus(), problem.code, problem.message]).toEqual([503, 'CATALOG_UNAVAILABLE',
          'The list cannot be searched right now. You can type the name instead.']);
      }
      const logged = warn.mock.calls.map((call) => String(call[0])).join('\n');
      expect(logged).not.toMatch(/paracetamol|malaria/);
      expect(warn).toHaveBeenCalledTimes(code === '42883' || code === '42P01' ? 0 : 2);
      warn.mockRestore();
    });
  });
});

describe('ORD-9 (0151): recent diagnoses', () => {
  const facilityId = '123e4567-e89b-42d3-a456-426614174001';
  const caller: RecentDiagnosesCaller = { subject: 'staff:test-doctor', accountId: '123e4567-e89b-42d3-a456-426614174002',
    organizationId: '123e4567-e89b-42d3-a456-426614174003', facilityId, membershipId: membershipA,
    correlationId: 'correlation-0151' };
  const lastUsedAt = new Date('2026-11-23T10:42:00.000Z');

  /** withStaffTransaction with one client; the audit row is written with that client. */
  function fakeStaff(answer: readonly Record<string, unknown>[] | Error, auditFailure?: Error) {
    const calls: { sql: string; values: unknown[] }[] = [];
    const audits: { client: unknown; event: Record<string, unknown> }[] = [];
    const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
      calls.push({ sql, values });
      if (answer instanceof Error) throw answer;
      return { rows: answer };
    }) };
    const database = {
      withStaffTransaction: jest.fn(async (_staff: unknown, operation: (c: typeof client) => Promise<unknown>) =>
        operation(client)),
      withTransaction: jest.fn(async () => { throw new Error('recent diagnoses take no purpose of use'); }),
    } as unknown as DatabaseService;
    const audit = { recordWithClient: jest.fn(async (used: unknown, event: Record<string, unknown>) => {
      if (auditFailure) throw auditFailure;
      audits.push({ client: used, event });
    }) };
    return { service: new RecentDiagnosesService(database, audit as never), database, client, calls, audits };
  }

  it('GET ehr/terminology/diagnoses/recent: ehr.diagnosis.write, no purpose header, not kept, in the catalogue module', () => {
    const handler = (TerminologyController.prototype as unknown as Record<string, object>).recentDiagnoses as object;
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('diagnoses/recent');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.diagnosis.write']);
    expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, handler)).toBe(true);
    expect(Reflect.getMetadata(HEADERS_METADATA, handler)).toBeUndefined();
    expect(Reflect.getMetadata('providers', CatalogModule)).toEqual([CatalogService, RecentDiagnosesService]);
  });

  it('the route reads the guards\' actor at this facility, sets no header and needs no X-Purpose-Of-Use', async () => {
    const { service } = fakeStaff([]);
    const list = jest.spyOn(service, 'list');
    const controller = new TerminologyController(new CatalogService(fakeDatabase([]).database), service);
    const setHeader = jest.fn();
    const request = { correlationId: 'correlation-0151', facilityId, res: { setHeader }, header: () => undefined,
      actor: { subject: caller.subject, accountId: caller.accountId,
        facility: { membershipId: membershipA, organizationId: caller.organizationId } } } as unknown as HidRequest;
    await expect(controller.recentDiagnoses(request, Object.assign(new RecentDiagnosesQueryDto(), { limit: 5 })))
      .resolves.toEqual({ items: [] });
    expect(list).toHaveBeenCalledWith(caller, 5);
    expect(setHeader).not.toHaveBeenCalled();
    expect(() => controller.recentDiagnoses({ ...request, actor: undefined } as unknown as HidRequest,
      new RecentDiagnosesQueryDto())).toThrow('Request context was not established by security guards');
  });

  it('limit is 1-50, default 20', async () => {
    await expect(validate(RecentDiagnosesQueryDto, {})).resolves.toMatchObject({ limit: 20 });
    await expect(validate(RecentDiagnosesQueryDto, { limit: '50' })).resolves.toMatchObject({ limit: 50 });
    for (const limit of ['0', '51', '2.5', 'ten']) {
      await expect(validate(RecentDiagnosesQueryDto, { limit })).rejects.toMatchObject({ status: 400 });
    }
    await expect(validate(RecentDiagnosesQueryDto, { limit: null }, 'body')).rejects.toMatchObject({ status: 400 });
  });

  it('answers the contract\'s shape, newest first as read, and audits the read with the count only, in its transaction', async () => {
    const { service, database, client, calls, audits } = fakeStaff([
      { code_system: 'ICD-11', code: '1F40', display: 'Malaria due to Plasmodium falciparum', last_used_at: lastUsedAt,
        use_count: 14 },
      { code_system: 'ICD-10', code: 'B50.9', display: 'Malaria (test)', last_used_at: lastUsedAt, use_count: 1 },
    ]);
    await expect(service.list(caller, 20)).resolves.toEqual({ items: [
      { codeSystem: 'ICD-11', code: '1F40', display: 'Malaria due to Plasmodium falciparum',
        lastUsedAt: '2026-11-23T10:42:00.000Z', useCount: 14 },
      { codeSystem: 'ICD-10', code: 'B50.9', display: 'Malaria (test)', lastUsedAt: '2026-11-23T10:42:00.000Z',
        useCount: 1 },
    ] });
    expect(database.withStaffTransaction).toHaveBeenCalledWith(caller, expect.any(Function));
    expect(calls).toEqual([{ sql: RECENT_DIAGNOSES_SQL, values: [20] }]);
    expect(audits).toEqual([{ client, event: {
      correlationId: 'correlation-0151', actorType: 'staff', actorSubject: caller.subject, actorAccountId: caller.accountId,
      actorMembershipId: membershipA, organizationId: caller.organizationId, facilityId,
      action: 'ehr.terminology.recent-read', resourceType: 'recent-diagnoses', outcome: 'success',
      details: { resultCount: 2 } } }]);
    expect(JSON.stringify(audits)).not.toMatch(/1F40|B50|Malaria/);
  });

  it.each(['42883', '42P01', '57014', '42501'])('%s is 503 CATALOG_UNAVAILABLE in the diagnosis search\'s words; a schema '
    + 'without 0151 is not logged', async (code) => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service, audits } = fakeStaff(databaseError(code));
    const problem = await problemOf(service.list(caller, 20));
    // The same words as the diagnosis search's 503 (#320), so no advice: trying again does not help while 0151 is
    // not there, and a name alone is not accepted yet, so no "type the name instead" either.
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([503, 'CATALOG_UNAVAILABLE',
      'Diagnosis search is not available right now.']);
    expect(problem.message).toBe(diagnosisSearchUnavailable().message);
    expect(problem.message).not.toMatch(/try|again|minute|type|instead/i);
    expect(audits).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(code === '42883' ? 0 : 1);
    warn.mockRestore();
  });

  it('a read whose audit row cannot be written is refused (503), never answered unaudited', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { service } = fakeStaff([], databaseError('53300'));
    const problem = await problemOf(service.list(caller, 20));
    expect([problem.getStatus(), problem.code, problem.message]).toEqual([503, 'CATALOG_UNAVAILABLE',
      'Diagnosis search is not available right now.']);
    warn.mockRestore();
  });
});
