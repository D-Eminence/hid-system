import { createHash } from 'node:crypto';
import { base64UrlBytes, checkWebPushEndpoint, webPushEndpointDigest, webPushKeyId } from './web-push-endpoint';

describe('Web push rule E (B6)', () => {
  it.each([
    ['https://fcm.googleapis.com/fcm/send/eXaMpLe:APA91bHx', 'fcm'],
    ['https://updates.push.services.mozilla.com/wpush/v2/gAAAAABexample', 'mozilla'],
    ['https://web.push.apple.com/QHN0dXZ3eHl6', 'apple'],
    ['https://api.push.apple.com/3/device/abc', 'apple'],
    ['https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB', 'windows'],
    ['https://db5p.notify.windows.com/w/?token=x', 'windows'],
  ])('accepts %s as %s', (endpoint, pushService) => {
    expect(checkWebPushEndpoint(endpoint)).toEqual({ ok: true, pushService });
  });

  it.each([
    ['http://fcm.googleapis.com/fcm/send/x'],
    ['https://fcm.googleapis.com:8443/fcm/send/x'],
    ['https://fcm.googleapis.com:443/fcm/send/x'],
    ['https://user:secret@fcm.googleapis.com/fcm/send/x'],
    ['https://fcm.googleapis.com/fcm/send/x#fragment'],
    // An empty fragment or query serializes as itself and would digest the same push resource twice.
    ['https://fcm.googleapis.com/fcm/send/x#'],
    ['https://fcm.googleapis.com/fcm/send/x?'],
    ['https://db5p.notify.windows.com/w/?token=x#'],
    ['https://FCM.googleapis.com/fcm/send/x'],
    ['https://fcm.googleapis.com'],
    [' https://fcm.googleapis.com/fcm/send/x'],
    ['not a url'],
    [`https://fcm.googleapis.com/fcm/send/${'a'.repeat(2048)}`],
    [''],
    [42],
    [null],
  ])('refuses %s as malformed', (endpoint) => {
    expect(checkWebPushEndpoint(endpoint)).toEqual({ ok: false, reason: 'malformed' });
  });

  it.each([
    ['https://fcm.googleapis.com.evil.example/fcm/send/x'],
    ['https://evilnotify.windows.com/w/?token=x'],
    ['https://notify.windows.com/w/?token=x'],
    ['https://push.apple.com/x'],
    ['https://evilpush.apple.com/x'],
    ['https://127.0.0.1/x'],
    ['https://[::1]/x'],
    ['https://169.254.169.254/latest/meta-data/'],
    ['https://example.com/push'],
    ['https://fcm.googleapis.com./fcm/send/x'],
  ])('refuses %s as an unsupported push service', (endpoint) => {
    expect(checkWebPushEndpoint(endpoint)).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('accepts exactly 2048 characters and refuses 2049', () => {
    const base = 'https://fcm.googleapis.com/fcm/send/';
    expect(checkWebPushEndpoint(base + 'a'.repeat(2048 - base.length)).ok).toBe(true);
    expect(checkWebPushEndpoint(base + 'a'.repeat(2049 - base.length))).toEqual({ ok: false, reason: 'malformed' });
  });

  it('digests the endpoint exactly as sent and derives the key id from the 65 raw bytes', () => {
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc';
    expect(webPushEndpointDigest(endpoint)).toBe(createHash('sha256').update(endpoint).digest('hex'));
    expect(webPushEndpointDigest(endpoint)).toMatch(/^[0-9a-f]{64}$/);
    const key = Buffer.alloc(65, 7);
    expect(webPushKeyId(key)).toBe(createHash('sha256').update(key).digest('hex').slice(0, 16));
  });

  it('decodes base64url with or without padding and refuses anything else', () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5]);
    expect(base64UrlBytes(bytes.toString('base64url'))).toEqual(bytes);
    expect(base64UrlBytes(`${bytes.toString('base64url')}=`)).toEqual(bytes);
    expect(base64UrlBytes('a+b/')).toBeNull();
    expect(base64UrlBytes('abcde')).toBeNull();
    expect(base64UrlBytes(5)).toBeNull();
  });
});
