import { Logger } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { DataAccessContext } from '../../common/request-context';
import { OrderStatus } from '../shared/clinical.dto';
import { OWN_PHARMACY_SEND_OFF, OwnPharmacySend, pharmacyHandoff } from './own-pharmacy-send';
import { PrescriptionsModule } from './prescriptions.module';
import { PrescriptionsService, type PrescriptionRow } from './prescriptions.service';

/*
 * Activated prescriptions go to this hospital's own pharmacy (0133; owner,
 * 18 November 2026: "activated prescriptions go automatically to the
 * hospital's own pharmacy: YES"). Activating a draft (or writing a
 * prescription as active) asks ehr.send_prescription_to_own_pharmacy in the
 * same transaction, in a savepoint, and answers `pharmacyHandoff`; a failure
 * never undoes the activation. Holding, cancelling or entering it in error
 * asks ehr.withdraw_own_pharmacy_send. "Send to pharmacy" sends again.
 */

const patientId = '123e4567-e89b-42d3-a456-426614174001';
const facilityId = '123e4567-e89b-42d3-a456-426614174002';
const accountId = '123e4567-e89b-42d3-a456-426614174003';
const membershipId = '123e4567-e89b-42d3-a456-426614174004';
const prescriptionId = '123e4567-e89b-42d3-a456-426614174005';
const encounterId = '123e4567-e89b-42d3-a456-426614174006';

const context = { correlationId: 'correlation-own-pharmacy', facilityId, membershipId, purposeOfUse: 'direct-care',
  authorization: 'Bearer user', actor: { id: accountId, subject: 'staff:doctor', accountId,
    authenticationMethod: 'local', roles: ['doctor'], permissions: ['ehr.prescription.write'],
    facilityIds: [facilityId], facilities: [], facility: { id: facilityId, membershipId, organizationId: facilityId,
      name: 'Test', roles: ['doctor'], permissions: ['ehr.prescription.write'], isPrimary: true } } } as DataAccessContext;

const prescription = (status: OrderStatus, rowVersion = '1'): PrescriptionRow => ({
  id: prescriptionId, encounterId, patientId, facilityId, createdBy: accountId, createdByMembershipId: membershipId,
  medicationCodeSystem: null, medicationCode: null, medicationDisplay: 'Amoxicillin 500 mg', doseQuantity: '1',
  doseUnit: 'tablet', routeCode: 'oral', frequency: 'Three times daily', instructions: 'Take with food',
  startsOn: '2026-11-18', endsOn: '2026-11-25', status, rowVersion, createdAt: new Date('2026-11-18T10:00:00Z'),
  updatedAt: new Date('2026-11-18T10:00:00Z'),
});

const noRoutes = { summaries: async () => new Map(), summary: async () => null,
  crossFacilityOrdersEnabled: async () => false };
const routed = { ...noRoutes, summary: async () => ({ id: 'route', state: 'accepted', effectiveState: 'accepted' }) };

const SEND = /from ehr\.send_prescription_to_own_pharmacy\(\$1::uuid, \$2::bigint\)/;
const WITHDRAW = /ehr\.withdraw_own_pharmacy_send\(\$1::uuid\)/;

interface Options {
  current: PrescriptionRow;
  updated?: PrescriptionRow;
  outcome?: string;
  sendError?: Error & { code?: string };
  withdrawn?: boolean;
  ownPharmacy?: OwnPharmacySend;
  routes?: typeof noRoutes;
}

const harness = (options: Options) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const audits: Record<string, unknown>[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (/from ehr\.record_versions/.test(sql)) return { rows: [{ createdSeen: 1, reached: 0 }] };
    if (/ehr\.context_allows\(/.test(sql)) return { rows: [{ allowed: true }] };
    if (/^\s*update ehr\.prescriptions/.test(sql)) return { rows: options.updated ? [options.updated] : [] };
    if (/^\s*insert into ehr\.prescriptions/.test(sql)) return { rows: [options.current] };
    if (/from ehr\.prescriptions/.test(sql)) return { rows: [options.current] };
    if (/from ehr\.encounters/.test(sql)) return { rows: [{ status: 'in_progress' }] };
    if (SEND.test(sql)) {
      if (options.sendError) throw options.sendError;
      return { rows: [{ outcome: options.outcome ?? 'sent' }] };
    }
    if (WITHDRAW.test(sql)) return { rows: [{ withdrawn: options.withdrawn ?? true }] };
    return { rows: [] };
  }) } as unknown as PoolClient;
  const repository = {
    run: jest.fn(async (_context: unknown, _patient: unknown, _access: unknown, event: { action: string;
      details?: Record<string, unknown> }, operation: (c: PoolClient) => Promise<{ value: unknown;
      details?: Record<string, unknown> }>) => {
      const result = await operation(client);
      audits.push({ action: event.action, details: { ...event.details, ...result.details } });
      return result.value;
    }),
    setChangeReason: jest.fn(async () => undefined),
    exists: jest.fn(async () => true),
  };
  const service = new PrescriptionsService(repository as never, { acceptEhrPrescription: jest.fn() } as never,
    (options.routes ?? noRoutes) as never, undefined, options.ownPharmacy ?? new OwnPharmacySend(true));
  const sql = () => statements.map((statement) => statement.sql);
  return { service, statements, sql, audits };
};

describe('pharmacyHandoff', () => {
  it.each([
    ['sent', 'sent', undefined], ['already_in_pharmacy', 'sent', undefined], ['pending', 'pending', undefined],
    ['no_pharmacy', 'not_sent', 'no_pharmacy'], ['routed', 'not_sent', 'routed'],
    ['not_prescriber', 'not_sent', 'not_prescriber'], ['not_active', 'not_sent', 'changed'],
    ['changed', 'not_sent', 'changed'], ['not_found', 'not_sent', 'changed'], ['anything else', 'not_sent', 'unavailable'],
  ])('maps %s to %s (%s), in plain words', (outcome, status, reason) => {
    const handoff = pharmacyHandoff(outcome);
    expect(handoff.status).toBe(status);
    expect(handoff.reason).toBe(reason);
    expect(handoff.message).toMatch(/^[A-Z][^]*\.$/);
    expect(handoff.message.toLowerCase()).not.toContain('unverified');
  });
});

describe('activated prescriptions go to this hospital\'s own pharmacy (0133)', () => {
  beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
  afterEach(() => jest.restoreAllMocks());

  it('sends a first activation at the new version, in a savepoint, and answers and audits the hand-off', async () => {
    const { service, statements, sql, audits } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2') });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never) as Record<string, unknown>;
    expect(answer.pharmacyHandoff).toEqual({ status: 'sent', message: 'Sent to this hospital\'s pharmacy.' });
    expect(statements.find((statement) => SEND.test(statement.sql))?.values).toEqual([prescriptionId, 2]);
    expect(sql().filter((statement) => /savepoint ehr_own_pharmacy_send/.test(statement))).toEqual([
      'savepoint ehr_own_pharmacy_send', 'release savepoint ehr_own_pharmacy_send']);
    expect(audits).toEqual([{ action: 'ehr.prescription.update', details: { rowVersion: '2',
      fixedReason: 'first_activation', pharmacyHandoff: 'sent' } }]);
  });

  it('answers pending, and keeps the activation, when the send fails', async () => {
    const { service, audits } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2'), outcome: 'pending' });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never) as Record<string, unknown>;
    expect(answer.status).toBe(OrderStatus.Active);
    expect((answer.pharmacyHandoff as { status: string }).status).toBe('pending');
    expect(audits[0]!.details).toMatchObject({ pharmacyHandoff: 'pending' });
  });

  it('answers not_sent with its reason when nobody here works on pharmacy items', async () => {
    const { service, audits } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2'), outcome: 'no_pharmacy' });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never) as Record<string, unknown>;
    expect(answer.pharmacyHandoff).toMatchObject({ status: 'not_sent', reason: 'no_pharmacy' });
    expect(audits[0]!.details).toMatchObject({ pharmacyHandoff: 'not_sent', pharmacyHandoffReason: 'no_pharmacy' });
  });

  it('answers no hand-off on a schema without 0133, after rolling back its savepoint', async () => {
    const missing = Object.assign(new Error('function does not exist'), { code: '42883' });
    const { service, sql } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2'), sendError: missing });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never) as Record<string, unknown>;
    expect('pharmacyHandoff' in answer).toBe(false);
    expect(sql()).toContain('rollback to savepoint ehr_own_pharmacy_send');
  });

  it('answers "could not be reached" for any other refusal, and keeps the activation', async () => {
    const denied = Object.assign(new Error('OWN_PHARMACY_SEND_DENIED'), { code: '42501' });
    const { service } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2'), sendError: denied });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never) as Record<string, unknown>;
    expect(answer.pharmacyHandoff).toMatchObject({ status: 'not_sent', reason: 'unavailable' });
  });

  it('passes a serialization failure on, so the whole transaction is retried', async () => {
    const conflict = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const { service } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2'), sendError: conflict });
    await expect(service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never)).rejects.toBe(conflict);
  });

  it('does not send a resume after a hold (the pharmacy already has it)', async () => {
    const { service, sql } = harness({ current: prescription(OrderStatus.OnHold, '3'),
      updated: prescription(OrderStatus.Active, '4') });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 3, changeReason: 'Resumed after review' } as never) as
      Record<string, unknown>;
    expect('pharmacyHandoff' in answer).toBe(false);
    expect(sql().some((statement) => SEND.test(statement))).toBe(false);
  });

  it('marks the send withdrawn when the prescription is held, and records it', async () => {
    const { service, statements, audits } = harness({ current: prescription(OrderStatus.Active, '2'),
      updated: prescription(OrderStatus.OnHold, '3') });
    await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.OnHold, expectedRowVersion: 2, changeReason: 'Held for review' } as never);
    expect(statements.find((statement) => WITHDRAW.test(statement.sql))?.values).toEqual([prescriptionId]);
    expect(audits[0]!.details).toMatchObject({ pharmacySendWithdrawn: true });
  });

  it('sends a prescription written as active', async () => {
    const { service, statements } = harness({ current: prescription(OrderStatus.Active) });
    const repository = (service as unknown as { repository: { executeCreate: jest.Mock } }).repository;
    repository.executeCreate = jest.fn(async (_client, _context, _patient, _key, _operation, _digest, _type,
      create: () => Promise<{ value: unknown; details?: Record<string, unknown> }>) => {
      const created = await create();
      return { value: created.value, details: created.details };
    });
    const created = await service.create(context, patientId, encounterId, { medicationDisplay: 'Amoxicillin 500 mg',
      frequency: 'Three times daily', instructions: 'Take with food', status: OrderStatus.Active } as never,
    'own-pharmacy-create-key') as Record<string, unknown>;
    expect((created.pharmacyHandoff as { status: string }).status).toBe('sent');
    expect(statements.find((statement) => SEND.test(statement.sql))?.values).toEqual([prescriptionId, 1]);
  });

  it('off (every direct caller\'s default), sends nothing', async () => {
    const { service, sql } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2'), ownPharmacy: OWN_PHARMACY_SEND_OFF });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never) as Record<string, unknown>;
    expect('pharmacyHandoff' in answer).toBe(false);
    expect(sql().some((statement) => /savepoint/.test(statement))).toBe(false);
  });
});

describe('Send to pharmacy (0133)', () => {
  it('sends the prescriber\'s active prescription and answers the hand-off', async () => {
    const { service, statements, audits } = harness({ current: prescription(OrderStatus.Active, '2') });
    await expect(service.sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
      .resolves.toEqual({ pharmacyHandoff: { status: 'sent', message: 'Sent to this hospital\'s pharmacy.' } });
    expect(statements.find((statement) => SEND.test(statement.sql))?.values).toEqual([prescriptionId, 2]);
    expect(audits).toEqual([{ action: 'ehr.prescription.own-pharmacy-send', details: {
      expectedPrescriptionVersion: 2, prescriptionVersion: 2, pharmacyHandoff: 'sent' } }]);
  });

  it('refuses a stale version (412), an inactive prescription (409) and a routed one (409)', async () => {
    await expect(harness({ current: prescription(OrderStatus.Active, '3') }).service.sendToOwnPharmacy(context,
      patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
      .rejects.toMatchObject({ status: 412, code: 'PRESCRIPTION_VERSION_CONFLICT' });
    await expect(harness({ current: prescription(OrderStatus.OnHold, '2') }).service.sendToOwnPharmacy(context,
      patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
      .rejects.toMatchObject({ status: 409, code: 'PRESCRIPTION_NOT_ELIGIBLE' });
    await expect(harness({ current: prescription(OrderStatus.Active, '2'), routes: routed as never }).service
      .sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
      .rejects.toMatchObject({ status: 409, code: 'PRESCRIPTION_ROUTED' });
  });

  it('is 503 on a schema without 0133', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const missing = Object.assign(new Error('function does not exist'), { code: '42883' });
    await expect(harness({ current: prescription(OrderStatus.Active, '2'), sendError: missing }).service
      .sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
      .rejects.toMatchObject({ status: 503, code: 'OWN_PHARMACY_SEND_UNAVAILABLE' });
    jest.restoreAllMocks();
  });

  it('is provided on by the prescriptions module and injected into the service', () => {
    const provider = (Reflect.getMetadata('providers', PrescriptionsModule) as unknown[]).find((entry) =>
      typeof entry === 'object' && entry !== null && (entry as { provide?: unknown }).provide === OwnPharmacySend) as
      { useFactory: () => OwnPharmacySend };
    expect(provider.useFactory().enabled).toBe(true);
    expect(OWN_PHARMACY_SEND_OFF.enabled).toBe(false);
    expect((Reflect.getMetadata('design:paramtypes', PrescriptionsService) as unknown[])[4]).toBe(OwnPharmacySend);
  });
});
