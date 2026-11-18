import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { CURRENT_PRESCRIPTIONS_QUERY, DUPLICATE_CHECK_NOT_RUN, DuplicateMedicineCheckDto, DuplicateMedicineChecker,
  DuplicateMedicinesController, duplicateMessage, matchKind, medicineName } from './duplicate-medicines';
import { PrescriptionsController } from './prescriptions.controller';

// Fictional ids and medicines only.
const patientId = 'a1b2c3d4-0000-4000-8000-000000000001';
const facilityId = 'a1b2c3d4-0000-4000-8000-000000000002';
const encounterId = 'a1b2c3d4-0000-4000-8000-000000000003';
const id = (n: number) => `a1b2c3d4-0000-4000-8000-${String(n).padStart(12, '0')}`;

const context = { correlationId: 'duplicate-check-correlation', facilityId, membershipId: id(90),
  purposeOfUse: 'direct-care', actor: { id: 'staff:doctor', subject: 'staff:doctor', accountId: id(91), roles: ['doctor'],
    permissions: ['ehr.prescription.write'], facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' },
} as unknown as DataAccessContext;

const row = (n: number, medicationDisplay: string, extra: Record<string, unknown> = {}) => ({
  id: id(n), encounterId, medicationDisplay, medicationCodeSystem: null, medicationCode: null, status: 'active',
  startsOn: '2026-11-10', endsOn: null, createdAt: new Date('2026-11-10T08:00:00Z'), ...extra });

/** A repository whose run behaves as ClinicalRepository.run: the operation's value, its details kept for the audit. */
function harness(rows: unknown[], allowed: boolean | null = true) {
  const audits: unknown[] = [];
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('ehr.context_allows')) return { rows: [{ allowed }] };
    if (sql === CURRENT_PRESCRIPTIONS_QUERY) return { rows };
    return { rows: [] };
  });
  const repository = { run: jest.fn(async (_context: unknown, _patientId: unknown, access: unknown, event: unknown,
    operation: (client: unknown) => Promise<{ value: unknown; details?: unknown }>) => {
    const result = await operation({ query });
    audits.push({ access, event, details: result.details });
    return result.value;
  }) };
  return { checker: new DuplicateMedicineChecker(repository as never), query, repository, audits };
}

describe('the medicine name (ORD-10 phase 1)', () => {
  it.each([
    ['Amoxicillin 500 mg capsules', 'amoxicillin'],
    ['amoxicillin 250mg', 'amoxicillin'],
    ['AMOXICILLIN (Amoxil) 500mg caps', 'amoxicillin'],
    ['Paracetamol 1 g tablet', 'paracetamol'],
    ['Artemether/Lumefantrine 20/120 mg', 'artemether lumefantrine'],
    ['Metformin 500 mg extended release', 'metformin'],
    ['500 mg', ''],
  ])('%s is %s', (display, name) => expect(medicineName(display)).toBe(name));

  it('matches by code within the same code system, or by name', () => {
    expect(matchKind({ medicationDisplay: 'Amoxil', medicationCodeSystem: 'ATC', medicationCode: 'J01CA04' },
      { medicationDisplay: 'Amoxicillin', medicationCodeSystem: 'atc', medicationCode: 'j01ca04' })).toBe('code');
    expect(matchKind({ medicationDisplay: 'Amoxil', medicationCodeSystem: 'ATC', medicationCode: 'J01CA04' },
      { medicationDisplay: 'Something else', medicationCodeSystem: 'RxNorm', medicationCode: 'J01CA04' })).toBeUndefined();
    expect(matchKind({ medicationDisplay: 'Amoxicillin 500 mg' },
      { medicationDisplay: 'amoxicillin 250mg', medicationCodeSystem: null, medicationCode: null })).toBe('name');
    expect(matchKind({ medicationDisplay: 'Amoxicillin 500 mg' },
      { medicationDisplay: 'Ampicillin 500 mg', medicationCodeSystem: null, medicationCode: null })).toBeUndefined();
    expect(matchKind({ medicationDisplay: '500 mg' },
      { medicationDisplay: '500 mg', medicationCodeSystem: null, medicationCode: null })).toBeUndefined();
  });

  it('says it in plain words, and nothing when there is nothing', () => {
    expect(duplicateMessage(0)).toBeNull();
    expect(duplicateMessage(1)).toBe('This patient already has a current prescription for this medicine. Check it before you continue.');
    expect(duplicateMessage(2)).toBe('This patient already has 2 current prescriptions for this medicine. Check them before you continue.');
    expect(`${duplicateMessage(1)} ${duplicateMessage(3)}`).not.toMatch(/unverified/i);
  });
});

describe('the duplicate-medicine check (ORD-10 phase 1)', () => {
  it('warns about current prescriptions of the same medicine, read under consent, and audits counts only', async () => {
    const { checker, query, audits } = harness([
      row(1, 'Amoxicillin 250 mg', { status: 'on_hold', endsOn: '2026-11-30' }),
      row(2, 'Paracetamol 1 g'),
      row(3, 'Amoxil', { medicationCodeSystem: 'ATC', medicationCode: 'J01CA04', status: 'draft' }),
    ]);
    const answer = await checker.check(context, patientId, { medicationDisplay: 'Amoxicillin 500 mg capsules',
      medicationCodeSystem: 'ATC', medicationCode: 'J01CA04' });
    expect(answer).toEqual({ checked: true, message: 'This patient already has 2 current prescriptions for this medicine. Check them before you continue.',
      matches: [
        { prescriptionId: id(1), encounterId, medicationDisplay: 'Amoxicillin 250 mg', status: 'on_hold',
          startsOn: '2026-11-10', endsOn: '2026-11-30', createdAt: '2026-11-10T08:00:00.000Z', matchedBy: 'name' },
        { prescriptionId: id(3), encounterId, medicationDisplay: 'Amoxil', status: 'draft', startsOn: '2026-11-10',
          endsOn: null, createdAt: '2026-11-10T08:00:00.000Z', matchedBy: 'code' },
      ] });
    expect(query).toHaveBeenCalledWith(CURRENT_PRESCRIPTIONS_QUERY, [patientId, facilityId, null, 500]);
    expect(audits).toEqual([{ access: 'read_records', event: { action: 'ehr.prescription.duplicate-check',
      resourceType: 'prescription', resourceId: patientId }, details: { comparedCount: 3, matchCount: 2 } }]);
    expect(JSON.stringify(audits)).not.toMatch(/amoxicillin/i);
  });

  it('compares only current prescriptions at this facility, leaving out the one being changed', async () => {
    const { checker, query } = harness([]);
    const answer = await checker.check(context, patientId, { medicationDisplay: 'Amoxicillin', excludePrescriptionId: id(7) });
    expect(answer).toEqual({ checked: true, matches: [], message: null });
    expect(query).toHaveBeenCalledWith(CURRENT_PRESCRIPTIONS_QUERY, [patientId, facilityId, id(7), 500]);
    expect(CURRENT_PRESCRIPTIONS_QUERY).toMatch(/status in \('draft', 'active', 'on_hold'\)/);
    expect(CURRENT_PRESCRIPTIONS_QUERY).toMatch(/facility_id = \$2/);
    expect(CURRENT_PRESCRIPTIONS_QUERY).toMatch(/ends_on >= \(now\(\) at time zone 'Africa\/Lagos'\)::date/);
    expect(CURRENT_PRESCRIPTIONS_QUERY).not.toMatch(/\b(insert|update|delete|for update|for share)\b/i);
  });

  it('refuses rather than answer "no match" when the records cannot be read here', async () => {
    const { checker, query } = harness([row(1, 'Amoxicillin')], false);
    await expect(checker.check(context, patientId, { medicationDisplay: 'Amoxicillin' }))
      .rejects.toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
    expect(query).not.toHaveBeenCalledWith(CURRENT_PRESCRIPTIONS_QUERY, expect.anything());
  });

  it('takes the medicine in the body only, with the same limits as a prescription', async () => {
    const check = (body: unknown) => validate(plainToInstance(DuplicateMedicineCheckDto, body),
      { whitelist: true, forbidNonWhitelisted: true });
    expect(await check({ medicationDisplay: 'Amoxicillin' })).toEqual([]);
    expect(await check({ medicationDisplay: '' })).not.toEqual([]);
    expect(await check({ medicationDisplay: 'A'.repeat(501) })).not.toEqual([]);
    expect(await check({ medicationDisplay: 'Amoxicillin', excludePrescriptionId: 'not-an-id' })).not.toEqual([]);
    expect(await check({ medicationDisplay: 'Amoxicillin', healthId: 'HID-ABC123' })).not.toEqual([]);
  });

  it('is POST ehr/patients/:patientId/duplicate-medicine-check, 200, for those who may prescribe', () => {
    const handler = DuplicateMedicinesController.prototype.check;
    expect(Reflect.getMetadata(PATH_METADATA, DuplicateMedicinesController)).toBe('ehr/patients/:patientId');
    expect(Reflect.getMetadata(PATH_METADATA, handler)).toBe('duplicate-medicine-check');
    expect(Reflect.getMetadata(METHOD_METADATA, handler)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, handler)).toBe(200);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, handler)).toEqual(['ehr.prescription.write']);
  });
});

describe('a new prescription carries the warning, and never fails because of it', () => {
  const request = { actor: { id: 'staff:doctor', subject: 'staff:doctor', accountId: id(91), roles: [], permissions: [],
    facilityIds: [facilityId], facilities: [], facility: { membershipId: id(90) }, authenticationMethod: 'local' },
  facilityId, correlationId: 'correlation-123456', method: 'POST',
  header: (name: string) => (name === 'x-purpose-of-use' ? 'direct-care' : undefined) } as unknown as HidRequest;
  const created = { id: id(5), medicationDisplay: 'Amoxicillin 500 mg', medicationCodeSystem: null,
    medicationCode: null, status: 'active' };

  it('adds duplicateMedicines, leaving the new prescription itself out', async () => {
    const { checker, query } = harness([row(1, 'Amoxicillin 250 mg')]);
    const prescriptions = { create: jest.fn().mockResolvedValue(created) };
    const controller = new PrescriptionsController(prescriptions as never, undefined, checker);
    const answer = await controller.create(request, patientId, encounterId, 'idempotency-key-123456', {} as never);
    expect(answer).toMatchObject({ ...created, duplicateMedicines: { checked: true, matches: [{ prescriptionId: id(1) }] } });
    expect(query).toHaveBeenCalledWith(CURRENT_PRESCRIPTIONS_QUERY, [patientId, facilityId, id(5), 500]);
  });

  it('says the check did not run when it cannot, and still answers the create', async () => {
    const repository = { run: jest.fn().mockRejectedValue(new Error('identity down')) };
    const prescriptions = { create: jest.fn().mockResolvedValue(created) };
    const controller = new PrescriptionsController(prescriptions as never, undefined,
      new DuplicateMedicineChecker(repository as never));
    expect(await controller.create(request, patientId, encounterId, 'idempotency-key-123456', {} as never))
      .toEqual({ ...created, duplicateMedicines: DUPLICATE_CHECK_NOT_RUN });
  });

  it('does not look for duplicates of a prescription created already ended', async () => {
    const { checker, repository } = harness([row(1, 'Amoxicillin')]);
    const answer = await checker.afterCreate(context, patientId, { ...created, status: 'cancelled' });
    expect(answer.duplicateMedicines).toEqual({ checked: true, matches: [], message: null });
    expect(repository.run).not.toHaveBeenCalled();
  });
});
