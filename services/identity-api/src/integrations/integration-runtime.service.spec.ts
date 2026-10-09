import { DomainProblem } from '../common/problem';
import type { DatabaseService } from '../database/database.service';
import { IntegrationRuntimeService } from './integration-runtime.service';

function setup(states: Record<string, { enabled: boolean; configuration?: Record<string, string> }>,
  route = { active_provider: 'termii', fallback_provider: 'brevo' as string | null }) {
  const query = jest.fn(async (sql: string, values: unknown[]) => {
    if (sql.includes('integration_runtime_route')) return { rows: [route] };
    if (sql.includes('integration_runtime_provider')) {
      const state = states[String(values[0])];
      return { rows: state ? [{ enabled: state.enabled, configuration: state.configuration ?? {} }] : [] };
    }
    return { rows: [] };
  });
  return { service: new IntegrationRuntimeService({ query } as unknown as DatabaseService), query };
}

describe('provider runtime decisions', () => {
  it('blocks QoreID before any outbound verification when paused', async () => {
    const { service } = setup({ qoreid: { enabled: false } });
    await expect(service.assertAvailable('qoreid', 'patient_nin'))
      .rejects.toMatchObject({ code: 'INTEGRATION_PAUSED', status: 503 });
    await expect(service.assertAvailable('qoreid', 'provider_cac'))
      .rejects.toMatchObject({ code: 'INTEGRATION_PAUSED', status: 503 });
  });

  it('uses only the configured fallback when Termii is paused', async () => {
    const { service } = setup({ termii: { enabled: false },
      brevo: { enabled: true, configuration: { smsSender: 'HID' } } });
    await expect(service.deliveryPlan('sms')).resolves.toEqual({ capability: 'sms',
      primary: 'brevo', fallback: null, configuration: { brevo: { smsSender: 'HID' } } });
  });

  it('fails closed if both primary and fallback are paused', async () => {
    const { service } = setup({ termii: { enabled: false }, brevo: { enabled: false } });
    await expect(service.deliveryPlan('sms')).rejects.toMatchObject({ code: 'INTEGRATION_UNAVAILABLE', status: 503 });
  });

  it('sends the exact configured primary and fallback plan', async () => {
    const { service } = setup({ termii: { enabled: true, configuration: { channel: 'generic' } },
      brevo: { enabled: true, configuration: { smsSender: 'HID' } } });
    await expect(service.deliveryPlan('sms')).resolves.toEqual({ capability: 'sms',
      primary: 'termii', fallback: 'brevo', configuration: {
        termii: { channel: 'generic' }, brevo: { smsSender: 'HID' },
      } });
  });

  it('does not expose database errors', async () => {
    const query = jest.fn().mockRejectedValue(new Error('sensitive database location'));
    const service = new IntegrationRuntimeService({ query } as unknown as DatabaseService);
    await expect(service.deliveryPlan('sms')).rejects.toEqual(
      new DomainProblem(503, 'INTEGRATION_UNAVAILABLE', 'Delivery provider is temporarily unavailable'));
  });

  it('binds a patient session and sends only canonical scope identifiers to the quota command', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [] });
    const database = { withSystemTransaction: jest.fn(async (_correlation, work) => work({ query })) };
    const service = new IntegrationRuntimeService(database as unknown as DatabaseService);
    await service.consumePatientQuota('quota-test-correlation', 'patient:one',
      'a0000000-0000-4000-8000-000000000003');
    expect(query.mock.calls[0]?.[1]).toEqual(['patient:one']);
    expect(query.mock.calls[1]?.[1]).toEqual(['patient_nin', null,
      'a0000000-0000-4000-8000-000000000003', null, null]);
  });

  it('charges an accountless CAC lookup only by application and keyed network digest', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ admitted: true }] });
    const database = { withSystemTransaction: jest.fn(async (_correlation, work) => work({ query })) };
    const service = new IntegrationRuntimeService(database as unknown as DatabaseService);
    await service.consumeSelfServiceCacQuota('self-service-correlation',
      'a0000000-0000-4000-8000-000000000004', 'a'.repeat(64));
    expect(database.withSystemTransaction).toHaveBeenCalledWith('self-service-correlation', expect.any(Function));
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]?.[0]).toContain('platform.consume_self_service_cac_quota');
    expect(query.mock.calls[0]?.[0]).not.toContain('consume_qoreid_quota');
    expect(query.mock.calls[0]?.[1]).toEqual(['a0000000-0000-4000-8000-000000000004', 'a'.repeat(64)]);
  });

  it('refuses a denied accountless CAC lookup with the generic quota problem', async () => {
    const outcomes: Array<[unknown, number, string]> = [
      [{ rows: [{ admitted: false }] }, 429, 'VERIFICATION_QUOTA_EXCEEDED'],
      [{ rows: [] }, 503, 'VERIFICATION_QUOTA_UNAVAILABLE'],
      [{ code: '42501', message: 'private SQL diagnostics' }, 403, 'PERMISSION_DENIED'],
      [new Error('private connection detail'), 503, 'VERIFICATION_QUOTA_UNAVAILABLE'],
    ];
    for (const [outcome, status, code] of outcomes) {
      const query = 'rows' in (outcome as object)
        ? jest.fn().mockResolvedValue(outcome) : jest.fn().mockRejectedValue(outcome);
      const database = { withSystemTransaction: jest.fn(async (_correlation, work) => work({ query })) };
      const service = new IntegrationRuntimeService(database as unknown as DatabaseService);
      const failure = await service.consumeSelfServiceCacQuota('self-service-correlation',
        'a0000000-0000-4000-8000-000000000004', 'a'.repeat(64)).catch((error) => error);
      expect(failure).toMatchObject({ status, code });
      expect(JSON.stringify(failure)).not.toMatch(/private|network|application_day|exhausted/i);
    }
  });

  it('maps a database quota denial to 429 without leaking database diagnostics', async () => {
    const query = jest.fn().mockRejectedValue({ code: 'P4290', message: 'private SQL diagnostics' });
    const database = { withTransaction: jest.fn(async (_context, work) => work({ query })) };
    const service = new IntegrationRuntimeService(database as unknown as DatabaseService);
    const failure = await service.consumeQuota({} as never, 'application_cac',
      'a0000000-0000-4000-8000-000000000001').catch((error) => error);
    expect(failure).toMatchObject({ status: 429, code: 'VERIFICATION_QUOTA_EXCEEDED' });
    expect(failure.message).not.toContain('private SQL diagnostics');
  });

  it('fails closed when the quota database is unavailable', async () => {
    const database = { withTransaction: jest.fn().mockRejectedValue(new Error('private connection detail')) };
    const service = new IntegrationRuntimeService(database as unknown as DatabaseService);
    await expect(service.consumeQuota({} as never, 'existing_cac',
      'a0000000-0000-4000-8000-000000000001'))
      .rejects.toMatchObject({ status: 503, code: 'VERIFICATION_QUOTA_UNAVAILABLE' });
  });
});
