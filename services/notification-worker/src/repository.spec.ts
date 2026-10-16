import { createHash } from 'node:crypto';
import { readConfig } from './config';
import { ClaimLostError, NotificationRepository } from './repository';

// The claim-bound recipient lookup of 0095 and the PHI-free disclosure rows
// (ADR-064). The worker reads no identity or auth table: it only calls
// integration.notification_recipient_for_claim with its live claim.
const event = {
  schema: 'ng.hid.event-envelope' as const, schemaVersion: 1 as const,
  id: '10000000-0000-4000-8000-000000000001', type: 'PatientAccessPinVerified', version: 1 as const,
  occurredAt: '2026-08-12T10:00:00.000Z', producer: 'identity' as const, correlationId: 'correlation-0001',
  context: { facilityId: '20000000-0000-4000-8000-000000000001', patientId: '30000000-0000-4000-8000-000000000001' },
  payload: { consentGrantId: '40000000-0000-4000-8000-000000000001', reviewRequired: true },
};
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');

function repositoryWith(answer: (text: string, values: unknown[]) => unknown) {
  const repository = new NotificationRepository(readConfig({ NODE_ENV: 'test',
    NOTIFICATION_WORKER_DATABASE_URL: 'postgresql://worker@127.0.0.1:1/hid' }));
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let ended = 0;
  const pool = {
    query: async (text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const result = answer(text, values);
      if (result instanceof Error) throw result;
      return result;
    },
    end: async () => { ended += 1; },
  };
  void (repository as unknown as { pool: { end(): Promise<void> } }).pool.end();
  (repository as unknown as { pool: typeof pool }).pool = pool;
  return { repository, calls, ended: () => ended };
}

describe('claim-bound recipient lookup', () => {
  it('calls only the 0095 function with the event, the live claim token and the patient id', async () => {
    const { repository, calls } = repositoryWith(() => ({ rows: [{ delivery: 'email', email: 'synthetic@example.invalid' }] }));
    await expect(repository.resolveRecipient(event, 'claim-token-1'))
      .resolves.toEqual({ delivery: 'email', email: 'synthetic@example.invalid' });
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/^select delivery, email\s+from integration\.notification_recipient_for_claim\(\$1, \$2, \$3\)$/);
    expect(calls[0].values).toEqual([event.id, 'claim-token-1', event.context.patientId]);
    expect(calls[0].text).not.toMatch(/identity\.|auth\./);
  });

  it('maps a withheld answer and an event that binds to no outbox row to withhold', async () => {
    await expect(repositoryWith(() => ({ rows: [{ delivery: 'withhold', email: null }] })).repository
      .resolveRecipient(event, 'claim-token-1')).resolves.toEqual({ delivery: 'withhold', bound: true });
    await expect(repositoryWith(() => ({ rows: [] })).repository.resolveRecipient(event, 'claim-token-1'))
      .resolves.toEqual({ delivery: 'withhold', bound: false });
  });

  it('turns a stale or foreign claim (55000) into ClaimLostError', async () => {
    const { repository } = repositoryWith(() => Object.assign(new Error('Inbox claim is stale or not owned'), { code: '55000' }));
    await expect(repository.resolveRecipient(event, 'claim-token-1')).rejects.toBeInstanceOf(ClaimLostError);
  });

  it('fails closed on any other error and on an answer outside the contract', async () => {
    await expect(repositoryWith(() => Object.assign(new Error('permission denied'), { code: '42501' })).repository
      .resolveRecipient(event, 'claim-token-1')).rejects.not.toBeInstanceOf(ClaimLostError);
    for (const row of [{ delivery: 'email', email: null }, { delivery: 'email', email: '' },
      { delivery: 'in_app', email: null }, { delivery: 'withhold', email: 'synthetic@example.invalid' }]) {
      await expect(repositoryWith(() => ({ rows: [row] })).repository.resolveRecipient(event, 'claim-token-1'))
        .rejects.toThrow('NOTIFICATION_RECIPIENT_CONTRACT_VIOLATION');
    }
    await expect(repositoryWith(() => ({ rows: [{ delivery: 'withhold', email: null }, { delivery: 'withhold', email: null }] }))
      .repository.resolveRecipient(event, 'claim-token-1')).rejects.toThrow('NOTIFICATION_RECIPIENT_CONTRACT_VIOLATION');
  });
});

describe('PHI-free subscriber disclosure rows', () => {
  it.each([
    ['email', { outcome: 'confirmed', provider: 'novu' }, 'novu-subscriber-email-v1', 'accepted', null],
    ['email', { outcome: 'unknown', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_503' }, 'novu-subscriber-email-v1',
      'unknown', 'NOVU_SUBSCRIBER_HTTP_503'],
    ['clear', { outcome: 'rejected', provider: 'novu', safeCode: 'NOVU_SUBSCRIBER_HTTP_400' }, 'novu-subscriber-email-clear-v1',
      'definitive_failure', 'NOVU_SUBSCRIBER_HTTP_400'],
  ] as const)('records a %s operation per attempt with no email-derived value', async (operation, result, workflow, outcome, safeCode) => {
    const { repository, calls } = repositoryWith(() => ({ rows: [] }));
    await repository.recordSubscriberOperation(event, operation, result, 3);
    expect(calls).toHaveLength(1);
    expect(calls[0].text).toMatch(/insert into notification\.delivery_attempts/);
    expect(calls[0].text).toMatch(/on conflict \(idempotency_key, provider\) do nothing/);
    expect(calls[0].values).toEqual([event.id, sha256(`${workflow}\u001f${event.id}\u001f3`), workflow, 'email', 'novu',
      outcome, safeCode, event.correlationId]);
  });
});

describe('subscriber sync startup privilege', () => {
  it('passes when the 0095 lookup exists and the login may execute it', async () => {
    const { repository, calls, ended } = repositoryWith(() => ({ rows: [{ executable: true }] }));
    await expect(repository.verifySubscriberSyncPrivilege()).resolves.toBeUndefined();
    expect(calls[0].text).toMatch(/to_regprocedure\('integration\.notification_recipient_for_claim\(uuid,uuid,uuid\)'\)/);
    expect(calls[0].text).toMatch(/has_function_privilege\(current_user,/);
    expect(ended()).toBe(0);
  });

  it.each([[false], [null]])('refuses and closes the pool when the answer is %s', async (executable) => {
    const { repository, ended } = repositoryWith(() => ({ rows: [{ executable }] }));
    await expect(repository.verifySubscriberSyncPrivilege()).rejects.toThrow('NOTIFICATION_RECIPIENT_LOOKUP_NOT_EXECUTABLE');
    expect(ended()).toBe(1);
  });
});
