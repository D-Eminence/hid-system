import { createHmac, randomBytes } from 'node:crypto';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment, parseOfflineEscrowKeys, resetEnvironmentForTests } from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import { ESCROW_LIMIT, ESCROW_SALT, OfflineService, deriveEscrowKey, type EscrowConfiguration } from './offline.service';

// Throwaway secrets, generated per run; no key material is committed.
const SECRET_1 = randomBytes(32);
const SECRET_2 = randomBytes(32);
const VAULT = '70000000-0000-4000-8000-000000000001';
const OTHER_VAULT = '70000000-0000-4000-8000-000000000002';

const contextFor = (accountId: string, membershipId = '40000000-0000-4000-8000-000000000001',
  facilityId = '30000000-0000-4000-8000-000000000001') => ({
  correlationId: 'correlation-offline-0001', facilityId, membershipId, purposeOfUse: 'direct-care',
  actor: { kind: 'staff', id: `staff:${accountId}`, subject: `staff:${accountId}`, accountId, roles: ['clinician'],
    permissions: ['ehr.encounter.read'], facilityIds: [facilityId], facilities: [], authenticationMethod: 'local',
    facility: { id: facilityId, membershipId, organizationId: '50000000-0000-4000-8000-000000000001', name: 'Demo Hospital',
      roles: ['clinician'], permissions: ['ehr.encounter.read'], isPrimary: true } } }) as DataAccessContext;
const ME = contextFor('20000000-0000-4000-8000-0000000000a1');
const COLLEAGUE = contextFor('20000000-0000-4000-8000-0000000000a2', '40000000-0000-4000-8000-000000000002');

const enabled: EscrowConfiguration = { enabled: true, keys: new Map([[1, SECRET_1], [2, SECRET_2]]) };

/** RFC 5869 written out with HMAC, independent of node's hkdfSync. */
function rfc5869(ikm: Buffer, salt: string, info: string): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([Buffer.from(info, 'utf8'), Buffer.from([1])])).digest();
}

function service() {
  const audit = { record: jest.fn(async () => undefined), recordWithClient: jest.fn(async () => undefined) };
  return { offline: new OfflineService({} as DatabaseService, audit as unknown as AuditService), audit };
}

async function refusal(run: Promise<unknown>): Promise<DomainProblem> {
  const caught = await run.then(() => undefined, (error: unknown) => error);
  expect(caught).toBeInstanceOf(DomainProblem);
  return caught as DomainProblem;
}

describe('escrow key derivation (§2.5)', () => {
  it('is HKDF-SHA256 over the secret with the contract salt and account|membership|facility|vault info', () => {
    const info = `${ME.actor.accountId}|${ME.membershipId}|${ME.facilityId}|${VAULT}`;
    expect(deriveEscrowKey(SECRET_1, ME.actor.accountId, ME.membershipId, ME.facilityId, VAULT))
      .toEqual(rfc5869(SECRET_1, ESCROW_SALT, info));
    expect(ESCROW_SALT).toBe('hid-offline-escrow/v1');
  });

  it('gives the same 32 bytes for the same input and different ones for another vault, account or secret', async () => {
    const { offline } = service();
    const first = await offline.issueEscrowKey(ME, { vaultId: VAULT, keyVersion: 1 }, enabled);
    const again = await offline.issueEscrowKey(ME, { vaultId: VAULT.toUpperCase(), keyVersion: 1 }, enabled);
    const otherVault = await offline.issueEscrowKey(ME, { vaultId: OTHER_VAULT, keyVersion: 1 }, enabled);
    const otherAccount = await offline.issueEscrowKey(COLLEAGUE, { vaultId: VAULT, keyVersion: 1 }, enabled);
    const otherVersion = await offline.issueEscrowKey(ME, { vaultId: VAULT, keyVersion: 2 }, enabled);
    expect(Buffer.from(first.key, 'base64url')).toHaveLength(32);
    expect(again.key).toBe(first.key);
    expect(new Set([first.key, otherVault.key, otherAccount.key, otherVersion.key]).size).toBe(4);
  });

  it('issues the highest version when none is asked for, and 404 for an unknown version', async () => {
    const { offline } = service();
    expect(await offline.issueEscrowKey(ME, { vaultId: VAULT, keyVersion: null }, enabled))
      .toMatchObject({ keyVersion: 2, algorithm: 'HKDF-SHA256' });
    const problem = await refusal(offline.issueEscrowKey(ME, { vaultId: VAULT, keyVersion: 3 }, enabled));
    expect([problem.getStatus(), problem.code]).toEqual([404, 'OFFLINE_ESCROW_VERSION_UNKNOWN']);
  });

  it('answers 503 OFFLINE_ESCROW_UNAVAILABLE when off or without keys, and audits nothing', async () => {
    const { offline, audit } = service();
    for (const configuration of [{ enabled: false, keys: enabled.keys }, { enabled: true, keys: undefined }]) {
      const problem = await refusal(offline.issueEscrowKey(ME, { vaultId: VAULT }, configuration));
      expect([problem.getStatus(), problem.code]).toEqual([503, 'OFFLINE_ESCROW_UNAVAILABLE']);
    }
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('allows 30 issues per account per hour, then 429 until the hour has passed', async () => {
    const { offline } = service();
    const start = Date.parse('2026-10-29T10:00:00.000Z');
    for (let n = 0; n < ESCROW_LIMIT; n += 1) {
      await offline.issueEscrowKey(ME, { vaultId: VAULT }, enabled, start + n * 1000);
    }
    const problem = await refusal(offline.issueEscrowKey(ME, { vaultId: VAULT }, enabled, start + 60_000));
    expect([problem.getStatus(), problem.code]).toEqual([429, 'OFFLINE_ESCROW_RATE_LIMITED']);
    await expect(offline.issueEscrowKey(COLLEAGUE, { vaultId: VAULT }, enabled, start + 60_000)).resolves.toBeDefined();
    await expect(offline.issueEscrowKey(ME, { vaultId: VAULT }, enabled, start + 3600_000 + 1)).resolves.toBeDefined();
  });

  it('refuses a context without a membership', async () => {
    const { offline } = service();
    const problem = await refusal(offline.issueEscrowKey({ ...ME, membershipId: '' }, { vaultId: VAULT }, enabled));
    expect([problem.getStatus(), problem.code]).toEqual([403, 'STAFF_FACILITY_REQUIRED']);
  });
});

describe('OFFLINE_ESCROW_KEYS', () => {
  const original = { ...process.env };
  afterEach(() => {
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  it('parses version to 32-byte base64url secrets and refuses any malformed entry', () => {
    const good = SECRET_1.toString('base64url');
    expect(parseOfflineEscrowKeys(JSON.stringify({ 1: good, 2: SECRET_2.toString('base64url') }))?.get(1)).toEqual(SECRET_1);
    for (const value of [undefined, '', 'not json', '[]', '{}', JSON.stringify({ 0: good }), JSON.stringify({ v1: good }),
      JSON.stringify({ 1: good.slice(1) }), JSON.stringify({ 1: `${good}A` }), JSON.stringify({ 1: good, 2: 'short' }),
      JSON.stringify({ 1: 7 }), JSON.stringify({ 1: randomBytes(31).toString('base64url') })]) {
      expect(parseOfflineEscrowKeys(value)).toBeUndefined();
    }
  });

  it('is off by default and refuses to start enabled without a valid key set', () => {
    Object.assign(process.env, { NODE_ENV: 'test', DATABASE_URL: 'postgresql://synthetic:test@localhost/hid',
      CORS_ORIGINS: 'http://localhost', STORAGE_MODE: 'disabled' });
    delete process.env.OFFLINE_ESCROW_ENABLED;
    delete process.env.OFFLINE_ESCROW_KEYS;
    resetEnvironmentForTests();
    expect(getEnvironment().OFFLINE_ESCROW_ENABLED).toBe(false);
    process.env.OFFLINE_ESCROW_ENABLED = 'true';
    process.env.OFFLINE_ESCROW_KEYS = '{"1":"too-short"}';
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/OFFLINE_ESCROW_KEYS/);
  });
});
