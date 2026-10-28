import { createHash, createPublicKey, generateKeyPairSync, verify } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BadRequestException, ConflictException, Logger, NotFoundException, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import type { Request } from 'express';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import type { WorkloadAuthService } from '../auth/workload-auth.service';
import {
  classifyPushResponse, pushRequest, retryAfterSeconds, VAPID_TOKEN_SECONDS, WEB_PUSH_HEADERS, WEB_PUSH_SEND_TIMEOUT_MS,
  WebPushProvider,
  webPushConfiguration, webPushKeyId, webPushServiceOf, type WebPushTransport,
} from '../providers/web-push';
import { DeliverWebPushDto } from './dto/deliver-web-push.dto';
import { NotificationController } from './notification.controller';
import type { NotificationService } from './notification.service';

jest.mock('../auth/workload-auth.service', () => ({ WorkloadAuthService: class WorkloadAuthService {} }));

/** A synthetic VAPID key pair for tests; never real key material. */
function keyPair() {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')])
    .toString('base64url');
  return { publicKey, privateKey: jwk.d!, x: jwk.x!, y: jwk.y! };
}

const pair = keyPair();
const subject = 'mailto:support@healthidentitydirectory.com';
const endpoint = 'https://fcm.googleapis.com/fcm/send/eXaMpLe:APA91bHxSynthetic';
const key = 'web-push:6a1e0000-0000-4000-8000-000000000001:1761645600123';
const now = Date.parse('2026-10-28T10:00:00Z');

describe('Web push (B6, N1)', () => {
  const original = { ...process.env };
  function environment(overrides: Record<string, string | undefined> = {}): void {
    Object.assign(process.env, { NODE_ENV: 'test', NOTIFICATION_PROVIDER_MODE: 'test', HID_DEPLOYMENT_ENV: 'production',
      WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey, WEB_PUSH_SUBJECT: subject });
    for (const [name, value] of Object.entries(overrides)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    resetEnvironmentForTests();
  }
  beforeEach(() => { jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined); });
  afterEach(() => {
    jest.restoreAllMocks();
    for (const name of Object.keys(process.env)) if (!(name in original)) delete process.env[name];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });

  const answer = (status: number, headers: Record<string, string> = {}) => new Response(status === 204 ? null : 'push service body',
    { status, headers });
  function provider(transport?: WebPushTransport, clock: () => number = () => now) {
    return new WebPushProvider(transport, clock);
  }
  function controller(webPush?: WebPushProvider, authenticate = jest.fn().mockResolvedValue('local:identity-api')) {
    return new NotificationController({ authenticate } as unknown as WorkloadAuthService, {} as NotificationService, webPush);
  }
  const request = { header: () => 'identity-api' } as unknown as Request;
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });

  describe('configuration (D13)', () => {
    it('is on for a matching pair, with Identity\'s key id', () => {
      environment();
      const configuration = webPushConfiguration(getEnvironment());
      expect(configuration).toMatchObject({ on: true, applicationServerKey: pair.publicKey, subject,
        keyId: createHash('sha256').update(Buffer.from(pair.publicKey, 'base64url')).digest('hex').slice(0, 16) });
      expect(webPushKeyId(Buffer.from(pair.publicKey, 'base64url'))).toMatch(/^[0-9a-f]{16}$/);
    });

    it.each([
      ['missing', { WEB_PUSH_VAPID_PRIVATE_KEY: undefined }],
      ['missing', { WEB_PUSH_VAPID_PUBLIC_KEY: '' }],
      ['missing', { WEB_PUSH_SUBJECT: '  ' }],
      ['invalid_public_key', { WEB_PUSH_VAPID_PUBLIC_KEY: 'A'.repeat(87) }],
      ['invalid_public_key', { WEB_PUSH_VAPID_PUBLIC_KEY: pair.privateKey }],
      ['invalid_subject', { WEB_PUSH_SUBJECT: 'support@healthidentitydirectory.com' }],
      ['invalid_subject', { WEB_PUSH_SUBJECT: 'http://www.healthidentitydirectory.com' }],
      ['invalid_private_key', { WEB_PUSH_VAPID_PRIVATE_KEY: 'short' }],
      ['invalid_private_key', { WEB_PUSH_VAPID_PRIVATE_KEY: '+'.repeat(43) }],
      ['invalid_private_key', { WEB_PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32, 0xff).toString('base64url') }],
      ['invalid_private_key', { WEB_PUSH_VAPID_PRIVATE_KEY: Buffer.alloc(32, 0).toString('base64url') }],
      ['key_mismatch', { WEB_PUSH_VAPID_PRIVATE_KEY: keyPair().privateKey }],
    ])('is off (%s) and never throws for %j', (reason, overrides) => {
      environment(overrides);
      expect(() => getEnvironment()).not.toThrow();
      expect(webPushConfiguration(getEnvironment())).toEqual({ on: false, reason });
      expect(provider(jest.fn()).on).toBe(false);
    });

    it('is off while providers are disabled, or in test mode without a transport', () => {
      environment({ NOTIFICATION_PROVIDER_MODE: 'disabled' });
      expect([provider(jest.fn()).on, provider(jest.fn()).offReason]).toEqual([false, 'provider_disabled']);
      environment();
      expect([provider().on, provider().offReason]).toEqual([false, 'provider_disabled']);
      expect(provider(jest.fn()).on).toBe(true);
    });

    it('starts in production without the keys, and never puts a key in an error', () => {
      const production = { NODE_ENV: 'production', HID_DEPLOYMENT_ENV: 'staging', NOTIFICATION_PROVIDER_MODE: 'live',
        NOTIFICATION_DELIVERY_PROFILE: 'email-only', NOTIFICATION_WORKLOAD_IDENTITY_MODE: 'jwt',
        WORKLOAD_ISSUER_URL: 'https://issuer.example.test', WORKLOAD_JWKS_URL: 'https://issuer.example.test/jwks.json',
        IDENTITY_CALLER_SUBJECT: 'hid:staging:identity-api', AWS_REGION: 'af-south-1', SES_FROM_ADDRESS: 'security@example.test' };
      const saved = process.env;
      try {
        process.env = { ...production };
        resetEnvironmentForTests();
        expect(() => getEnvironment()).not.toThrow();
        expect(provider().offReason).toBe('missing');
        process.env = { ...production, WEB_PUSH_VAPID_PUBLIC_KEY: 'x', WEB_PUSH_VAPID_PRIVATE_KEY: 'y', WEB_PUSH_SUBJECT: 'z' };
        resetEnvironmentForTests();
        expect(() => getEnvironment()).not.toThrow();
        expect(provider().offReason).toBe('invalid_public_key');
        process.env = { ...production, WEB_PUSH_VAPID_PUBLIC_KEY: pair.publicKey, WEB_PUSH_VAPID_PRIVATE_KEY: pair.privateKey,
          WEB_PUSH_SUBJECT: subject, NOTIFICATION_PROVIDER_MODE: 'nonsense' };
        resetEnvironmentForTests();
        expect(() => getEnvironment()).toThrow();
        try { getEnvironment(); } catch (error) { expect(String(error)).not.toContain(pair.privateKey); }
      } finally {
        process.env = saved;
        resetEnvironmentForTests();
      }
    });
  });

  describe('the VAPID token and the request', () => {
    it('signs an ES256 JWT that verifies with the public key, for the endpoint\'s origin, 12 hours', async () => {
      environment();
      const transport = jest.fn().mockResolvedValue(answer(201));
      await provider(transport).send(endpoint, 'fcm');
      const [url, init] = transport.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(url).toBe(endpoint);
      const authorization = init.headers.Authorization!;
      const match = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]{87})$/.exec(authorization);
      expect(match).not.toBeNull();
      const [, header, claims, signature, k] = match!;
      expect(k).toBe(pair.publicKey);
      expect(JSON.parse(Buffer.from(header!, 'base64url').toString())).toEqual({ typ: 'JWT', alg: 'ES256' });
      expect(JSON.parse(Buffer.from(claims!, 'base64url').toString()))
        .toEqual({ aud: 'https://fcm.googleapis.com', exp: Math.floor(now / 1000) + VAPID_TOKEN_SECONDS, sub: subject });
      const publicKey = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pair.x, y: pair.y }, format: 'jwk' });
      const raw = Buffer.from(signature!, 'base64url');
      expect(raw).toHaveLength(64);
      expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, raw)).toBe(true);
      // Another key does not verify it.
      const other = keyPair();
      expect(verify('sha256', Buffer.from(`${header}.${claims}`), { key: createPublicKey({ key: { kty: 'EC', crv: 'P-256',
        x: other.x, y: other.y }, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, raw)).toBe(false);
    });

    it('reuses a token for the same audience until an hour before it ends, and signs one per audience', async () => {
      environment();
      let clock = now;
      const transport = jest.fn().mockImplementation(async () => answer(201));
      const webPush = provider(transport, () => clock);
      const token = () => (transport.mock.calls.at(-1)![1] as { headers: Record<string, string> }).headers.Authorization;
      await webPush.send(endpoint, 'fcm');
      const first = token();
      clock = now + (VAPID_TOKEN_SECONDS - 3601) * 1000;
      await webPush.send(`${endpoint}-2`, 'fcm');
      expect(token()).toBe(first);
      await webPush.send('https://web.push.apple.com/QHN0', 'apple');
      expect(token()).not.toBe(first);
      clock = now + (VAPID_TOKEN_SECONDS - 3600) * 1000;
      await webPush.send(endpoint, 'fcm');
      expect(token()).not.toBe(first);
    });

    it('sends exactly TTL, Urgency, Topic and Authorization, an empty body, and never follows a redirect', async () => {
      environment();
      const transport = jest.fn().mockResolvedValue(answer(201));
      await provider(transport).send(endpoint, 'fcm');
      const [, init] = transport.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
      expect(Object.keys(init.headers).sort()).toEqual(['Authorization', 'TTL', 'Topic', 'Urgency']);
      expect([init.headers.TTL, init.headers.Urgency, init.headers.Topic]).toEqual(['14400', 'normal', 'hid-inbox']);
      expect(WEB_PUSH_HEADERS).toEqual({ TTL: '14400', Urgency: 'normal', Topic: 'hid-inbox' });
      expect(init.method).toBe('POST');
      expect((init.body as Uint8Array).byteLength).toBe(0);
      expect(init.redirect).toBe('manual');
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([
      ['15000', 5000],
      ['5000', 5000],
      ['2000', 2000],
    ])('times a push out at the lower of NOTIFICATION_PROVIDER_TIMEOUT_MS=%s and 5 s, inside Identity\'s 8 s', async (setting, expected) => {
      environment({ NOTIFICATION_PROVIDER_TIMEOUT_MS: setting });
      const timeout = jest.spyOn(AbortSignal, 'timeout');
      await provider(jest.fn().mockResolvedValue(answer(201))).send(endpoint, 'fcm');
      expect(timeout.mock.calls).toEqual([[expected]]);
      expect(WEB_PUSH_SEND_TIMEOUT_MS).toBe(5000);
    });

    it('puts no Content-Type, Content-Encoding or Crypto-Key on the wire, and a zero length', async () => {
      const seen: { headers: IncomingHttpHeaders; body: string }[] = [];
      const server = createServer((incoming, outgoing) => {
        let body = '';
        incoming.on('data', (chunk) => { body += String(chunk); });
        incoming.on('end', () => { seen.push({ headers: incoming.headers, body }); outgoing.writeHead(201).end(); });
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        const { port } = server.address() as AddressInfo;
        const response = await fetch(`http://127.0.0.1:${port}/push`, pushRequest('header.claims.signature', pair.publicKey, 2000));
        expect(response.status).toBe(201);
        const [wire] = seen;
        expect(wire!.body).toBe('');
        expect(wire!.headers['content-length']).toBe('0');
        expect(wire!.headers['content-type']).toBeUndefined();
        expect(wire!.headers['content-encoding']).toBeUndefined();
        expect(wire!.headers['crypto-key']).toBeUndefined();
        expect([wire!.headers.ttl, wire!.headers.urgency, wire!.headers.topic]).toEqual(['14400', 'normal', 'hid-inbox']);
        expect(wire!.headers.authorization).toBe(`vapid t=header.claims.signature, k=${pair.publicKey}`);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    });
  });

  describe('classification', () => {
    it.each([
      [200, null, ['accepted', 200, null, null]],
      [201, null, ['accepted', 201, null, null]],
      [202, null, ['accepted', 202, null, null]],
      [404, null, ['gone', 404, null, 'push_404']],
      [410, null, ['gone', 410, null, 'push_410']],
      [429, '120', ['retry', 429, 120, 'push_429']],
      [429, '0', ['retry', 429, 1, 'push_429']],
      [429, '99999', ['retry', 429, 3600, 'push_429']],
      [429, new Date(now + 300_000).toUTCString(), ['retry', 429, 300, 'push_429']],
      [429, 'soon', ['retry', 429, null, 'push_429']],
      [429, null, ['retry', 429, null, 'push_429']],
      [500, null, ['retry', 500, null, 'push_5xx']],
      [503, '30', ['retry', 503, 30, 'push_5xx']],
      [400, null, ['rejected', 400, null, 'push_400']],
      [401, null, ['rejected', 401, null, 'push_401']],
      [403, null, ['rejected', 403, null, 'push_403']],
      [413, null, ['rejected', 413, null, 'push_413']],
      [406, null, ['rejected', 406, null, 'push_4xx']],
      [301, null, ['rejected', 301, null, 'redirect_refused']],
      [307, null, ['rejected', 307, null, 'redirect_refused']],
    ])('classifies %i (Retry-After %s) as %j', (status, retryAfter, expected) => {
      const result = classifyPushResponse(status, retryAfter, now);
      expect([result.outcome, result.pushStatus, result.retryAfterSeconds, result.safeCode]).toEqual(expected);
    });

    it('retries a timeout and a transport error, with no status', async () => {
      environment();
      const timeout = Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
      await expect(provider(jest.fn().mockRejectedValue(timeout)).send(endpoint, 'fcm'))
        .resolves.toEqual({ outcome: 'retry', pushStatus: null, retryAfterSeconds: null, safeCode: 'timeout' });
      await expect(provider(jest.fn().mockRejectedValue(new TypeError('fetch failed'))).send(endpoint, 'fcm'))
        .resolves.toEqual({ outcome: 'retry', pushStatus: null, retryAfterSeconds: null, safeCode: 'transport_error' });
    });

    it('parses Retry-After dates in the past as one second', () => {
      expect(retryAfterSeconds(new Date(now - 60_000).toUTCString(), now)).toBe(1);
    });
  });

  describe('POST notifications/web-push', () => {
    it('validates the body in the pipe: endpoint and key id only', async () => {
      await expect(pipe.transform({ endpoint, vapidKeyId: 'a'.repeat(16), payload: 'hello' },
        { type: 'body', metatype: DeliverWebPushDto })).rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform({ endpoint }, { type: 'body', metatype: DeliverWebPushDto }))
        .rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform({ endpoint, vapidKeyId: 'A'.repeat(16) }, { type: 'body', metatype: DeliverWebPushDto }))
        .rejects.toBeInstanceOf(BadRequestException);
      await expect(pipe.transform({ endpoint: 'x'.repeat(2049), vapidKeyId: 'a'.repeat(16) },
        { type: 'body', metatype: DeliverWebPushDto })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('authenticates first, then the idempotency key, then 404 when not configured, then rule E, then the key id', async () => {
      environment({ WEB_PUSH_VAPID_PRIVATE_KEY: undefined });
      const transport = jest.fn().mockResolvedValue(answer(201));
      const refused = jest.fn().mockRejectedValue(new UnauthorizedException());
      await expect(controller(provider(transport), refused).deliverWebPush({ endpoint, vapidKeyId: 'a'.repeat(16) }, request, key))
        .rejects.toBeInstanceOf(UnauthorizedException);
      await expect(controller(provider(transport)).deliverWebPush({ endpoint, vapidKeyId: 'a'.repeat(16) }, request, 'short'))
        .rejects.toBeInstanceOf(BadRequestException);
      const notConfigured = await controller(provider(transport)).deliverWebPush({ endpoint, vapidKeyId: 'a'.repeat(16) }, request, key)
        .catch((error: unknown) => error);
      expect(notConfigured).toBeInstanceOf(NotFoundException);
      expect((notConfigured as NotFoundException).getResponse()).toMatchObject({ code: 'WEB_PUSH_NOT_CONFIGURED' });
      // An image without the provider (the module wiring missing) also answers 404.
      await expect(controller(undefined).deliverWebPush({ endpoint, vapidKeyId: 'a'.repeat(16) }, request, key))
        .rejects.toBeInstanceOf(NotFoundException);

      environment();
      const webPush = provider(transport);
      for (const value of ['https://evil.example/push', 'http://fcm.googleapis.com/x', 'https://169.254.169.254/x',
        'https://fcm.googleapis.com.evil.example/x', 'https://FCM.googleapis.com/x']) {
        const refusedEndpoint = await controller(webPush).deliverWebPush({ endpoint: value, vapidKeyId: webPush.keyId! }, request, key)
          .catch((error: unknown) => error);
        expect(refusedEndpoint).toBeInstanceOf(BadRequestException);
        expect((refusedEndpoint as BadRequestException).getResponse()).toMatchObject({ code: 'WEB_PUSH_ENDPOINT_NOT_ALLOWED' });
      }
      const mismatch = await controller(webPush).deliverWebPush({ endpoint, vapidKeyId: 'a'.repeat(16) }, request, key)
        .catch((error: unknown) => error);
      expect(mismatch).toBeInstanceOf(ConflictException);
      expect((mismatch as ConflictException).getResponse()).toMatchObject({ code: 'WEB_PUSH_KEY_MISMATCH' });
      expect(transport).not.toHaveBeenCalled();
    });

    it('sends and answers 202\'s body: the outcome, the push status, the wait and the safe code', async () => {
      environment();
      const webPush = provider(jest.fn().mockResolvedValue(answer(429, { 'retry-after': '90' })));
      const body = await controller(webPush).deliverWebPush({ endpoint, vapidKeyId: webPush.keyId! }, request, key);
      expect(body).toEqual({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/), outcome: 'retry', pushStatus: 429,
        retryAfterSeconds: 90, safeCode: 'push_429' });
      const ok = provider(jest.fn().mockResolvedValue(answer(201)));
      await expect(controller(ok).deliverWebPush({ endpoint, vapidKeyId: ok.keyId! }, request, key)).resolves
        .toMatchObject({ outcome: 'accepted', pushStatus: 201, retryAfterSeconds: null, safeCode: null });
    });

    it('logs one line per send with the service, status and outcome only: never the endpoint, token or key', async () => {
      environment();
      const logs: string[] = [];
      jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => { logs.push(String(message)); });
      jest.spyOn(Logger.prototype, 'warn').mockImplementation((message: unknown) => { logs.push(String(message)); });
      jest.spyOn(Logger.prototype, 'error').mockImplementation((message: unknown) => { logs.push(String(message)); });
      const transport = jest.fn().mockResolvedValueOnce(answer(410)).mockRejectedValueOnce(new TypeError(`fetch failed ${endpoint}`));
      const webPush = provider(transport);
      await controller(webPush).deliverWebPush({ endpoint, vapidKeyId: webPush.keyId! }, request, key);
      await controller(webPush).deliverWebPush({ endpoint, vapidKeyId: webPush.keyId! }, request, key);
      expect(logs).toEqual([
        'Web push outcome (event=web_push_outcome service=fcm status=410 outcome=gone)',
        'Web push outcome (event=web_push_outcome service=fcm status=none outcome=retry)',
      ]);
      const authorization = (transport.mock.calls[0]![1] as { headers: Record<string, string> }).headers.Authorization!;
      for (const secret of [endpoint, 'fcm.googleapis.com/fcm', pair.privateKey, pair.publicKey, authorization.slice(8, 60)]) {
        expect(logs.join('\n')).not.toContain(secret);
      }
    });

    it('logs at bootstrap only outside tests, with the key id and never a key', () => {
      environment({ NODE_ENV: 'development', NOTIFICATION_PROVIDER_MODE: 'live' });
      const logs: string[] = [];
      jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => { logs.push(String(message)); });
      const webPush = provider(jest.fn());
      webPush.onApplicationBootstrap();
      environment({ NODE_ENV: 'development', NOTIFICATION_PROVIDER_MODE: 'live', WEB_PUSH_VAPID_PRIVATE_KEY: keyPair().privateKey });
      provider(jest.fn()).onApplicationBootstrap();
      environment();
      provider(jest.fn()).onApplicationBootstrap();
      expect(logs).toEqual([`Web push is on (keyId=${webPush.keyId})`, 'Web push is off (reason=key_mismatch)']);
      expect(logs.join(' ')).not.toContain(pair.privateKey);
    });
  });

  it('rule E matches Identity\'s', () => {
    expect(webPushServiceOf('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe('mozilla');
    expect(webPushServiceOf('https://wns2-par02p.notify.windows.com/w/?token=x')).toBe('windows');
    expect(webPushServiceOf('https://web.push.apple.com/x')).toBe('apple');
    for (const value of ['https://notify.windows.com/x', 'https://evilnotify.windows.com/x', 'https://[::1]/x',
      'https://127.0.0.1/x', 'https://fcm.googleapis.com:8443/x', 'https://u:p@fcm.googleapis.com/x',
      'https://fcm.googleapis.com/x#f', 'https://fcm.googleapis.com/x#', 'https://fcm.googleapis.com/x?',
      'https://db5p.notify.windows.com/w/?token=x#', `https://fcm.googleapis.com/${'a'.repeat(2048)}`, 42]) {
      expect(webPushServiceOf(value)).toBeNull();
    }
  });
});
