import { createHmac, randomBytes } from 'node:crypto';
import { validMetaMapWebhookSignature } from './metamap-webhook-signature';

describe('MetaMap generic webhook byte authentication', () => {
  const secret = `Test1${randomBytes(32).toString('hex')}`;
  const body = Buffer.from('{"metadata":{"requestId":"synthetic"}}');
  const signature = createHmac('sha256', secret).update(body).digest('hex');

  it('accepts only the signed bytes with the correct secret', () => {
    expect(validMetaMapWebhookSignature(body, signature, secret)).toBe(true);
    expect(validMetaMapWebhookSignature(Buffer.concat([body, Buffer.from(' ')]), signature, secret)).toBe(false);
    expect(validMetaMapWebhookSignature(body, signature, `${secret}x`)).toBe(false);
  });

  it.each([undefined, '', 'a', 'a'.repeat(63), 'g'.repeat(64), [signature], `sha256=${signature}`])
    ('rejects missing, malformed and duplicate signatures without throwing', (value) => {
      expect(validMetaMapWebhookSignature(body, value, secret)).toBe(false);
    });

  it('refuses missing secrets and oversized bodies', () => {
    expect(validMetaMapWebhookSignature(body, signature, '')).toBe(false);
    expect(validMetaMapWebhookSignature(Buffer.alloc(262_145), signature, secret)).toBe(false);
  });
});
