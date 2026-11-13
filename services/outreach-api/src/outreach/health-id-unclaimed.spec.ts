import { IdentityApiClient, IdentityApiProblem, OutreachApiClient, OutreachApiProblem } from '@hid/api-client';
import { REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext, HidRequest } from '../common/request-context';
import { IdentityService } from '../identity/identity.service';
import type { WorkloadCredentialsService } from '../auth/workload-credentials.service';
import { resetEnvironmentForTests } from '../config/environment';
import { requireEmptyHealthIdBody } from './dto/health-id.dto';
import { OutreachController } from './outreach.controller';
import { OutreachService } from './outreach.service';

// A Health ID created at the outreach for a person with no contact (0120) in
// outreach-api: the route, the proxy to Identity, healthIdStatus and the
// client. Synthetic people, Health IDs and claim codes only.
const caseId = '123e4567-e89b-42d3-a456-426614174004';
const facilityId = '123e4567-e89b-42d3-a456-426614174001';
const context = {
  correlationId: 'health-id-unclaimed-test', facilityId, membershipId: '123e4567-e89b-42d3-a456-426614174009',
  purposeOfUse: 'direct-care', userCookie: 'hid_access=a; hid_access_csrf=c', csrfToken: 'c',
  origin: 'https://outreach.healthidentitydirectory.com',
  actor: { id: 'staff:v', subject: 'staff:v', accountId: 'a', roles: [], permissions: ['outreach.registration.write'],
    facilityIds: [facilityId], facilities: [], authenticationMethod: 'local' },
} as unknown as DataAccessContext;
const row = { id: caseId, facility_id: facilityId, campaign_id: null, local_command_id: caseId,
  temporary_patient_id: 'tmp_1', status: 'identity_resolution_pending', full_name: 'Bola Person', sex: 'male',
  age_years: 41, phone: null, operational_notes: null, resolved_patient_id: null, resolution_kind: null,
  row_version: '1', created_at: new Date('2026-11-14T08:00:00Z'), updated_at: new Date('2026-11-14T08:00:00Z') };
const created = { healthId: 'HID-QQ7RR6', claimCode: 'K7MP2QXW', claimExpiresAt: '2027-05-13T08:00:00.000Z' };

function problem(promise: Promise<unknown>): Promise<DomainProblem> {
  return promise.then(() => { throw new Error('expected a refusal'); }, (error: unknown) => {
    if (error instanceof DomainProblem) return error;
    throw error;
  });
}

describe('Outreach Health ID with no contact (0120)', () => {
  describe('route', () => {
    const outreach = { createUnverifiedHealthId: jest.fn().mockResolvedValue({}) };
    const controller = new OutreachController(outreach as unknown as OutreachService);
    const request = (key?: string) => ({ correlationId: 'c', facilityId,
      actor: { ...context.actor, facility: { id: facilityId, membershipId: context.membershipId } },
      header: (name: string) => (name === 'idempotency-key' ? key : undefined) }) as unknown as HidRequest;
    beforeEach(() => outreach.createUnverifiedHealthId.mockClear());

    it('needs outreach.registration.write and an Idempotency-Key', () => {
      expect(Reflect.getMetadata(REQUIRED_PERMISSIONS, OutreachController.prototype.createUnverifiedHealthId))
        .toEqual(['outreach.registration.write']);
      expect(() => controller.createUnverifiedHealthId(caseId, {}, request()))
        .toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REQUIRED' }));
      expect(outreach.createUnverifiedHealthId).not.toHaveBeenCalled();
    });

    it('takes {} (or no body) and refuses any field 400 VALIDATION_FAILED, before calling Identity', async () => {
      await controller.createUnverifiedHealthId(caseId, {}, request('unclaimed-key-0000001'));
      await controller.createUnverifiedHealthId(caseId, undefined, request('unclaimed-key-0000002'));
      expect(outreach.createUnverifiedHealthId).toHaveBeenCalledTimes(2);
      expect(outreach.createUnverifiedHealthId).toHaveBeenCalledWith(caseId, expect.anything());
      outreach.createUnverifiedHealthId.mockClear();
      for (const body of [{ email: 'a@b.co' }, { phone: '08012345678' }, [], 'x']) {
        let refusal: unknown;
        try { controller.createUnverifiedHealthId(caseId, body, request('unclaimed-key-0000003')); } catch (error) { refusal = error; }
        expect(refusal).toBeInstanceOf(DomainProblem);
        expect((refusal as DomainProblem).getStatus()).toBe(400);
        expect((refusal as DomainProblem).code).toBe('VALIDATION_FAILED');
      }
      expect(outreach.createUnverifiedHealthId).not.toHaveBeenCalled();
      try { requireEmptyHealthIdBody({ email: 'a@b.co' }); } catch (error) {
        expect((error as DomainProblem).errors).toEqual([{ field: 'email', messages: ['property email should not exist'] }]);
      }
    });

    it('answers no-store', () => {
      expect(Reflect.getMetadata('__headers__', OutreachController.prototype.createUnverifiedHealthId))
        .toEqual([{ name: 'Cache-Control', value: 'no-store' }]);
    });
  });

  describe('OutreachService', () => {
    const identity = { createUnclaimedHealthId: jest.fn() };
    const query = jest.fn();
    const database = { withTransaction: jest.fn(async (_context: unknown, operation: (c: unknown) => unknown) =>
      operation({ query })) };
    const audit = { recordWithClient: jest.fn() };
    const service = () => new OutreachService(database as never, audit as never, identity as never);
    beforeEach(() => { query.mockReset(); identity.createUnclaimedHealthId.mockReset(); audit.recordWithClient.mockReset(); });

    it('answers 201 the Health ID, the claim code, its expiry and the registration as GET returns it', async () => {
      identity.createUnclaimedHealthId.mockResolvedValue(created);
      query.mockResolvedValueOnce({ rows: [row] })
        .mockResolvedValueOnce({ rows: [{ registration_case_id: caseId, hid_code: created.healthId, created_via: 'unclaimed' }] });
      await expect(service().createUnverifiedHealthId(caseId, context)).resolves.toEqual({ ...created,
        registration: expect.objectContaining({ id: caseId, status: 'identity_resolution_pending',
          healthId: created.healthId, healthIdCreatedByOutreach: true, healthIdStatus: 'unclaimed' }) });
      expect(identity.createUnclaimedHealthId).toHaveBeenCalledTimes(1);
      expect(identity.createUnclaimedHealthId).toHaveBeenCalledWith(caseId, context);
      // The claim code is never written, audited or sent to the database here
      // (the registration read is audited as GET's is: its id only).
      expect(audit.recordWithClient).toHaveBeenCalledTimes(1);
      expect(audit.recordWithClient.mock.calls[0]!.slice(2)).toEqual(['outreach.registration-case.read', caseId, undefined]);
      expect(JSON.stringify([query.mock.calls, audit.recordWithClient.mock.calls])).not.toContain(created.claimCode);
    });

    it('a retry answers 409 OUTREACH_HEALTH_ID_ALREADY_CREATED with the Health ID only, never the claim code', async () => {
      identity.createUnclaimedHealthId.mockRejectedValue(new DomainProblem(409, 'OUTREACH_HEALTH_ID_ALREADY_CREATED',
        'A Health ID was already created for this person.', undefined, { extensions: { healthId: created.healthId } }));
      const refusal = await problem(service().createUnverifiedHealthId(caseId, context));
      expect(refusal.getStatus()).toBe(409);
      expect(refusal.problemOptions.extensions).toEqual({ healthId: created.healthId });
      expect(query).not.toHaveBeenCalled();
    });
  });

  describe('IdentityService over the client', () => {
    const original = { ...process.env };
    beforeEach(() => {
      Object.assign(process.env, { NODE_ENV: 'test', IDENTITY_API_URL: 'http://identity.test',
        DATABASE_URL: 'postgresql://test:test@localhost/hid', CORS_ORIGINS: 'https://outreach.test',
        OUTREACH_IDENTITY_INTERNAL_SERVICE_TOKEN: 'outreach-local-test-secret-0123456789abcdef' });
      resetEnvironmentForTests();
    });
    afterEach(() => {
      for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
      Object.assign(process.env, original);
      resetEnvironmentForTests();
      jest.restoreAllMocks();
    });
    const identityService = () =>
      new IdentityService({ headers: jest.fn().mockResolvedValue({}) } as unknown as WorkloadCredentialsService);

    it('forwards the volunteer\'s sign-in once and answers Identity\'s result', async () => {
      const create = jest.spyOn(IdentityApiClient.prototype, 'outreachHealthIdCreateUnclaimed').mockResolvedValue(created);
      await expect(identityService().createUnclaimedHealthId(caseId, context)).resolves.toEqual(created);
      expect(create).toHaveBeenCalledTimes(1);
      expect(create).toHaveBeenCalledWith({ caseId }, expect.objectContaining({ cookie: context.userCookie, csrfToken: 'c',
        origin: context.origin, facilityId, purposeOfUse: 'direct-care' }));
    });

    it.each([
      [409, 'OUTREACH_HEALTH_ID_ALREADY_CREATED', { healthId: 'HID-QQ7RR6' }],
      [409, 'OUTREACH_HEALTH_ID_PHONE_TAKEN', {}], [409, 'OUTREACH_REGISTRATION_REDACTED', {}],
      [404, 'OUTREACH_REGISTRATION_NOT_FOUND', {}], [403, 'OUTREACH_HEALTH_ID_NOT_AVAILABLE', {}],
      [422, 'OUTREACH_HEALTH_ID_UNDER_18', {}], [422, 'OUTREACH_HEALTH_ID_PHONE_INVALID', {}],
      [423, 'OUTREACH_ORGANISER_SUSPENDED', {}],
    ])('maps Identity\'s %d %s back verbatim', async (status, code, extra) => {
      jest.spyOn(IdentityApiClient.prototype, 'outreachHealthIdCreateUnclaimed')
        .mockRejectedValue(new IdentityApiProblem(status, { code, detail: 'Plain words.', ...extra }));
      const refusal = await problem(identityService().createUnclaimedHealthId(caseId, context));
      expect([refusal.getStatus(), refusal.code, refusal.message]).toEqual([status, code, 'Plain words.']);
      expect(refusal.problemOptions.extensions).toEqual(Object.keys(extra).length ? extra : undefined);
    });

    it('answers 503 with its plain words when Identity fails or does not answer', async () => {
      for (const error of [new IdentityApiProblem(503, { code: 'OUTREACH_HEALTH_ID_UNAVAILABLE' }), new Error('timeout')]) {
        jest.spyOn(IdentityApiClient.prototype, 'outreachHealthIdCreateUnclaimed').mockRejectedValueOnce(error);
        const refusal = await problem(identityService().createUnclaimedHealthId(caseId, context));
        expect(refusal).toMatchObject({ code: 'OUTREACH_HEALTH_ID_UNAVAILABLE',
          message: "The Health ID couldn't be created right now. Try again in a few minutes.",
          problemOptions: { exposeDetail: true } });
      }
    });
  });

  describe('client transport (api-client)', () => {
    const originalFetch = global.fetch;
    afterEach(() => { global.fetch = originalFetch; });
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body),
      { status, headers: { 'content-type': 'application/json' } });

    it('IdentityApiClient posts create-unclaimed once, even on a 503, with no Idempotency-Key', async () => {
      const fetchMock = jest.fn().mockResolvedValue(json(503, { code: 'OUTREACH_HEALTH_ID_UNAVAILABLE' }));
      global.fetch = fetchMock;
      const client = new IdentityApiClient({ baseUrl: 'https://identity.test', caller: 'outreach-api',
        workloadHeaders: async () => ({ 'x-hid-service-token': 't' }) });
      const delegated = { correlationId: 'c', facilityId, cookie: 'hid_access=a', csrfToken: 'c', origin: 'https://o.test',
        idempotencyKey: 'should-not-be-sent-123' };
      await expect(client.outreachHealthIdCreateUnclaimed({ caseId }, delegated)).rejects.toMatchObject({ status: 503 });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe('https://identity.test/api/v1/identity/outreach/health-id/create-unclaimed');
      expect(JSON.parse(String(init.body))).toEqual({ caseId });
      expect(init.headers).toMatchObject({ 'x-hid-internal-caller': 'outreach-api', 'x-facility-id': facilityId,
        'x-purpose-of-use': 'direct-care', cookie: 'hid_access=a', 'x-csrf-token': 'c', origin: 'https://o.test' });
      expect(init.headers).not.toHaveProperty('idempotency-key');
      fetchMock.mockResolvedValue(json(201, created));
      await expect(client.outreachHealthIdCreateUnclaimed({ caseId }, { correlationId: 'c', facilityId }))
        .resolves.toEqual(created);
    });

    it('IdentityApiClient refuses a malformed answer 502 without keeping it', async () => {
      global.fetch = jest.fn().mockResolvedValue(json(201, { healthId: 'HID-QQ7RR6', claimCode: 'k7mp2qxw!',
        claimExpiresAt: '2027-05-13T08:00:00.000Z' }));
      const client = new IdentityApiClient({ baseUrl: 'https://identity.test', caller: 'outreach-api',
        workloadHeaders: async () => ({}) });
      const refusal = await client.outreachHealthIdCreateUnclaimed({ caseId }, { correlationId: 'c', facilityId })
        .catch((error: unknown) => error);
      expect(refusal).toMatchObject({ status: 502, payload: null });
    });

    it('OutreachApiClient.createUnverifiedHealthId posts {} with the key, never retried, healthId on a 409', async () => {
      const fetchMock = jest.fn().mockResolvedValue(json(503, { code: 'OUTREACH_HEALTH_ID_UNAVAILABLE', detail: 'x' }));
      global.fetch = fetchMock;
      const client = new OutreachApiClient({ baseUrl: 'https://outreach.test' });
      const outreachContext = { correlationId: 'c', facilityId, purposeOfUse: 'direct-care' as const, csrfToken: 'c' };
      await expect(client.createUnverifiedHealthId(caseId, outreachContext, 'unclaimed-key-0000001'))
        .rejects.toBeInstanceOf(OutreachApiProblem);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`https://outreach.test/api/v1/outreach/registration-cases/${caseId}/health-id/create-unverified`);
      expect(init.method).toBe('POST');
      expect(JSON.parse(String(init.body))).toEqual({});
      expect(init.headers).toMatchObject({ 'idempotency-key': 'unclaimed-key-0000001', 'x-facility-id': facilityId,
        'x-csrf-token': 'c' });
      fetchMock.mockResolvedValue(json(409, { code: 'OUTREACH_HEALTH_ID_ALREADY_CREATED', detail: 'd', healthId: 'HID-QQ7RR6' }));
      await expect(client.createUnverifiedHealthId(caseId, outreachContext, 'unclaimed-key-0000001'))
        .rejects.toMatchObject({ status: 409, code: 'OUTREACH_HEALTH_ID_ALREADY_CREATED', healthId: 'HID-QQ7RR6' });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
