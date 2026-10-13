jest.mock('argon2', () => ({ argon2id: 2, hash: jest.fn().mockResolvedValue('$argon2id$test-password-hash') }));
import express from 'express';
import type { PoolClient } from 'pg';
import request from 'supertest';
import { DomainProblem } from '../common/problem';
import * as environment from '../config/environment';
import type { DatabaseService } from '../database/database.service';
import type { NotificationOtpClient } from './notification-otp.client';
import { OtpService } from './otp.service';

// Recovery start's per-network limit (IP-1). In AWS every request reaches
// Identity from the gateway task, and the gateway's X-Forwarded-For is the
// client address the Cloudflare Worker supplied (X-Real-IP, applied by
// the gateway's realip module). Identity trusts the VPC (TRUST_PROXY_CIDRS),
// so request.ip is the client. When the edge supplied no client address,
// request.ip is a VPC address (the load balancer), shared by every client.
const vpc = '10.40.0.0/16';

interface Bucket { scope: string; bucket: string }

function recordingDatabase() {
  const buckets: Bucket[] = [];
  const client = { query: jest.fn(async (sql: string, values: readonly unknown[] = []) => {
    if (sql.includes('insert into auth.otp_rate_limits')) buckets.push({ scope: String(values[0]), bucket: String(values[1]) });
    return { rows: [], rowCount: 0 };
  }) } as unknown as PoolClient;
  const database = {
    withSystemTransaction: jest.fn(async (_correlation: string, work: (value: PoolClient) => Promise<unknown>) => work(client)),
    query: jest.fn().mockResolvedValue({ rows: [] }),
  } as unknown as DatabaseService;
  const notification = { deliver: jest.fn().mockResolvedValue({ outcome: 'accepted', provider: 'ses' }) };
  const ipBuckets = () => buckets.filter(({ scope }) => scope === 'ip').map(({ bucket }) => bucket);
  return { database, notification: notification as unknown as NotificationOtpClient, ipBuckets };
}

describe('recovery start keys its IP limit on the real client network', () => {
  const original = { ...process.env };

  function useEnvironment(overrides: Partial<environment.Environment>) {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://www.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
      OTP_HMAC_KEY_B64: Buffer.alloc(32, 7).toString('base64'),
    });
    environment.resetEnvironmentForTests();
    const base = environment.getEnvironment();
    jest.spyOn(environment, 'getEnvironment').mockReturnValue({ ...base, ...overrides });
  }

  const start = (service: OtpService, remoteIp: string | undefined, identifier = 'nobody@example.test') =>
    service.start({ identifier, purpose: 'PASSWORD_RESET', audience: 'patient', remoteIp, correlationId: 'otp-client-network-0001' });

  afterEach(() => {
    jest.restoreAllMocks();
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    environment.resetEnvironmentForTests();
  });

  it('in production, refuses a start with no client address or a proxy address, before counting anything', async () => {
    useEnvironment({ NODE_ENV: 'production', TRUST_PROXY_CIDRS: vpc });
    const store = recordingDatabase();
    const service = new OtpService(store.database, store.notification);
    for (const remoteIp of [undefined, '', 'not-an-address', '10.40.1.10', '10.40.255.254', '::ffff:10.40.3.4']) {
      await expect(start(service, remoteIp)).rejects.toMatchObject({ status: 503, code: 'OTP_RATE_LIMIT_UNAVAILABLE' });
    }
    expect(store.database.withSystemTransaction).not.toHaveBeenCalled();
    expect(store.notification.deliver).not.toHaveBeenCalled();
    await expect(start(service, '10.41.0.1')).resolves.toMatchObject({ accepted: true });
  });

  it('refuses a start with no usable client address in every environment', async () => {
    useEnvironment({ NODE_ENV: 'development', TRUST_PROXY_CIDRS: undefined });
    const store = recordingDatabase();
    const service = new OtpService(store.database, store.notification);
    for (const remoteIp of [undefined, 'not-an-address']) {
      await expect(start(service, remoteIp)).rejects.toMatchObject({ status: 503, code: 'OTP_RATE_LIMIT_UNAVAILABLE' });
    }
    // Outside production a private address is an ordinary client (local runs).
    await expect(start(service, '10.40.1.10')).resolves.toMatchObject({ accepted: true });
  });

  it('gives two clients two buckets and one IPv6 /64 one bucket', async () => {
    useEnvironment({ NODE_ENV: 'production', TRUST_PROXY_CIDRS: vpc });
    const store = recordingDatabase();
    const service = new OtpService(store.database, store.notification);
    for (const remoteIp of ['198.51.100.1', '198.51.100.2', '::ffff:198.51.100.2',
      '2001:db8:1:2::10', '2001:db8:1:2:abcd:ef01:2345:6789', '2001:db8:1:3::10']) {
      await start(service, remoteIp);
    }
    const [first, second, mapped, sixA, sixB, sixC] = store.ipBuckets();
    expect(first).not.toBe(second);
    expect(mapped).toBe(second);
    expect(sixA).toBe(sixB);
    expect(sixC).not.toBe(sixA);
    expect(new Set([first, second, sixA, sixC]).size).toBe(4);
  });

  it('separates two clients that arrive through one proxy hop, and refuses the hop itself', async () => {
    useEnvironment({ NODE_ENV: 'production', TRUST_PROXY_CIDRS: '127.0.0.0/8,::1/128' });
    const store = recordingDatabase();
    const service = new OtpService(store.database, store.notification);
    // The application's proxy trust, as main.ts sets it from TRUST_PROXY_CIDRS.
    const app = express();
    app.set('trust proxy', environment.getEnvironment().TRUST_PROXY_CIDRS!.split(',').map((cidr) => cidr.trim()));
    app.post('/start', (req, res) => {
      start(service, req.ip).then(() => res.status(202).json({ accepted: true }), (error: unknown) => {
        const problem = error instanceof DomainProblem ? error : new DomainProblem(500, 'UNEXPECTED', 'Unexpected');
        res.status(problem.getStatus()).json({ code: problem.code });
      });
    });
    // The socket peer is the gateway (loopback here, the VPC in AWS); the one
    // X-Forwarded-For entry is what the gateway sends.
    for (const client of ['198.51.100.31', '198.51.100.32']) {
      await request(app).post('/start').set('X-Forwarded-For', client).expect(202);
    }
    const [one, two] = store.ipBuckets();
    expect(one).toBeDefined();
    expect(one).not.toBe(two);
    // Without the edge's client address the gateway forwards the load
    // balancer, a trusted address: every client would share its bucket.
    const shared = await request(app).post('/start').set('X-Forwarded-For', '127.0.0.9');
    expect(shared.status).toBe(503);
    expect(JSON.stringify(shared.body)).toContain('OTP_RATE_LIMIT_UNAVAILABLE');
    const direct = await request(app).post('/start');
    expect(direct.status).toBe(503);
    expect(store.ipBuckets()).toHaveLength(2);
  });
});
