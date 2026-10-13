import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { HidRequest } from '../common/request-context';
import { EmergencyContactProtector, maskDestination } from './emergency-contact-protector';
import { EmergencyContactService } from './emergency-contact.service';
import { fakeDatabase, patientRequest, patientSession, usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';

const contactId = 'a0000000-0000-4000-8000-000000000001';

function row(protector: EmergencyContactProtector, overrides: Record<string, unknown> = {}) {
  return {
    contact_id: contactId, relationship: 'sibling', channel: 'sms',
    contact_ciphertext: protector.encrypt(contactId, { name: 'Chidi Okafor', destination: '+2348031234567' }),
    contact_key_version: 'test-v1', notify_on_emergency_access: true, status: 'unverified', verified_at: null,
    created_at: new Date('2026-10-08T09:00:00Z'), row_version: '1', verification_expires_at: null,
    verification_delivery_outcome: null, last_notification_status: null, last_notification_at: null,
    ...overrides,
  };
}

describe('EmergencyContactProtector', () => {
  usePatientSafetyTestEnvironment();

  it('round-trips only under the contact-bound associated data and current key version', () => {
    const protector = new EmergencyContactProtector();
    const sealed = protector.encrypt(contactId, { name: 'Ngozi', destination: 'ngozi@example.test' });
    expect(sealed.toString('utf8')).not.toContain('ngozi@example.test');
    expect(protector.decrypt(contactId, 'test-v1', sealed)).toEqual({ name: 'Ngozi', destination: 'ngozi@example.test' });
    expect(() => protector.decrypt('a0000000-0000-4000-8000-000000000002', 'test-v1', sealed))
      .toThrow(expect.objectContaining({ code: 'EMERGENCY_CONTACTS_UNAVAILABLE' }));
    expect(() => protector.decrypt(contactId, 'rotated-v2', sealed))
      .toThrow(expect.objectContaining({ code: 'EMERGENCY_CONTACTS_UNAVAILABLE' }));
  });

  it('normalizes destinations and keeps the destination HMAC distinct from the verifier', () => {
    const protector = new EmergencyContactProtector();
    expect(protector.normalizeDestination('sms', '0803 123 4567')).toBe('+2348031234567');
    expect(protector.normalizeDestination('email', ' Ada@Example.TEST ')).toBe('ada@example.test');
    expect(() => protector.normalizeDestination('sms', 'not a phone')).toThrow(expect.objectContaining({ status: 400 }));
    const destination = protector.destinationHmac('sms', '+2348031234567');
    expect(destination).toMatch(/^[0-9a-f]{64}$/);
    expect(protector.verifier('challenge', contactId, '123456')).not.toBe(protector.verifier('challenge', contactId, '123457'));
    expect(maskDestination('sms', '+2348031234567')).toBe('+234•••••567');
    expect(maskDestination('email', 'ada@example.test')).toBe('a•••@example.test');
  });
});

describe('EmergencyContactService', () => {
  describe('with delivery disabled (default)', () => {
    usePatientSafetyTestEnvironment();

    it('requires a patient session', async () => {
      const { query, database } = fakeDatabase();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
      await expect(service.list({ correlationId: 'anonymous-correlation' } as HidRequest))
        .rejects.toMatchObject({ code: 'PATIENT_SESSION_REQUIRED' });
      expect(query).not.toHaveBeenCalled();
    });

    it('stores only ciphertext and a keyed destination HMAC when adding a contact', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const service = new EmergencyContactService(database, protector, {} as NotificationOtpClient);
      let written: unknown[] = [];
      query.mockImplementation(async (sql: string, values: unknown[] = []) => {
        if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
        if (sql.includes('add_my_emergency_contact')) { written = values; return { rows: [] }; }
        if (sql.includes('list_my_emergency_contacts')) {
          return { rows: [row(protector, { contact_id: written[2], contact_ciphertext: written[5] })] };
        }
        return { rows: [] };
      });
      const view = await service.add(patientRequest, {
        name: 'Chidi Okafor', relationship: 'sibling', channel: 'sms', destination: '0803 123 4567',
      });
      const parameters = written;
      expect(parameters.slice(0, 2)).toEqual([...patientSession]);
      expect(parameters).not.toContain('+2348031234567');
      expect(parameters).not.toContain('Chidi Okafor');
      expect(parameters[7]).toBe(protector.destinationHmac('sms', '+2348031234567'));
      expect(view).toMatchObject({ name: 'Chidi Okafor', status: 'unverified', eligibleForEmergencyNotification: false,
        destinationHint: '+234•••••567' });
      expect(JSON.stringify(view)).not.toContain('+2348031234567');
    });

    it('marks only verified, consenting contacts as emergency recipients', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const service = new EmergencyContactService(database, protector, {} as NotificationOtpClient);
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [
        row(protector, { status: 'verified', verified_at: new Date() }),
        row(protector, { status: 'verified', verified_at: new Date(), notify_on_emergency_access: false }),
        row(protector, { status: 'unverified' }),
      ] });
      const views = await service.list(patientRequest);
      expect(views.map((view) => view.eligibleForEmergencyNotification)).toEqual([true, false, false]);
    });

    it('refuses to send verification codes while delivery is disabled', async () => {
      const { query, database } = fakeDatabase();
      const deliver = jest.fn();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(),
        { deliver } as unknown as NotificationOtpClient);
      await expect(service.sendVerification(patientRequest, contactId))
        .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE', status: 503 });
      expect(query).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });

    it.each([
      ['verified', undefined],
      ['invalid', 'EMERGENCY_CONTACT_CODE_INVALID'],
      ['expired', 'EMERGENCY_CONTACT_CODE_EXPIRED'],
    ])('maps the committed %s verification outcome', async (outcome, code) => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const service = new EmergencyContactService(database, protector, {} as NotificationOtpClient);
      query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [{ outcome }] });
      const challengeId = 'b0000000-0000-4000-8000-000000000001';
      const attempt = service.confirmVerification(patientRequest, contactId, { challengeId, code: '123456' });
      if (code) await expect(attempt).rejects.toMatchObject({ code, status: 403 });
      else await expect(attempt).resolves.toEqual({ contactId, status: 'verified' });
      // The code itself never reaches the database; only its challenge-bound verifier does.
      expect(query.mock.calls[1][1]).toEqual([...patientSession, contactId, challengeId,
        protector.verifier(challengeId, contactId, '123456')]);
    });

    it.each([
      [{ code: '23505' }, 'EMERGENCY_CONTACT_DUPLICATE'],
      [{ code: 'P0001', message: 'EMERGENCY_CONTACT_LIMIT_REACHED' }, 'EMERGENCY_CONTACT_LIMIT_REACHED'],
      [{ code: 'P0002' }, 'EMERGENCY_CONTACT_NOT_FOUND'],
      [{ code: '42501' }, 'PATIENT_SESSION_REQUIRED'],
    ])('maps contact command refusal %o', async (failure, code) => {
      const { query, database } = fakeDatabase();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
        if (sql.includes('add_my_emergency_contact')) throw failure;
        return { rows: [] };
      });
      await expect(service.add(patientRequest, {
        name: 'Chidi Okafor', relationship: 'sibling', channel: 'email', destination: 'chidi@example.test',
      })).rejects.toMatchObject({ code });
    });

    describe('for 24 hours after an OTP account recovery (REC-NOTIFY)', () => {
      function held(protector: EmergencyContactProtector) {
        const { query, database } = fakeDatabase();
        query.mockImplementation(async (sql: string) => {
          if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: true }] };
          if (sql.includes('list_my_emergency_contacts')) return { rows: [row(protector, { status: 'verified' })] };
          if (sql.includes('deactivate_my_emergency_contact')) return { rows: [{ contact_id: contactId, replayed: false }] };
          return { rows: [] };
        });
        const service = new EmergencyContactService(database, protector, {} as NotificationOtpClient);
        const commands = () => query.mock.calls.map(([sql]) => String(sql))
          .filter((sql) => /identity\.(add|update|deactivate)_my_emergency_contact/.test(sql));
        return { service, query, commands };
      }

      it('refuses to add or change a contact, before any contact command', async () => {
        const protector = new EmergencyContactProtector();
        const { service, query, commands } = held(protector);
        await expect(service.add(patientRequest, {
          name: 'Chidi Okafor', relationship: 'sibling', channel: 'email', destination: 'chidi@example.test',
        })).rejects.toMatchObject({ status: 403, code: 'PATIENT_RECENT_RECOVERY_HOLD' });
        await expect(service.update(patientRequest, contactId, { expectedVersion: 1, name: 'Someone Else' }))
          .rejects.toMatchObject({ status: 403, code: 'PATIENT_RECENT_RECOVERY_HOLD' });
        expect(commands()).toEqual([]);
        const hold = query.mock.calls.find(([sql]) => String(sql).includes('from auth.otp_challenges'));
        expect(hold?.[1]).toEqual(['70000000-0000-4000-8000-000000000001', 24]);
      });

      it('still deactivates a contact', async () => {
        const { service, query, commands } = held(new EmergencyContactProtector());
        await expect(service.deactivate(patientRequest, contactId))
          .resolves.toMatchObject({ contactId, status: 'deactivated' });
        expect(commands()).toHaveLength(1);
        expect(query.mock.calls.some(([sql]) => String(sql).includes('from auth.otp_challenges'))).toBe(false);
      });
    });
  });

  describe('with staging delivery enabled', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true', HID_DEPLOYMENT_ENV: 'staging' });

    it('stores a verifier, delivers the code to the decrypted contact, and records the outcome', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'termii' });
      const service = new EmergencyContactService(database, protector, { deliver } as unknown as NotificationOtpClient);
      const sealed = protector.encrypt(contactId, { name: 'Chidi Okafor', destination: '+2348031234567' });
      query.mockResolvedValueOnce({ rows: [] })
        .mockImplementationOnce(async (_sql: string, parameters: unknown[]) => ({ rows: [{
          challenge_id: parameters[3], expires_at: new Date('2026-10-08T09:05:00Z'), channel: 'sms',
          contact_ciphertext: sealed, contact_key_version: 'test-v1',
        }] }))
        .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      const result = await service.sendVerification(patientRequest, contactId);
      const startParameters = query.mock.calls[1][1] as unknown[];
      const delivered = deliver.mock.calls[0][0] as { code: string; recipient: string; purpose: string; challengeId: string };
      expect(delivered).toMatchObject({ recipient: '+2348031234567', purpose: 'EMERGENCY_CONTACT_VERIFY', channel: 'sms' });
      expect(delivered.code).toMatch(/^\d{6}$/);
      expect(startParameters).not.toContain(delivered.code);
      expect(startParameters[4]).toBe(protector.verifier(delivered.challengeId, contactId, delivered.code));
      expect(query.mock.calls[3][1]).toEqual([...patientSession, delivered.challengeId, 'accepted', 'termii']);
      expect(result).toMatchObject({ challengeId: delivered.challengeId, deliveryOutcome: 'accepted' });
    });

    it('reports an undeliverable code after recording the failed delivery', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const deliver = jest.fn().mockResolvedValue({ outcome: 'definitive_failure' });
      const service = new EmergencyContactService(database, protector, { deliver } as unknown as NotificationOtpClient);
      query.mockResolvedValueOnce({ rows: [] })
        .mockImplementationOnce(async (_sql: string, parameters: unknown[]) => ({ rows: [{
          challenge_id: parameters[3], expires_at: new Date(), channel: 'email', contact_key_version: 'test-v1',
          contact_ciphertext: protector.encrypt(contactId, { name: 'Ada', destination: 'ada@example.test' }),
        }] }))
        .mockResolvedValue({ rows: [] });
      await expect(service.sendVerification(patientRequest, contactId))
        .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_VERIFICATION_UNDELIVERABLE' });
      expect(query).toHaveBeenCalledWith(expect.stringContaining('record_my_emergency_contact_verification_delivery'),
        expect.arrayContaining(['definitive_failure']));
    });
  });
});
