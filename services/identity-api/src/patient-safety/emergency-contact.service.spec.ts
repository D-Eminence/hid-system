import type { NotificationOtpClient } from '../auth/notification-otp.client';
import type { HidRequest } from '../common/request-context';
import { EmergencyContactProtector, maskDestination } from './emergency-contact-protector';
import { EmergencyContactService } from './emergency-contact.service';
import { fakeDatabase, patientRequest, patientSession, usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';

const contactId = 'a0000000-0000-4000-8000-000000000001';
const patientAccountId = '70000000-0000-4000-8000-000000000001';
const staffRequest = { correlationId: 'staff-correlation', actor: { ...patientRequest.actor, kind: 'staff' } } as unknown as HidRequest;
const emailContact = { name: 'Chidi Okafor', relationship: 'sibling', channel: 'email', destination: 'chidi@example.test' } as const;

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

/** A start-verification answer for the contact, on the given channel. */
function started(protector: EmergencyContactProtector, channel: 'email' | 'sms' = 'email') {
  return async (_sql: string, parameters: unknown[]) => ({ rows: [{
    challenge_id: parameters[3], expires_at: new Date('2026-10-08T09:05:00Z'), channel, contact_key_version: 'test-v1',
    contact_ciphertext: protector.encrypt(contactId, { name: 'Ada', destination: channel === 'email' ? 'ada@example.test' : '+2348031234567' }),
  }] });
}

const contactCommands = (query: jest.Mock) => query.mock.calls.map(([sql]) => String(sql))
  .filter((sql) => /identity\.(add|update|deactivate|start)_my_emergency_contact/.test(sql));

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

  it('keys a destination the same way for every patient, so support can find it across patients', () => {
    const protector = new EmergencyContactProtector();
    expect(protector.destinationHmac('email', protector.normalizeDestination('email', ' Ada@Example.TEST ')))
      .toBe(protector.destinationHmac('email', 'ada@example.test'));
    expect(protector.destinationHmac('email', 'ada@example.test')).not.toBe(protector.destinationHmac('sms', 'ada@example.test'));
  });
});

describe('EmergencyContactService', () => {
  describe('with delivery disabled (switched off)', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'false' });

    it('requires a patient session', async () => {
      const { query, database } = fakeDatabase();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
      await expect(service.list({ correlationId: 'anonymous-correlation' } as HidRequest))
        .rejects.toMatchObject({ code: 'PATIENT_SESSION_REQUIRED' });
      expect(() => service.availability(staffRequest)).toThrow(expect.objectContaining({ code: 'PATIENT_SESSION_REQUIRED' }));
      expect(query).not.toHaveBeenCalled();
    });

    it('tells the patient delivery is off and offers email only, without any database work', () => {
      const { withSystemTransaction, database } = fakeDatabase();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
      expect(service.availability(patientRequest)).toEqual({ delivery: false, channels: ['email'] });
      expect(withSystemTransaction).not.toHaveBeenCalled();
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

    it('refuses to add a contact or send a code with 409, before any query or delivery', async () => {
      const { query, database } = fakeDatabase();
      const deliver = jest.fn();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(),
        { deliver } as unknown as NotificationOtpClient);
      await expect(service.add(patientRequest, emailContact))
        .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE', status: 409 });
      await expect(service.sendVerification(patientRequest, contactId))
        .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE', status: 409 });
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

    it('still lists, removes and confirms contacts', async () => {
      const { query, database } = fakeDatabase();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
      query.mockImplementation(async (sql: string) => sql.includes('deactivate_my_emergency_contact')
        ? { rows: [{ contact_id: contactId, replayed: false }] } : { rows: [] });
      await expect(service.list(patientRequest)).resolves.toEqual([]);
      await expect(service.deactivate(patientRequest, contactId))
        .resolves.toEqual({ contactId, status: 'deactivated', replayed: false });
    });
  });

  describe('with delivery disabled and no contact keys', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'false', NIN_ENCRYPTION_KEY_B64: '', OTP_HMAC_KEY_B64: '' });

    it('answers the delivery refusal, not the key outage, while delivery is off', async () => {
      const { database } = fakeDatabase();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
      await expect(service.add(patientRequest, emailContact)).rejects.toMatchObject({ status: 409 });
    });
  });

  describe('with delivery enabled', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true', HID_DEPLOYMENT_ENV: 'staging' });

    it('tells the patient delivery is on', () => {
      const { database } = fakeDatabase();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
      expect(service.availability(patientRequest)).toEqual({ delivery: true, channels: ['email'] });
    });

    it('stores only ciphertext and a keyed destination HMAC when adding a contact', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const service = new EmergencyContactService(database, protector, {} as NotificationOtpClient);
      let written: unknown[] = [];
      query.mockImplementation(async (sql: string, values: unknown[] = []) => {
        if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
        if (sql.includes('sealed_demo_contact_allowed')) return { rows: [{ allowed: true }] };
        if (sql.includes('add_my_emergency_contact')) { written = values; return { rows: [] }; }
        if (sql.includes('list_my_emergency_contacts')) {
          return { rows: [row(protector, { contact_id: written[2], channel: 'email', contact_ciphertext: written[5] })] };
        }
        return { rows: [] };
      });
      const view = await service.add(patientRequest, { ...emailContact, destination: ' Chidi@Example.TEST ' });
      const parameters = written;
      expect(parameters.slice(0, 2)).toEqual([...patientSession]);
      expect(parameters).not.toContain('chidi@example.test');
      expect(parameters).not.toContain('Chidi Okafor');
      expect(parameters[7]).toBe(protector.destinationHmac('email', 'chidi@example.test'));
      expect(view).toMatchObject({ name: 'Chidi Okafor', status: 'unverified', eligibleForEmergencyNotification: false,
        destinationHint: 'c•••@example.test' });
      expect(JSON.stringify(view)).not.toContain('chidi@example.test');
    });

    it('refuses a contact on a channel that is not enabled with 400, before any query', async () => {
      const { query, database } = fakeDatabase();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
      await expect(service.add(patientRequest, { ...emailContact, channel: 'sms', destination: '0803 123 4567' }))
        .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_CHANNEL_UNAVAILABLE', status: 400 });
      expect(query).not.toHaveBeenCalled();
    });

    it('asks the sealed demo check with the session, the channel, the normalized destination and its HMAC before adding', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const service = new EmergencyContactService(database, protector, {} as NotificationOtpClient);
      let written: unknown[] = [];
      query.mockImplementation(async (sql: string, values: unknown[] = []) => {
        if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
        if (sql.includes('sealed_demo_contact_allowed')) return { rows: [{ allowed: true }] };
        if (sql.includes('add_my_emergency_contact')) { written = values; return { rows: [] }; }
        if (sql.includes('list_my_emergency_contacts')) {
          return { rows: [row(protector, { contact_id: written[2], channel: 'email', contact_ciphertext: written[5] })] };
        }
        return { rows: [] };
      });
      await service.add(patientRequest, { ...emailContact, destination: ' Patient2@HealthIdentityDirectory.com ' });
      const statements = query.mock.calls.map(([sql]) => String(sql));
      const check = statements.findIndex((sql) => sql.includes('sealed_demo_contact_allowed'));
      expect(check).toBeGreaterThan(statements.findIndex((sql) => sql.includes('from auth.otp_challenges')));
      expect(check).toBeLessThan(statements.findIndex((sql) => sql.includes('add_my_emergency_contact')));
      const hmac = protector.destinationHmac('email', 'patient2@healthidentitydirectory.com');
      expect(query.mock.calls[check][1]).toEqual([...patientSession, 'email', 'patient2@healthidentitydirectory.com', hmac]);
      // The add stores the very HMAC the check recorded (0098 G7 admits a demo patient's contact only with it).
      expect(written[7]).toBe(hmac);
    });

    it('answers the database\'s own refusal of a demo contact (0098 G7) as 400, not as a missing session', async () => {
      const { query, database } = fakeDatabase();
      const deliver = jest.fn();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(),
        { deliver } as unknown as NotificationOtpClient);
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
        if (sql.includes('sealed_demo_contact_allowed')) return { rows: [{ allowed: true }] };
        if (sql.includes('add_my_emergency_contact')) {
          throw { code: '42501', message: 'EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED' };
        }
        return { rows: [] };
      });
      await expect(service.add(patientRequest, emailContact)).rejects.toMatchObject({
        code: 'EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED', status: 400 });
      expect(deliver).not.toHaveBeenCalled();
    });

    it.each([
      [{ allowed: false }],
      [{ allowed: null }],
      [undefined],
    ])('refuses a demo patient\'s contact outside the demo mailboxes with 400 and adds nothing (%o)', async (answer) => {
      const { query, database, withSystemTransaction } = fakeDatabase();
      const deliver = jest.fn();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(),
        { deliver } as unknown as NotificationOtpClient);
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
        if (sql.includes('sealed_demo_contact_allowed')) return { rows: answer ? [answer] : [] };
        return { rows: [] };
      });
      await expect(service.add(patientRequest, emailContact)).rejects.toMatchObject({
        code: 'EMERGENCY_CONTACT_DESTINATION_NOT_ALLOWED', status: 400,
        message: 'A demo account can only add the demo mailboxes.' });
      // Thrown inside the transaction callback: nothing is added and nothing is sent.
      await expect(withSystemTransaction.mock.results[0]?.value).rejects.toMatchObject({ status: 400 });
      expect(contactCommands(query)).toEqual([]);
      expect(deliver).not.toHaveBeenCalled();
    });

    it('lets the database refuse a check without a live patient session as before (403)', async () => {
      const { query, database } = fakeDatabase();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
        if (sql.includes('sealed_demo_contact_allowed')) throw { code: '42501', message: 'Patient self session is required' };
        return { rows: [] };
      });
      await expect(service.add(patientRequest, emailContact)).rejects.toMatchObject({ code: 'PATIENT_SESSION_REQUIRED', status: 403 });
      expect(contactCommands(query)).toEqual([]);
    });

    it('refuses to send a code to a contact whose channel was switched off, inside the start transaction', async () => {
      const { query, database, withSystemTransaction } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const deliver = jest.fn();
      const service = new EmergencyContactService(database, protector, { deliver } as unknown as NotificationOtpClient);
      query.mockResolvedValueOnce({ rows: [] }).mockImplementationOnce(started(protector, 'sms'));
      await expect(service.sendVerification(patientRequest, contactId))
        .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_CHANNEL_UNAVAILABLE', status: 409 });
      // Thrown from inside the transaction callback, so the challenge rolls back.
      await expect(withSystemTransaction.mock.results[0]?.value).rejects.toMatchObject({ status: 409 });
      expect(deliver).not.toHaveBeenCalled();
      expect(query).toHaveBeenCalledTimes(2);
    });

    it.each([
      [{ code: '23505' }, 'EMERGENCY_CONTACT_DUPLICATE', 409],
      [{ code: 'P0001', message: 'EMERGENCY_CONTACT_LIMIT_REACHED' }, 'EMERGENCY_CONTACT_LIMIT_REACHED', 409],
      [{ code: 'P0002' }, 'EMERGENCY_CONTACT_NOT_FOUND', 404],
      [{ code: '42501' }, 'PATIENT_SESSION_REQUIRED', 403],
      [{ code: '22023' }, 'INVALID_EMERGENCY_CONTACT', 400],
    ])('maps contact command refusal %o', async (failure, code, status) => {
      const { query, database } = fakeDatabase();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
        if (sql.includes('sealed_demo_contact_allowed')) return { rows: [{ allowed: true }] };
        if (sql.includes('add_my_emergency_contact')) throw failure;
        return { rows: [] };
      });
      await expect(service.add(patientRequest, emailContact)).rejects.toMatchObject({ code, status });
    });

    it.each([
      [{ code: '55000' }, 'EMERGENCY_CONTACT_ALREADY_VERIFIED', 409],
      [{ code: 'P0001', message: 'EMERGENCY_CONTACT_VERIFICATION_RATE_LIMITED' }, 'EMERGENCY_CONTACT_VERIFICATION_RATE_LIMITED', 429],
      [{ code: 'P0002' }, 'EMERGENCY_CONTACT_NOT_FOUND', 404],
    ])('maps start-verification refusal %o', async (failure, code, status) => {
      const { query, database } = fakeDatabase();
      const deliver = jest.fn();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(),
        { deliver } as unknown as NotificationOtpClient);
      query.mockImplementation(async (sql: string) => {
        if (sql.includes('start_my_emergency_contact_verification')) throw failure;
        return { rows: [] };
      });
      await expect(service.sendVerification(patientRequest, contactId)).rejects.toMatchObject({ code, status });
      expect(deliver).not.toHaveBeenCalled();
    });

    it('stores a verifier, delivers the code to the decrypted contact, and records the outcome', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' });
      const service = new EmergencyContactService(database, protector, { deliver } as unknown as NotificationOtpClient);
      query.mockResolvedValueOnce({ rows: [] }).mockImplementationOnce(started(protector))
        .mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
      const result = await service.sendVerification(patientRequest, contactId);
      const startParameters = query.mock.calls[1][1] as unknown[];
      const delivered = deliver.mock.calls[0][0] as { code: string; recipient: string; purpose: string; challengeId: string };
      expect(delivered).toMatchObject({ recipient: 'ada@example.test', purpose: 'EMERGENCY_CONTACT_VERIFY', channel: 'email' });
      expect(delivered.code).toMatch(/^\d{6}$/);
      expect(startParameters).not.toContain(delivered.code);
      expect(startParameters[4]).toBe(protector.verifier(delivered.challengeId, contactId, delivered.code));
      expect(query.mock.calls[3][1]).toEqual([...patientSession, delivered.challengeId, 'accepted', 'brevo']);
      expect(result).toMatchObject({ challengeId: delivered.challengeId, deliveryOutcome: 'accepted' });
    });

    it('reports an undeliverable code as 422 after recording the failed delivery', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const deliver = jest.fn().mockResolvedValue({ outcome: 'definitive_failure' });
      const service = new EmergencyContactService(database, protector, { deliver } as unknown as NotificationOtpClient);
      query.mockResolvedValueOnce({ rows: [] }).mockImplementationOnce(started(protector)).mockResolvedValue({ rows: [] });
      await expect(service.sendVerification(patientRequest, contactId))
        .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_VERIFICATION_UNDELIVERABLE', status: 422 });
      expect(query).toHaveBeenCalledWith(expect.stringContaining('record_my_emergency_contact_verification_delivery'),
        expect.arrayContaining(['definitive_failure']));
    });

    it('maps a database refusal of the delivery record, after the code was sent', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' });
      const service = new EmergencyContactService(database, protector, { deliver } as unknown as NotificationOtpClient);
      query.mockImplementation(async (sql: string, parameters: unknown[]) => {
        if (sql.includes('start_my_emergency_contact_verification')) return started(protector)(sql, parameters);
        if (sql.includes('record_my_emergency_contact_verification_delivery')) throw { code: '42501', message: 'session ended' };
        return { rows: [] };
      });
      await expect(service.sendVerification(patientRequest, contactId))
        .rejects.toMatchObject({ code: 'PATIENT_SESSION_REQUIRED', status: 403 });
      expect(deliver).toHaveBeenCalledTimes(1);
    });

    describe('erasing a removed contact (the database wipes its name and destination)', () => {
      it('removes with the session and contact id only: no ciphertext, key version or HMAC is sent', async () => {
        const { query, database } = fakeDatabase();
        const service = new EmergencyContactService(database, new EmergencyContactProtector(), {} as NotificationOtpClient);
        query.mockImplementation(async (sql: string) => sql.includes('deactivate_my_emergency_contact')
          ? { rows: [{ contact_id: contactId, replayed: false }] } : { rows: [] });
        await expect(service.deactivate(patientRequest, contactId))
          .resolves.toEqual({ contactId, status: 'deactivated', replayed: false });
        const removal = query.mock.calls.find(([sql]) => String(sql).includes('deactivate_my_emergency_contact'));
        expect(removal?.[1]).toEqual([...patientSession, contactId]);
      });

      it('never reads, changes or verifies a removed contact again', async () => {
        const { query, database } = fakeDatabase();
        const deliver = jest.fn();
        const service = new EmergencyContactService(database, new EmergencyContactProtector(),
          { deliver } as unknown as NotificationOtpClient);
        // The list never returns a deactivated contact, and starting a verification for one is refused.
        query.mockImplementation(async (sql: string) => {
          if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
          if (sql.includes('start_my_emergency_contact_verification')) throw { code: 'P0002' };
          return { rows: [] };
        });
        await expect(service.list(patientRequest)).resolves.toEqual([]);
        await expect(service.update(patientRequest, contactId, { expectedVersion: 2, name: 'Someone Else' }))
          .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_NOT_FOUND', status: 404 });
        await expect(service.sendVerification(patientRequest, contactId))
          .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_NOT_FOUND', status: 404 });
        expect(contactCommands(query).filter((sql) => !sql.includes('start_'))).toEqual([]);
        expect(deliver).not.toHaveBeenCalled();
      });
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
        await expect(service.add(patientRequest, emailContact))
          .rejects.toMatchObject({ status: 403, code: 'PATIENT_RECENT_RECOVERY_HOLD' });
        await expect(service.update(patientRequest, contactId, { expectedVersion: 1, name: 'Someone Else' }))
          .rejects.toMatchObject({ status: 403, code: 'PATIENT_RECENT_RECOVERY_HOLD' });
        expect(commands()).toEqual([]);
        const hold = query.mock.calls.find(([sql]) => String(sql).includes('from auth.otp_challenges'));
        expect(hold?.[1]).toEqual([patientAccountId, 24]);
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

  describe('with delivery enabled on the production profile', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true', HID_DEPLOYMENT_ENV: 'production' });

    it('delivers a verification code (main refuses delivery in production; Novu does not)', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' });
      const service = new EmergencyContactService(database, protector, { deliver } as unknown as NotificationOtpClient);
      query.mockResolvedValueOnce({ rows: [] }).mockImplementationOnce(started(protector)).mockResolvedValue({ rows: [] });
      await expect(service.sendVerification(patientRequest, contactId)).resolves.toMatchObject({ deliveryOutcome: 'accepted' });
      expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ purpose: 'EMERGENCY_CONTACT_VERIFY', channel: 'email' }));
    });
  });

  describe('with SMS enabled too', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true', EMERGENCY_CONTACT_CHANNELS: 'email,sms' });

    it('offers both channels and accepts an SMS contact', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const service = new EmergencyContactService(database, protector, {} as NotificationOtpClient);
      expect(service.availability(patientRequest)).toEqual({ delivery: true, channels: ['email', 'sms'] });
      let written: unknown[] = [];
      query.mockImplementation(async (sql: string, values: unknown[] = []) => {
        if (sql.includes('from auth.otp_challenges')) return { rows: [{ held: false }] };
        if (sql.includes('sealed_demo_contact_allowed')) return { rows: [{ allowed: true }] };
        if (sql.includes('add_my_emergency_contact')) { written = values; return { rows: [] }; }
        if (sql.includes('list_my_emergency_contacts')) return { rows: [row(protector, { contact_id: written[2], contact_ciphertext: written[5] })] };
        return { rows: [] };
      });
      await expect(service.add(patientRequest, { ...emailContact, channel: 'sms', destination: '0803 123 4567' }))
        .resolves.toMatchObject({ channel: 'sms', destinationHint: '+234•••••567' });
      expect(written[7]).toBe(protector.destinationHmac('sms', '+2348031234567'));
    });
  });

  describe('with a pilot list that does not hold this patient', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true',
      EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS: '70000000-0000-4000-8000-0000000000aa' });

    it('tells the patient delivery is off and refuses to add or send, before any query', async () => {
      const { query, database } = fakeDatabase();
      const deliver = jest.fn();
      const service = new EmergencyContactService(database, new EmergencyContactProtector(),
        { deliver } as unknown as NotificationOtpClient);
      expect(service.availability(patientRequest)).toEqual({ delivery: false, channels: ['email'] });
      await expect(service.add(patientRequest, emailContact))
        .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE', status: 409 });
      await expect(service.sendVerification(patientRequest, contactId))
        .rejects.toMatchObject({ code: 'EMERGENCY_CONTACT_DELIVERY_UNAVAILABLE', status: 409 });
      expect(query).not.toHaveBeenCalled();
      expect(deliver).not.toHaveBeenCalled();
    });
  });

  describe('with a pilot list that holds this patient', () => {
    usePatientSafetyTestEnvironment({ EMERGENCY_CONTACT_DELIVERY_ENABLED: 'true',
      EMERGENCY_CONTACT_PILOT_ACCOUNT_IDS: `70000000-0000-4000-8000-0000000000AA, ${patientAccountId.toUpperCase()}` });

    it('tells the patient delivery is on and sends the code', async () => {
      const { query, database } = fakeDatabase();
      const protector = new EmergencyContactProtector();
      const deliver = jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'brevo' });
      const service = new EmergencyContactService(database, protector, { deliver } as unknown as NotificationOtpClient);
      expect(service.availability(patientRequest)).toEqual({ delivery: true, channels: ['email'] });
      query.mockResolvedValueOnce({ rows: [] }).mockImplementationOnce(started(protector)).mockResolvedValue({ rows: [] });
      await expect(service.sendVerification(patientRequest, contactId)).resolves.toMatchObject({ deliveryOutcome: 'accepted' });
    });
  });
});
