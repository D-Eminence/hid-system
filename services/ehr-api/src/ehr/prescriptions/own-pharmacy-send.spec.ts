import { Logger, RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { PoolClient } from 'pg';
import { REQUIRED_PERMISSIONS } from '../../common/decorators';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import { matchAllergies } from '../allergies/allergy-match';
import { warningToken } from '../allergies/allergy-reader';
import { OrderStatus } from '../shared/clinical.dto';
import { ClinicalRepository } from '../shared/clinical.repository';
import { OWN_PHARMACY_SEND_OFF, OwnPharmacySend, type OwnPharmacyOutcome, pharmacyHandoff } from './own-pharmacy-send';
import { PrescriptionsController } from './prescriptions.controller';
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
  withdrawError?: Error & { code?: string };
  ownPharmacy?: OwnPharmacySend;
  routes?: typeof noRoutes;
  /** The patient's recorded allergies, the acknowledgements stored for the prescription, and read access. */
  recorded?: unknown[];
  stored?: unknown[];
  readAllowed?: boolean;
}

const harness = (options: Options) => {
  const statements: { sql: string; values: unknown[] }[] = [];
  const audits: Record<string, unknown>[] = [];
  const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
    statements.push({ sql, values });
    if (/from ehr\.record_versions/.test(sql)) return { rows: [{ createdSeen: 1, reached: 0 }] };
    if (/ehr\.context_allows\(/.test(sql)) return { rows: [{ allowed: options.readAllowed ?? true }] };
    if (/from ehr\.recorded_allergies/.test(sql)) return { rows: options.recorded ?? [] };
    if (/from ehr\.prescription_allergy_acknowledgements/.test(sql)) return { rows: options.stored ?? [] };
    if (/^\s*update ehr\.prescriptions/.test(sql)) return { rows: options.updated ? [options.updated] : [] };
    if (/^\s*insert into ehr\.prescriptions/.test(sql)) return { rows: [options.current] };
    if (/from ehr\.prescriptions/.test(sql)) return { rows: [options.current] };
    if (/from ehr\.encounters/.test(sql)) return { rows: [{ status: 'in_progress' }] };
    if (SEND.test(sql)) {
      if (options.sendError) throw options.sendError;
      return { rows: [{ outcome: options.outcome ?? 'sent' }] };
    }
    if (WITHDRAW.test(sql)) {
      if (options.withdrawError) throw options.withdrawError;
      return { rows: [{ withdrawn: options.withdrawn ?? true }] };
    }
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
  const sends = () => statements.filter((statement) => SEND.test(statement.sql)).map((statement) => statement.values);
  const withdrawals = () => statements.filter((statement) => WITHDRAW.test(statement.sql)).map((statement) => statement.values);
  /** executeCreate as ClinicalRepository runs it: the first run creates; a replay loads the stored result. */
  const createAs = (replay: boolean) => {
    (repository as unknown as { executeCreate: jest.Mock }).executeCreate = jest.fn(async (_client, _context, _patient,
      _key, _operation, _digest, _type, create: () => Promise<{ value: unknown; id: string;
        details?: Record<string, unknown> }>, load: (id: string) => Promise<unknown>) => {
      if (replay) return { value: await load(prescriptionId), resourceId: prescriptionId, details: { idempotentReplay: true } };
      const created = await create();
      return { value: created.value, resourceId: created.id, details: { ...created.details, idempotentReplay: false } };
    });
  };
  return { service, statements, sql, audits, sends, withdrawals, createAs };
};

/** The contract's pharmacyHandoff table (docs/INTERFACE_CONTRACT.md, ORD-2), row by row. */
const CONTRACT_TABLE = [
  { status: 'sent', message: 'Sent to this hospital\'s pharmacy.' },
  { status: 'sent', message: 'This hospital\'s pharmacy already has this prescription.' },
  { status: 'pending', message: 'Not sent to the pharmacy yet. Use Send to pharmacy to try again.' },
  { status: 'not_sent', reason: 'no_pharmacy', message: 'Not sent: nobody at this facility works on pharmacy orders on Health ID.' },
  { status: 'not_sent', reason: 'routed', message: 'Not sent: this prescription has been sent to another pharmacy.' },
  { status: 'not_sent', reason: 'not_prescriber',
    message: 'Not sent: only the person who wrote this prescription can send it to the pharmacy.' },
  { status: 'not_sent', reason: 'changed', message: 'Not sent: this prescription changed. Reload it and try again.' },
  { status: 'not_sent', reason: 'superseded', message: 'Not sent: this hospital\'s pharmacy has an earlier version of this '
    + 'prescription, which it can no longer dispense.' },
  { status: 'not_sent', reason: 'not_allowed',
    message: 'Not sent: your role at this facility does not allow sending prescriptions to the pharmacy.' },
  { status: 'not_sent', reason: 'unavailable',
    message: 'Not sent: the pharmacy could not be reached. Use Send to pharmacy to try again.' },
];

describe('pharmacyHandoff', () => {
  it.each([
    ['sent', 'sent', undefined], ['already_in_pharmacy', 'sent', undefined], ['pending', 'pending', undefined],
    ['no_pharmacy', 'not_sent', 'no_pharmacy'], ['routed', 'not_sent', 'routed'],
    ['not_prescriber', 'not_sent', 'not_prescriber'], ['not_active', 'not_sent', 'changed'],
    ['changed', 'not_sent', 'changed'], ['not_found', 'not_sent', 'changed'], ['superseded', 'not_sent', 'superseded'],
    ['anything else', 'not_sent', 'unavailable'],
  ])('maps %s to %s (%s), in plain words', (outcome, status, reason) => {
    const handoff = pharmacyHandoff(outcome);
    expect(handoff.status).toBe(status);
    expect(handoff.reason).toBe(reason);
    expect(handoff.message).toMatch(/^[A-Z][^]*\.$/);
    expect(handoff.message.toLowerCase()).not.toContain('unverified');
  });

  it('answers a missing or no longer active prescription with the contract\'s "changed" row', () => {
    expect(pharmacyHandoff('not_active')).toEqual(CONTRACT_TABLE[6]);
    expect(pharmacyHandoff('not_found')).toEqual(CONTRACT_TABLE[6]);
    expect(pharmacyHandoff('changed')).toEqual(CONTRACT_TABLE[6]);
  });

  it('answers only rows of the contract\'s table, and every one of them', async () => {
    const outcomes: OwnPharmacyOutcome[] = ['not_found', 'not_prescriber', 'not_active', 'changed', 'routed',
      'already_in_pharmacy', 'superseded', 'no_pharmacy', 'sent', 'pending'];
    const answers = outcomes.map((outcome) => pharmacyHandoff(outcome));
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    for (const error of [Object.assign(new Error('OWN_PHARMACY_SEND_DENIED'), { code: '42501' }),
      Object.assign(new Error('connection reset'), { code: '08006' })]) {
      const { service } = harness({ current: prescription(OrderStatus.Active, '2'), sendError: error });
      answers.push((await service.sendToOwnPharmacy(context, patientId, encounterId, prescriptionId,
        { expectedRowVersion: 2 })).pharmacyHandoff);
    }
    jest.restoreAllMocks();
    const key = (row: object) => JSON.stringify(row, Object.keys(row).sort());
    expect(new Set(answers.map(key))).toEqual(new Set(CONTRACT_TABLE.map(key)));
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

  it('answers not_allowed (no retry) when the database refuses the session, and keeps the activation', async () => {
    const denied = Object.assign(new Error('OWN_PHARMACY_SEND_DENIED'), { code: '42501' });
    const { service, sql, audits } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2'), sendError: denied });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never) as Record<string, unknown>;
    expect(answer.status).toBe(OrderStatus.Active);
    expect(answer.pharmacyHandoff).toEqual({ status: 'not_sent', reason: 'not_allowed',
      message: 'Not sent: your role at this facility does not allow sending prescriptions to the pharmacy.' });
    expect(sql()).toContain('rollback to savepoint ehr_own_pharmacy_send');
    expect(audits[0]!.details).toMatchObject({ pharmacyHandoff: 'not_sent', pharmacyHandoffReason: 'not_allowed' });
  });

  it.each([
    ['another 42501 (a missing grant)', '42501', 'permission denied for function send_prescription_to_own_pharmacy'],
    ['a check violation', '23514', 'OWN_PHARMACY_SEND_INVALID'],
    ['a lost connection', '08006', 'connection reset'],
  ])('answers "could not be reached" for %s, and keeps the activation', async (_name, code, message) => {
    const { service } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2'), sendError: Object.assign(new Error(message), { code }) });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never) as Record<string, unknown>;
    expect(answer.status).toBe(OrderStatus.Active);
    expect(answer.pharmacyHandoff).toMatchObject({ status: 'not_sent', reason: 'unavailable' });
  });

  it('answers the superseded row when the pharmacy holds an earlier version', async () => {
    const { service } = harness({ current: prescription(OrderStatus.Active, '3'), outcome: 'superseded' });
    await expect(service.sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 3 }))
      .resolves.toEqual({ pharmacyHandoff: CONTRACT_TABLE[7] });
  });

  it('passes a serialization failure on, so the whole transaction is retried', async () => {
    const conflict = Object.assign(new Error('could not serialize access'), { code: '40001' });
    const { service } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2'), sendError: conflict });
    await expect(service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never)).rejects.toBe(conflict);
  });

  it('does not send a resume after a hold, and tells the prescriber the pharmacy holds an earlier version',
    async () => {
      const { service, sends, withdrawals, audits } = harness({ current: prescription(OrderStatus.OnHold, '3'),
        updated: prescription(OrderStatus.Active, '4') });
      const answer = await service.update(context, patientId, encounterId, prescriptionId,
        { status: OrderStatus.Active, expectedRowVersion: 3, changeReason: 'Resumed after review' } as never) as
        Record<string, unknown>;
      expect(answer.pharmacyHandoff).toEqual({ status: 'not_sent', reason: 'superseded',
        message: 'Not sent: this hospital\'s pharmacy has an earlier version of this prescription, which it can no longer dispense.' });
      expect(sends()).toEqual([]);
      expect(withdrawals()).toEqual([[prescriptionId]]);
      expect(audits[0]!.details).toMatchObject({ pharmacySendWithdrawn: true, pharmacyHandoff: 'not_sent',
        pharmacyHandoffReason: 'superseded' });
    });

  it('answers no hand-off on a resume of a prescription that was never sent', async () => {
    const { service, audits } = harness({ current: prescription(OrderStatus.OnHold, '3'),
      updated: prescription(OrderStatus.Active, '4'), withdrawn: false });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 3, changeReason: 'Resumed after review' } as never) as
      Record<string, unknown>;
    expect('pharmacyHandoff' in answer).toBe(false);
    expect(audits[0]!.details).not.toHaveProperty('pharmacySendWithdrawn');
  });

  it('tells the prescriber when a sent prescription is edited while active (the pharmacy holds the version sent)',
    async () => {
      const { service, sends, withdrawals, audits } = harness({ current: prescription(OrderStatus.Active, '2'),
        updated: { ...prescription(OrderStatus.Active, '3'), frequency: 'Twice daily' } });
      const answer = await service.update(context, patientId, encounterId, prescriptionId,
        { frequency: 'Twice daily', expectedRowVersion: 2, changeReason: 'Dose interval changed' } as never) as
        Record<string, unknown>;
      expect(answer.pharmacyHandoff).toEqual({ status: 'not_sent', reason: 'superseded',
        message: 'Not sent: this hospital\'s pharmacy has an earlier version of this prescription, which it can no longer dispense.' });
      expect(sends()).toEqual([]);
      expect(withdrawals()).toEqual([[prescriptionId]]);
      expect(audits[0]!.details).toMatchObject({ rowVersion: '3', pharmacySendWithdrawn: true,
        pharmacyHandoff: 'not_sent', pharmacyHandoffReason: 'superseded' });
    });

  it('answers no hand-off when the edited prescription\'s item was already dispensed (the database answers false)',
    async () => {
      const { service, withdrawals, audits } = harness({ current: prescription(OrderStatus.Active, '2'),
        updated: { ...prescription(OrderStatus.Active, '3'), endsOn: '2026-12-02' }, withdrawn: false });
      const answer = await service.update(context, patientId, encounterId, prescriptionId,
        { endsOn: '2026-12-02', expectedRowVersion: 2, changeReason: 'Course extended after dispensing' } as never) as
        Record<string, unknown>;
      expect(withdrawals()).toEqual([[prescriptionId]]);
      expect('pharmacyHandoff' in answer).toBe(false);
      expect(audits[0]!.details).not.toHaveProperty('pharmacySendWithdrawn');
      expect(audits[0]!.details).not.toHaveProperty('pharmacyHandoff');
    });

  it('answers no hand-off when a sent prescription is held or cancelled (it is no longer active)', async () => {
    for (const status of [OrderStatus.OnHold, OrderStatus.Cancelled]) {
      const { service, audits } = harness({ current: prescription(OrderStatus.Active, '2'),
        updated: prescription(status, '3') });
      const answer = await service.update(context, patientId, encounterId, prescriptionId,
        { status, expectedRowVersion: 2, changeReason: 'Stopped by the prescriber' } as never) as Record<string, unknown>;
      expect('pharmacyHandoff' in answer).toBe(false);
      expect(audits[0]!.details).toMatchObject({ pharmacySendWithdrawn: true });
      expect(audits[0]!.details).not.toHaveProperty('pharmacyHandoff');
    }
  });

  it('asks the database about a completed prescription, which marks nothing', async () => {
    const { service, withdrawals, audits } = harness({ current: prescription(OrderStatus.Active, '2'),
      updated: prescription(OrderStatus.Completed, '3'), withdrawn: false });
    await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Completed, expectedRowVersion: 2, changeReason: 'Course completed' } as never);
    expect(withdrawals()).toEqual([[prescriptionId]]);
    expect(audits[0]!.details).not.toHaveProperty('pharmacySendWithdrawn');
  });

  it('never asks about a draft (it was never sent): an edit, a cancellation', async () => {
    for (const input of [{ frequency: 'Twice daily', expectedRowVersion: 1, changeReason: 'Before activation' },
      { status: OrderStatus.Cancelled, expectedRowVersion: 1, changeReason: 'Not needed' }]) {
      const { service, sends, withdrawals } = harness({ current: prescription(OrderStatus.Draft),
        updated: prescription(input.status ?? OrderStatus.Draft, '2') });
      await service.update(context, patientId, encounterId, prescriptionId, input as never);
      expect(sends()).toEqual([]);
      expect(withdrawals()).toEqual([]);
    }
  });

  it('never withdraws on the activation itself', async () => {
    const { service, withdrawals } = harness({ current: prescription(OrderStatus.Draft),
      updated: prescription(OrderStatus.Active, '2') });
    await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 } as never);
    expect(withdrawals()).toEqual([]);
  });

  it('answers no withdrawal on a schema without 0133, after rolling back its savepoint', async () => {
    const { service, sql, audits } = harness({ current: prescription(OrderStatus.Active, '2'),
      updated: prescription(OrderStatus.OnHold, '3'),
      withdrawError: Object.assign(new Error('function does not exist'), { code: '42883' }) });
    const answer = await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.OnHold, expectedRowVersion: 2, changeReason: 'Held for review' } as never) as
      Record<string, unknown>;
    expect(answer.status).toBe(OrderStatus.OnHold);
    expect(sql()).toContain('rollback to savepoint ehr_own_pharmacy_withdraw');
    expect(audits[0]!.details).not.toHaveProperty('pharmacySendWithdrawn');
  });

  it('marks the send withdrawn when the prescription is held, and records it', async () => {
    const { service, statements, audits } = harness({ current: prescription(OrderStatus.Active, '2'),
      updated: prescription(OrderStatus.OnHold, '3') });
    await service.update(context, patientId, encounterId, prescriptionId,
      { status: OrderStatus.OnHold, expectedRowVersion: 2, changeReason: 'Held for review' } as never);
    expect(statements.find((statement) => WITHDRAW.test(statement.sql))?.values).toEqual([prescriptionId]);
    expect(audits[0]!.details).toMatchObject({ pharmacySendWithdrawn: true });
  });

  const newPrescription = (status: OrderStatus) => ({ medicationDisplay: 'Amoxicillin 500 mg',
    frequency: 'Three times daily', instructions: 'Take with food', status }) as never;

  it('sends a prescription written as active, and audits the hand-off', async () => {
    const { service, sends, audits, createAs } = harness({ current: prescription(OrderStatus.Active) });
    createAs(false);
    const created = await service.create(context, patientId, encounterId, newPrescription(OrderStatus.Active),
      'own-pharmacy-create-key') as Record<string, unknown>;
    expect(created.pharmacyHandoff).toEqual(CONTRACT_TABLE[0]);
    expect(sends()).toEqual([[prescriptionId, 1]]);
    expect(audits).toEqual([{ action: 'ehr.prescription.create', details: { pharmacyHandoff: 'sent',
      idempotentReplay: false } }]);
  });

  it('sends nothing for a draft written as a draft', async () => {
    const { service, sends, createAs } = harness({ current: prescription(OrderStatus.Draft) });
    createAs(false);
    const created = await service.create(context, patientId, encounterId, newPrescription(OrderStatus.Draft),
      'own-pharmacy-create-key') as Record<string, unknown>;
    expect('pharmacyHandoff' in created).toBe(false);
    expect(sends()).toEqual([]);
  });

  it('answers a replayed active create with the hand-off as it stands now (sending once), and audits it', async () => {
    const { service, sends, audits, createAs } = harness({ current: prescription(OrderStatus.Active, '2'),
      outcome: 'already_in_pharmacy' });
    createAs(true);
    const replayed = await service.create(context, patientId, encounterId, newPrescription(OrderStatus.Active),
      'own-pharmacy-create-key') as Record<string, unknown>;
    expect(replayed.pharmacyHandoff).toEqual(CONTRACT_TABLE[1]);
    expect(sends()).toEqual([[prescriptionId, 2]]);
    expect(audits).toEqual([{ action: 'ehr.prescription.create', details: { idempotentReplay: true,
      pharmacyHandoff: 'sent' } }]);
  });

  it('tries a pending send again on a replay', async () => {
    const { service, createAs } = harness({ current: prescription(OrderStatus.Active), outcome: 'sent' });
    createAs(true);
    const replayed = await service.create(context, patientId, encounterId, newPrescription(OrderStatus.Active),
      'own-pharmacy-create-key') as Record<string, unknown>;
    expect(replayed.pharmacyHandoff).toEqual(CONTRACT_TABLE[0]);
  });

  it('answers a replayed draft create, and a replay on a schema without 0133, without a hand-off', async () => {
    const draft = harness({ current: prescription(OrderStatus.Active, '2') });
    draft.createAs(true);
    const replayedDraft = await draft.service.create(context, patientId, encounterId, newPrescription(OrderStatus.Draft),
      'own-pharmacy-create-key') as Record<string, unknown>;
    expect('pharmacyHandoff' in replayedDraft).toBe(false);
    expect(draft.sends()).toEqual([]);
    const missing = harness({ current: prescription(OrderStatus.Active, '2'),
      sendError: Object.assign(new Error('function does not exist'), { code: '42883' }) });
    missing.createAs(true);
    const replayedOld = await missing.service.create(context, patientId, encounterId, newPrescription(OrderStatus.Active),
      'own-pharmacy-create-key') as Record<string, unknown>;
    expect('pharmacyHandoff' in replayedOld).toBe(false);
    expect(missing.audits[0]!.details).toEqual({ idempotentReplay: true });
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

  describe('the allergy check before the send (0117, as the pharmacy hand-off)', () => {
    const allergyId = '123e4567-e89b-42d3-a456-426614174010';
    const penicillin = { id: allergyId, substance: 'Penicillin', reaction: 'Anaphylaxis', severity: 'severe' };
    const medicine = { display: 'Amoxicillin 500 mg', code: null };
    const token = warningToken(matchAllergies(medicine, [{ source: 'recorded', ...penicillin }]), medicine);
    const acknowledgement = { reason: 'Tolerated amoxicillin in 2024; observe 30 minutes', warningToken: token };
    const inserts = (statements: { sql: string; values: unknown[] }[]) =>
      statements.filter((statement) => /insert into/.test(statement.sql));

    it('refuses 409 ALLERGY_ACKNOWLEDGEMENT_REQUIRED before the send, writing and auditing nothing', async () => {
      const { service, statements, sends, audits } = harness({ current: prescription(OrderStatus.Active, '2'),
        recorded: [penicillin] });
      await expect(service.sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
        .rejects.toMatchObject({ status: 409, code: 'ALLERGY_ACKNOWLEDGEMENT_REQUIRED',
          errors: expect.arrayContaining([{ field: 'allergyAcknowledgement.warningToken', messages: [token] }]) });
      expect(sends()).toEqual([]);
      expect(inserts(statements)).toEqual([]);
      expect(audits).toEqual([]);
    });

    it('with the reason for the warning shown, stores it for the handoff stage, then sends', async () => {
      const { service, statements, sends, audits } = harness({ current: prescription(OrderStatus.Active, '2'),
        recorded: [penicillin] });
      await expect(service.sendToOwnPharmacy(context, patientId, encounterId, prescriptionId,
        { expectedRowVersion: 2, allergyAcknowledgement: acknowledgement }))
        .resolves.toEqual({ pharmacyHandoff: CONTRACT_TABLE[0] });
      expect(inserts(statements).map((statement) => statement.values)).toEqual([[prescriptionId, patientId, facilityId,
        accountId, membershipId, 'Tolerated amoxicillin in 2024; observe 30 minutes', [allergyId], false, 'handoff', []]]);
      const order = statements.map((statement) => statement.sql);
      expect(order.findIndex((sql) => /insert into ehr\.prescription_allergy_acknowledgements/.test(sql)))
        .toBeLessThan(order.findIndex((sql) => SEND.test(sql)));
      expect(sends()).toEqual([[prescriptionId, 2]]);
      expect(audits).toEqual([{ action: 'ehr.prescription.own-pharmacy-send', details: { expectedPrescriptionVersion: 2,
        prescriptionVersion: 2, allergyOverride: true, matchedRecordedCount: 1, patientReportedMatched: false,
        pharmacyHandoff: 'sent' } }]);
      expect(JSON.stringify(audits)).not.toMatch(/penicillin|amoxicillin|observe/i);
    });

    it('needs no new reason when one stored for this prescription covers the match', async () => {
      const { service, statements, sends } = harness({ current: prescription(OrderStatus.Active, '2'),
        recorded: [penicillin], stored: [{ matchedRecordedAllergyIds: [allergyId], patientReportedTerms: [] }] });
      await service.sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 2 });
      expect(inserts(statements)).toEqual([]);
      expect(sends()).toEqual([[prescriptionId, 2]]);
    });

    it('refuses 403 CONSENT_REQUIRED when the patient\'s records cannot be read here, before the send', async () => {
      const { service, sends, audits } = harness({ current: prescription(OrderStatus.Active, '2'), readAllowed: false });
      await expect(service.sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
        .rejects.toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
      expect(sends()).toEqual([]);
      expect(audits).toEqual([]);
    });
  });

  it('is 403 CONSENT_REQUIRED, with a denied audit row and no statement, when Identity refuses the write', async () => {
    const database = { withTransaction: jest.fn() };
    const audit = { record: jest.fn(async () => undefined) };
    const identity = { authorize: jest.fn(async () => ({ allowed: false, breakGlass: false })) };
    const repository = new ClinicalRepository(database as never, audit as never, identity as never);
    const service = new PrescriptionsService(repository, { acceptEhrPrescription: jest.fn() } as never, noRoutes as never,
      undefined, new OwnPharmacySend(true));
    await expect(service.sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
      .rejects.toMatchObject({ status: 403, code: 'CONSENT_REQUIRED' });
    expect(identity.authorize).toHaveBeenCalledWith(patientId, 'write_records', 'direct-care', context);
    expect(database.withTransaction).not.toHaveBeenCalled();
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'ehr.prescription.own-pharmacy-send',
      outcome: 'denied', resourceId: prescriptionId }));
  });

  it('is 404 for a prescription not at this encounter, patient and facility, and sends nothing', async () => {
    const { service, sends } = harness({ current: prescription(OrderStatus.Active, '2') });
    const repository = (service as unknown as { repository: { run: jest.Mock } }).repository;
    repository.run.mockRejectedValueOnce(Object.assign(new Error('Clinical resource was not found'),
      { status: 404, code: 'CLINICAL_RESOURCE_NOT_FOUND' }));
    await expect(service.sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
      .rejects.toMatchObject({ status: 404 });
    expect(sends()).toEqual([]);
  });

  it('is 503 on a schema without 0133', async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const missing = Object.assign(new Error('function does not exist'), { code: '42883' });
    await expect(harness({ current: prescription(OrderStatus.Active, '2'), sendError: missing }).service
      .sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
      .rejects.toMatchObject({ status: 503, code: 'OWN_PHARMACY_SEND_UNAVAILABLE' });
    jest.restoreAllMocks();
  });

  it('answers not_sent with its reason, and audits the reason code, never the message', async () => {
    const { service, audits } = harness({ current: prescription(OrderStatus.Active, '2'), outcome: 'no_pharmacy' });
    await expect(service.sendToOwnPharmacy(context, patientId, encounterId, prescriptionId, { expectedRowVersion: 2 }))
      .resolves.toEqual({ pharmacyHandoff: CONTRACT_TABLE[3] });
    expect(audits[0]!.details).toEqual({ expectedPrescriptionVersion: 2, prescriptionVersion: 2,
      pharmacyHandoff: 'not_sent', pharmacyHandoffReason: 'no_pharmacy' });
    expect(JSON.stringify(audits)).not.toContain('Health ID');
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

describe('the own-pharmacy-send route (0133)', () => {
  const handler = (name: string): ((...args: unknown[]) => unknown) => {
    const found = (PrescriptionsController.prototype as unknown as Record<string, unknown>)[name];
    if (typeof found !== 'function') throw new Error(`PrescriptionsController has no ${name} route`);
    return found as (...args: unknown[]) => unknown;
  };
  const request = (purpose = 'direct-care') => ({ actor: context.actor, facilityId, correlationId: 'correlation-own-pharmacy',
    method: 'POST', header: (name: string) => (name === 'x-purpose-of-use' ? purpose : undefined) }) as unknown as HidRequest;

  it('is POST :prescriptionId/own-pharmacy-send, answering 200, for those who may write prescriptions', () => {
    const route = handler('sendToOwnPharmacy');
    expect(Reflect.getMetadata(PATH_METADATA, PrescriptionsController)).toBe('ehr/patients/:patientId/encounters/:encounterId/prescriptions');
    expect(Reflect.getMetadata(PATH_METADATA, route)).toBe(':prescriptionId/own-pharmacy-send');
    expect(Reflect.getMetadata(METHOD_METADATA, route)).toBe(RequestMethod.POST);
    expect(Reflect.getMetadata(HTTP_CODE_METADATA, route)).toBe(200);
    expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, route)).toEqual(['ehr.prescription.write']);
  });

  it('takes expectedRowVersion and, after the allergy warning only, allergyAcknowledgement; no Idempotency-Key', async () => {
    const body = (Reflect.getMetadata('design:paramtypes', PrescriptionsController.prototype, 'sendToOwnPharmacy') as
      (new () => object)[]).at(-1)!;
    expect(body.name).toBe('SendPrescriptionToOwnPharmacyDto');
    const errors = async (input: unknown) => (await validate(plainToInstance(body, input), { whitelist: true,
      forbidNonWhitelisted: true })).map((error) => error.property);
    expect(await errors({ expectedRowVersion: 2 })).toEqual([]);
    expect(await errors({ expectedRowVersion: 2, allergyAcknowledgement: { warningToken: 'a'.repeat(64),
      reason: 'Tolerated it before; observe' } })).toEqual([]);
    expect(await errors({ expectedRowVersion: 0 })).toEqual(['expectedRowVersion']);
    expect(await errors({})).toEqual(['expectedRowVersion']);
    expect(await errors({ expectedRowVersion: 2, allergyAcknowledgement: null })).toEqual(['allergyAcknowledgement']);
    expect(await errors({ expectedRowVersion: 2, reason: 'not part of this command' })).toEqual(['reason']);
    expect(handler('sendToOwnPharmacy').length).toBe(5);
  });

  it('passes the direct-care context and the body to the service and answers its hand-off', async () => {
    const prescriptions = { sendToOwnPharmacy: jest.fn(async () => ({ pharmacyHandoff: CONTRACT_TABLE[0] })) };
    const controller = new PrescriptionsController(prescriptions as never, {} as never, {} as never);
    await expect(handler('sendToOwnPharmacy').call(controller, request(), patientId, encounterId, prescriptionId,
      { expectedRowVersion: 2 })).resolves.toEqual({ pharmacyHandoff: CONTRACT_TABLE[0] });
    expect(prescriptions.sendToOwnPharmacy).toHaveBeenCalledWith(expect.objectContaining({ facilityId,
      purposeOfUse: 'direct-care' }), patientId, encounterId, prescriptionId, { expectedRowVersion: 2 });
    expect(() => handler('sendToOwnPharmacy').call(controller, request('emergency'), patientId, encounterId,
      prescriptionId, { expectedRowVersion: 2 })).toThrow(expect.objectContaining({ code: 'PURPOSE_OF_USE_REQUIRED' }));
  });

  it('answers a prescription created as active through the route with its hand-off (and the same-medicine check)',
    async () => {
      const { service, createAs, sends } = harness({ current: prescription(OrderStatus.Active) });
      createAs(false);
      const duplicates = { afterCreate: jest.fn(async (_context: unknown, _patient: unknown, created: object) =>
        ({ ...created, duplicateMedicines: { checked: true, matches: [], message: null } })) };
      const controller = new PrescriptionsController(service, {} as never, duplicates as never);
      const created = await handler('create').call(controller, request(), patientId, encounterId,
        'own-pharmacy-create-key', { medicationDisplay: 'Amoxicillin 500 mg', frequency: 'Three times daily',
          instructions: 'Take with food', status: OrderStatus.Active }) as Record<string, unknown>;
      expect(created).toMatchObject({ id: prescriptionId, status: OrderStatus.Active, pharmacyHandoff: CONTRACT_TABLE[0],
        duplicateMedicines: { checked: true } });
      expect(sends()).toEqual([[prescriptionId, 1]]);
    });

  it('answers an activation through the PATCH route with its hand-off', async () => {
    const { service } = harness({ current: prescription(OrderStatus.Draft), updated: prescription(OrderStatus.Active, '2') });
    const controller = new PrescriptionsController(service, {} as never, {} as never);
    const answer = await handler('update').call(controller, request(), patientId, encounterId, prescriptionId,
      { status: OrderStatus.Active, expectedRowVersion: 1 }) as Record<string, unknown>;
    expect(answer.pharmacyHandoff).toEqual(CONTRACT_TABLE[0]);
  });
});
