import { NotFoundException } from '@nestjs/common';
import type { HidRequest } from '../common/request-context';
import {
  ACCOUNT_DELETION_RECOVERY_HOLD_DETAIL, PatientAccountDeletionService, sha256Hex,
} from './patient-account-deletion.service';
import { fakeDatabase, patientRequest, patientSession, usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';

// Ported from main's patient-account-deletion.service.spec.ts (0064); this
// branch adds the recovery hold on the request (0093's evidence) and the
// ACCOUNT_DELETION_ENABLED switch (0096, D12).
describe('PatientAccountDeletionService', () => {
  usePatientSafetyTestEnvironment();
  const requestId = '90000000-0000-4000-8000-000000000001';
  const recent = { rows: [{ recent: true }] };
  const noHold = { rows: [{ held: false }] };
  const bind = { rows: [] };

  it('rejects unauthenticated and staff callers before any database work', async () => {
    const { query, database } = fakeDatabase();
    const service = new PatientAccountDeletionService(database);
    await expect(service.request({ correlationId: 'anonymous-correlation' } as HidRequest))
      .rejects.toMatchObject({ code: 'PATIENT_SESSION_REQUIRED' });
    await expect(service.status({ correlationId: 'staff-correlation',
      actor: { ...patientRequest.actor, kind: 'staff' } } as HidRequest))
      .rejects.toMatchObject({ code: 'PATIENT_SESSION_REQUIRED' });
    expect(query).not.toHaveBeenCalled();
  });

  it('reads the status bound to the patient session, and answers 403 without one', async () => {
    const { query, database } = fakeDatabase();
    const status = { waitingPeriodSeconds: 1209600, confirmationTtlSeconds: 600, request: null };
    query.mockResolvedValueOnce(bind).mockResolvedValueOnce({ rows: [{ status }] });
    const service = new PatientAccountDeletionService(database);
    await expect(service.status(patientRequest)).resolves.toEqual(status);
    expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('my_account_deletion_status'), [...patientSession]);
    query.mockResolvedValueOnce(bind).mockResolvedValueOnce({ rows: [{ status: null }] });
    await expect(service.status(patientRequest)).rejects.toMatchObject({ code: 'PATIENT_ACCESS_DENIED', status: 403 });
  });

  it('requires a fresh sign-in before issuing a deletion confirmation', async () => {
    const { query, database } = fakeDatabase();
    query.mockResolvedValueOnce(bind).mockResolvedValueOnce({ rows: [{ recent: false }] });
    await expect(new PatientAccountDeletionService(database).request(patientRequest))
      .rejects.toMatchObject({ code: 'PATIENT_RECENT_AUTH_REQUIRED', status: 403 });
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('request_my_account_deletion'), expect.anything());
  });

  it('refuses a request within 24 hours of an account recovery, in the contract\'s words', async () => {
    const { query, database } = fakeDatabase();
    query.mockResolvedValueOnce(bind).mockResolvedValueOnce(recent).mockResolvedValueOnce({ rows: [{ held: true }] });
    await expect(new PatientAccountDeletionService(database).request(patientRequest)).rejects.toMatchObject({
      code: 'PATIENT_RECENT_RECOVERY_HOLD', status: 403, message: ACCOUNT_DELETION_RECOVERY_HOLD_DETAIL });
    expect(query).toHaveBeenNthCalledWith(3, expect.stringContaining('auth.otp_challenges'),
      [patientRequest.actor!.accountId, 24]);
    expect(query).not.toHaveBeenCalledWith(expect.stringContaining('request_my_account_deletion'), expect.anything());
  });

  it('returns a single-use token once and stores only its SHA-256', async () => {
    const { query, database } = fakeDatabase();
    query.mockResolvedValueOnce(bind).mockResolvedValueOnce(recent).mockResolvedValueOnce(noHold).mockResolvedValueOnce({
      rows: [{ request_id: requestId, confirmation_expires_at: new Date('2026-10-08T10:10:00Z'), waiting_period_seconds: '1209600' }],
    });
    const result = await new PatientAccountDeletionService(database).request(patientRequest);
    expect(result).toMatchObject({ requestId, waitingPeriodSeconds: 1209600 });
    expect(result.confirmationToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query).toHaveBeenNthCalledWith(1, "select set_config('app.actor_subject', $1, true)", ['patient:safety']);
    const [, parameters] = query.mock.calls[3] as [string, unknown[]];
    expect(parameters).toEqual([...patientSession, sha256Hex(result.confirmationToken)]);
    expect(parameters).not.toContain(result.confirmationToken);
  });

  it.each([
    ['invalid', 'ACCOUNT_DELETION_CONFIRMATION_INVALID'],
    ['expired', 'ACCOUNT_DELETION_CONFIRMATION_EXPIRED'],
  ])('reports a committed %s confirmation as a non-disclosing denial', async (outcome, code) => {
    const { query, database } = fakeDatabase();
    query.mockResolvedValueOnce(bind).mockResolvedValueOnce(recent).mockResolvedValueOnce({
      rows: [{ outcome, request_id: requestId, request_state: null, scheduled_for: null, blocked_reason_code: null }],
    });
    await expect(new PatientAccountDeletionService(database).confirm(patientRequest, {
      requestId, confirmationToken: 'A'.repeat(43), confirmation: 'DELETE MY ACCOUNT',
    })).rejects.toMatchObject({ code, status: 403 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('confirm_my_account_deletion'),
      [...patientSession, requestId, sha256Hex('A'.repeat(43)), 'DELETE MY ACCOUNT']);
  });

  it.each([
    ['pending', new Date('2026-10-22T10:00:00Z'), null],
    ['blocked', null, 'LEGAL_HOLD'],
    ['completed', new Date('2026-10-08T10:00:00Z'), null],
  ])('returns the %s lifecycle state', async (outcome, scheduledFor, blockedReasonCode) => {
    const { query, database } = fakeDatabase();
    query.mockResolvedValueOnce(bind).mockResolvedValueOnce(recent).mockResolvedValueOnce({
      rows: [{ outcome, request_id: requestId, request_state: outcome, scheduled_for: scheduledFor,
        blocked_reason_code: blockedReasonCode }],
    });
    await expect(new PatientAccountDeletionService(database).confirm(patientRequest, {
      requestId, confirmationToken: 'B'.repeat(43), confirmation: 'DELETE MY ACCOUNT',
    })).resolves.toEqual({ requestId, state: outcome, scheduledFor, blockedReasonCode });
  });

  it('requires a fresh sign-in before confirming', async () => {
    const { query, database } = fakeDatabase();
    query.mockResolvedValueOnce(bind).mockResolvedValueOnce({ rows: [{ recent: false }] });
    await expect(new PatientAccountDeletionService(database).confirm(patientRequest, {
      requestId, confirmationToken: 'C'.repeat(43), confirmation: 'DELETE MY ACCOUNT',
    })).rejects.toMatchObject({ code: 'PATIENT_RECENT_AUTH_REQUIRED' });
  });

  it.each([
    [{ code: 'P0001', message: 'ACCOUNT_DELETION_RATE_LIMITED' }, 'ACCOUNT_DELETION_RATE_LIMITED', 429],
    [{ code: '55000', message: 'ACCOUNT_DELETION_ALREADY_PENDING' }, 'ACCOUNT_DELETION_ALREADY_PENDING', 409],
    [{ code: '42501', message: 'Patient self session is required' }, 'PATIENT_SESSION_REQUIRED', 403],
    [{ code: '22023', message: 'Invalid deletion confirmation verifier' }, 'INVALID_ACCOUNT_DELETION_COMMAND', 400],
    [{ code: '55000', message: 'ACCOUNT_DELETION_SETTINGS_UNAVAILABLE' }, 'ACCOUNT_DELETION_UNAVAILABLE', 503],
    [{ code: '08006', message: 'connection failure' }, 'ACCOUNT_DELETION_UNAVAILABLE', 503],
  ])('maps database refusal %o without leaking detail', async (failure, code, status) => {
    const { query, database } = fakeDatabase();
    query.mockResolvedValueOnce(bind).mockResolvedValueOnce(recent).mockResolvedValueOnce(noHold).mockRejectedValueOnce(failure);
    const refusal = new PatientAccountDeletionService(database).request(patientRequest);
    await expect(refusal).rejects.toMatchObject({ code, status });
    await expect(refusal).rejects.not.toMatchObject({ message: failure.message });
  });

  it('cancels idempotently and maps a closed or unknown request', async () => {
    const { query, database } = fakeDatabase();
    const service = new PatientAccountDeletionService(database);
    query.mockResolvedValueOnce(bind).mockResolvedValueOnce({ rows: [{ request_id: requestId, request_state: 'cancelled', replayed: true }] });
    await expect(service.cancel(patientRequest, { requestId })).resolves.toEqual({ requestId, state: 'cancelled', replayed: true });
    query.mockResolvedValueOnce(bind).mockRejectedValueOnce({ code: '55000', message: 'ACCOUNT_DELETION_NOT_CANCELLABLE' });
    await expect(service.cancel(patientRequest, { requestId })).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_NOT_CANCELLABLE', status: 409 });
    query.mockResolvedValueOnce(bind).mockRejectedValueOnce({ code: 'P0002', message: 'The deletion request is unavailable' });
    await expect(service.cancel(patientRequest, { requestId })).rejects.toMatchObject({ code: 'ACCOUNT_DELETION_NOT_FOUND', status: 404 });
  });

  it('finalizes due deletions in the system context without binding a patient subject', async () => {
    const { query, withSystemTransaction, database } = fakeDatabase();
    query.mockResolvedValueOnce({ rows: [{ request_id: requestId, outcome: 'completed' }] });
    await expect(new PatientAccountDeletionService(database).finalizeDue('patient-lifecycle-test-1', 5))
      .resolves.toEqual([{ requestId, outcome: 'completed' }]);
    expect(withSystemTransaction).toHaveBeenCalledWith('patient-lifecycle-test-1', expect.any(Function));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('finalize_due_patient_account_deletions'), [5]);
  });
});

describe('PatientAccountDeletionService with ACCOUNT_DELETION_ENABLED=false', () => {
  usePatientSafetyTestEnvironment({ ACCOUNT_DELETION_ENABLED: 'false' });
  const requestId = '90000000-0000-4000-8000-000000000002';

  it('answers 404 on every patient route before any database work, as an older Identity', async () => {
    const { query, database } = fakeDatabase();
    const service = new PatientAccountDeletionService(database);
    await expect(service.status(patientRequest)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.request(patientRequest)).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.confirm(patientRequest, { requestId, confirmationToken: 'D'.repeat(43),
      confirmation: 'DELETE MY ACCOUNT' })).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.cancel(patientRequest, { requestId })).rejects.toBeInstanceOf(NotFoundException);
    expect(query).not.toHaveBeenCalled();
  });

  it('still finalizes deletions already scheduled: the patient decided', async () => {
    const { query, database } = fakeDatabase();
    query.mockResolvedValueOnce({ rows: [] });
    await expect(new PatientAccountDeletionService(database).finalizeDue('patient-lifecycle-test-2')).resolves.toEqual([]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('finalize_due_patient_account_deletions'), [10]);
  });
});
