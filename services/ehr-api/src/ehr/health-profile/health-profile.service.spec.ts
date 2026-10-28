import 'reflect-metadata';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { RequestMethod } from '@nestjs/common';
import type { PoolClient } from 'pg';
import type { AuditService } from '../../audit/audit.service';
import { AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, PATIENT_ALLOWED, REQUIRED_PERMISSIONS } from '../../common/decorators';
import { DomainProblem } from '../../common/problem';
import type { DataAccessContext, HidRequest } from '../../common/request-context';
import type { DatabaseService } from '../../database/database.service';
import type { IdentityApiService } from '../../integrations/identity-api.service';
import type { ClinicalRepository } from '../shared/clinical.repository';
import { HealthProfileController } from './health-profile.controller';
import { HealthProfileService, healthProfileText } from './health-profile.service';

const actor = { kind: 'patient', patientId: 'patient-id', accountId: 'account-id', subject: 'subject', sessionId: 'session-id' };
const request = { actor, correlationId: 'health-profile-test', header: () => undefined } as unknown as HidRequest;
const saved = { outcome: 'saved', blood_group: 'O+', genotype: 'AS', allergies: 'Penicillin', current_medications: null,
  chronic_conditions: 'Asthma\nsince 2010', medical_notes: null, row_version: '2', updated_at: new Date('2026-10-28T08:00:00Z') };

function setup(rows: unknown[] = []) {
  const authorization = { ...actor, expiresAt: new Date(Date.now() + 30_000).toISOString(), allowed: true };
  const authorizeSelf = jest.fn().mockResolvedValue(authorization);
  const query = jest.fn().mockResolvedValue({ rows });
  const client = { query } as unknown as PoolClient;
  const transaction = jest.fn(async (_auth: unknown, _correlation: string, work: (c: PoolClient) => Promise<unknown>) => work(client));
  const recordWithClient = jest.fn().mockResolvedValue(undefined);
  const run = jest.fn(async (_context: unknown, _patient: string, _access: string, _event: unknown,
    operation: (c: PoolClient) => Promise<{ value: unknown }>) => (await operation(client)).value);
  const service = new HealthProfileService({ withPatientTransaction: transaction } as unknown as DatabaseService,
    { authorizeSelf } as unknown as IdentityApiService, { recordWithClient } as unknown as AuditService,
    { run } as unknown as ClinicalRepository);
  return { service, authorizeSelf, query, transaction, recordWithClient, run };
}

async function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return error;
    throw error;
  }
  throw new Error('No problem was raised');
}

describe('Patient-reported health information (0094)', () => {
  it('serves the contract\'s three routes with their decorators', () => {
    const routes = Object.getOwnPropertyNames(HealthProfileController.prototype).filter((name) => name !== 'constructor')
      .map((name) => {
        const handler = (HealthProfileController.prototype as unknown as Record<string, () => unknown>)[name]!;
        return [Reflect.getMetadata(METHOD_METADATA, handler), Reflect.getMetadata(PATH_METADATA, handler),
          Reflect.getMetadata(PATIENT_ALLOWED, handler) ?? false, Reflect.getMetadata(FACILITY_OPTIONAL, handler) ?? false,
          Reflect.getMetadata(REQUIRED_PERMISSIONS, handler) ?? null];
      });
    expect(Reflect.getMetadata(PATH_METADATA, HealthProfileController)).toBe('ehr');
    expect(Reflect.getMetadata(AUDIT_FAILURES_ONLY, HealthProfileController)).toBe(true);
    expect(routes).toEqual([
      [RequestMethod.GET, 'me/health-profile', true, true, null],
      [RequestMethod.PUT, 'me/health-profile', true, true, null],
      [RequestMethod.GET, 'patients/:patientId/reported-health-profile', false, false, ['ehr.note.read']],
    ]);
  });

  it('reads the patient\'s own values in a fresh patient-self transaction, audited; nothing saved is version 0', async () => {
    const empty = setup();
    await expect(empty.service.own(request)).resolves.toEqual({ bloodGroup: null, genotype: null, allergies: null,
      currentMedications: null, chronicConditions: null, medicalNotes: null, rowVersion: 0, updatedAt: null });
    expect(empty.authorizeSelf).toHaveBeenCalledWith(request);
    expect(empty.query.mock.calls[0]?.[1]).toEqual(['patient-id']);
    expect(empty.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      actorType: 'patient', action: 'ehr.patient.self.health-profile.read', patientId: 'patient-id', outcome: 'success' }));
    const filled = setup([saved]);
    await expect(filled.service.own(request)).resolves.toEqual({ bloodGroup: 'O+', genotype: 'AS',
      allergies: 'Penicillin', currentMedications: null, chronicConditions: 'Asthma\nsince 2010', medicalNotes: null,
      rowVersion: 2, updatedAt: '2026-10-28T08:00:00.000Z' });
  });

  it('saves through the session-bound command with trimmed text, and answers 409 on a stale version', async () => {
    const s = setup([saved]);
    await expect(s.service.save(request, { expectedVersion: 1, bloodGroup: 'O+', genotype: 'AS', allergies: ' Penicillin ',
      currentMedications: '   ', chronicConditions: 'Asthma\r\nsince 2010', medicalNotes: null })).resolves
      .toMatchObject({ bloodGroup: 'O+', rowVersion: 2 });
    expect(s.query.mock.calls[0]?.[0]).toContain('ehr.save_my_reported_health_profile($1, $2, $3, $4, $5, $6, $7)');
    expect(s.query.mock.calls[0]?.[1]).toEqual([1, 'O+', 'AS', 'Penicillin', null, 'Asthma\nsince 2010', null]);
    const stale = setup([{ ...saved, outcome: 'conflict' }]);
    const conflict = await problem(stale.service.save(request, { expectedVersion: 1 }));
    expect([conflict.getStatus(), conflict.code]).toEqual([409, 'VERSION_CONFLICT']);
  });

  it('refuses more than 1000 characters, control characters but the newline, and lists it does not know', async () => {
    expect(healthProfileText('a'.repeat(1000), 'allergies')).toHaveLength(1000);
    expect(healthProfileText('line one\nline two', 'allergies')).toBe('line one\nline two');
    for (const value of ['a'.repeat(1001), 'tab\there', 'nul\u0000', 'bell\u0007', 'c1\u0085', 7]) {
      expect(() => healthProfileText(value, 'allergies')).toThrow('at most 1000 characters');
    }
    const s = setup([saved]);
    const blood = await problem(s.service.save(request, { expectedVersion: 0, bloodGroup: 'Z+' as never }));
    expect([blood.getStatus(), blood.code]).toEqual([400, 'HEALTH_PROFILE_INVALID']);
    const genotype = await problem(s.service.save(request, { expectedVersion: 0, genotype: 'XX' as never }));
    expect(genotype.code).toBe('HEALTH_PROFILE_INVALID');
    expect(s.authorizeSelf).not.toHaveBeenCalled();
  });

  it('answers 403 when the patient-self context is refused, before or inside the command', async () => {
    const changed = setup();
    changed.authorizeSelf.mockResolvedValue({ ...actor, patientId: 'other-patient' });
    await expect(changed.service.save(request, { expectedVersion: 0 })).rejects.toThrow('Patient authorization changed');
    expect(changed.transaction).not.toHaveBeenCalled();
    const refused = setup();
    refused.query.mockRejectedValue(Object.assign(new Error('Patient self context is required'), { code: '42501' }));
    const denied = await problem(refused.service.save(request, { expectedVersion: 0 }));
    expect([denied.getStatus(), denied.code]).toEqual([403, 'PATIENT_ACCESS_DENIED']);
  });

  it('a clinician reads it through the chart\'s read authorization, audited as a record view, without the version', async () => {
    const s = setup([saved]);
    const context = { purposeOfUse: 'direct-care', facilityId: 'facility' } as DataAccessContext;
    await expect(s.service.reported('patient-id', context)).resolves.toEqual({ bloodGroup: 'O+', genotype: 'AS',
      allergies: 'Penicillin', currentMedications: null, chronicConditions: 'Asthma\nsince 2010', medicalNotes: null,
      updatedAt: '2026-10-28T08:00:00.000Z' });
    expect(s.run).toHaveBeenCalledWith(context, 'patient-id', 'read_records', { action: 'ehr.record.read',
      resourceType: 'patient-reported-health-profile', resourceId: 'patient-id' }, expect.any(Function));
    expect(s.query.mock.calls[0]?.[1]).toEqual(['patient-id']);
  });
});
