import { usePatientSafetyTestEnvironment } from '../../test/patient-safety.fixtures';
import { WebPushProtector } from './web-push.protector';

const endpoint = 'https://fcm.googleapis.com/fcm/send/eXaMpLe:APA91bHx';
const subscriptionId = '6a1e0000-0000-4000-8000-000000000001';

describe('WebPushProtector (B6, D15)', () => {
  describe('with the contact key', () => {
    usePatientSafetyTestEnvironment();

    it('round-trips the endpoint under the emergency contacts\' convention, never in clear', () => {
      const protector = new WebPushProtector();
      const ciphertext = protector.encrypt(subscriptionId, endpoint);
      expect(ciphertext[0]).toBe(1);
      expect(ciphertext.length).toBe(1 + 12 + Buffer.byteLength(endpoint) + 16);
      expect(ciphertext.toString('utf8')).not.toContain('fcm.googleapis.com');
      expect(protector.decrypt(subscriptionId, 'test-v1', ciphertext)).toBe(endpoint);
      expect(protector.keyVersion).toBe('test-v1');
      expect(protector.configured()).toBe(true);
    });

    it('binds the ciphertext to its subscription and key version', () => {
      const protector = new WebPushProtector();
      const ciphertext = protector.encrypt(subscriptionId, endpoint);
      expect(() => protector.decrypt('6a1e0000-0000-4000-8000-000000000002', 'test-v1', ciphertext))
        .toThrow(expect.objectContaining({ code: 'WEB_PUSH_UNAVAILABLE' }));
      expect(() => protector.decrypt(subscriptionId, 'other-v1', ciphertext))
        .toThrow(expect.objectContaining({ code: 'WEB_PUSH_UNAVAILABLE' }));
      const tampered = Buffer.from(ciphertext);
      tampered[20] = tampered[20]! ^ 1;
      expect(() => protector.decrypt(subscriptionId, 'test-v1', tampered)).toThrow(expect.objectContaining({ status: 503 }));
    });

    it('never puts the endpoint in an error', () => {
      const protector = new WebPushProtector();
      try {
        protector.decrypt(subscriptionId, 'test-v1', Buffer.alloc(40, 1));
      } catch (error) {
        expect(JSON.stringify(error)).not.toContain('fcm');
        expect(String((error as Error).message)).not.toContain('fcm');
      }
    });
  });

  describe('without the contact key', () => {
    usePatientSafetyTestEnvironment({ NIN_ENCRYPTION_KEY_B64: '' });

    it('is not configured and answers 503', () => {
      const protector = new WebPushProtector();
      expect(protector.configured()).toBe(false);
      expect(() => protector.encrypt(subscriptionId, endpoint)).toThrow(expect.objectContaining({ code: 'WEB_PUSH_UNAVAILABLE' }));
    });
  });

  describe('with a key version outside the database CHECK', () => {
    usePatientSafetyTestEnvironment({ NIN_KEY_VERSION: 'v1 with spaces' });

    it('is not configured', () => {
      expect(new WebPushProtector().configured()).toBe(false);
    });
  });
});
