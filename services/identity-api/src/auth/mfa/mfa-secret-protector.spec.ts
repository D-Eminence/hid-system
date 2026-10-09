import { DomainProblem } from '../../common/problem';
import { useTestEnvironment } from '../../testing/platform-assurance';
import { MfaSecretProtector } from './mfa-secret-protector';

const key = Buffer.alloc(32, 0x5a).toString('base64');
const factorId = '70000000-0000-4000-8000-000000000001';
const accountId = '20000000-0000-4000-8000-000000000001';

describe('MfaSecretProtector', () => {
  describe('with a configured key', () => {
    useTestEnvironment({ MFA_SECRET_KEY_B64: key, MFA_KEY_VERSION: 'test-v1' });

    it('encrypts a TOTP secret with a fresh nonce and decrypts it only for the same factor and account', () => {
      const protector = new MfaSecretProtector();
      const secret = Buffer.from('3132333435363738393031323334353637383930', 'hex');
      const first = protector.encryptSecret(factorId, accountId, secret);
      const second = protector.encryptSecret(factorId, accountId, secret);
      expect(first.equals(second)).toBe(false);
      expect(first.includes(secret)).toBe(false);
      expect(first[0]).toBe(1);
      expect(first.length).toBe(1 + 12 + secret.length + 16);
      expect(protector.decryptSecret(factorId, accountId, 'test-v1', first)).toEqual(secret);
      for (const attempt of [
        () => protector.decryptSecret('70000000-0000-4000-8000-000000000002', accountId, 'test-v1', first),
        () => protector.decryptSecret(factorId, '20000000-0000-4000-8000-000000000002', 'test-v1', first),
        () => protector.decryptSecret(factorId, accountId, 'other-version', first),
        () => protector.decryptSecret(factorId, accountId, 'test-v1', Buffer.concat([first.subarray(0, -1), Buffer.from([0])])),
      ]) {
        expect(attempt).toThrow(DomainProblem);
      }
    });

    it('derives account-bound recovery-code digests from a key separate from the encryption key', () => {
      const protector = new MfaSecretProtector();
      const digest = protector.recoveryCodeDigest(accountId, 'ABCDEFGHJK');
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      expect(protector.recoveryCodeDigest(accountId, 'ABCDEFGHJK')).toBe(digest);
      expect(protector.recoveryCodeDigest('20000000-0000-4000-8000-000000000002', 'ABCDEFGHJK')).not.toBe(digest);
      expect(protector.rateBucket('account', accountId)).not.toBe(digest);
      expect(protector.tokenDigest('token')).toMatch(/^[0-9a-f]{64}$/);
    });
  });

  describe('without a key', () => {
    useTestEnvironment();

    it('fails closed', () => {
      const protector = new MfaSecretProtector();
      const failure = (() => { try { protector.assertConfigured(); return undefined; } catch (error) { return error; } })();
      expect(failure).toBeInstanceOf(DomainProblem);
      expect((failure as DomainProblem).getStatus()).toBe(503);
      expect((failure as DomainProblem).code).toBe('MFA_UNAVAILABLE');
    });
  });
});
