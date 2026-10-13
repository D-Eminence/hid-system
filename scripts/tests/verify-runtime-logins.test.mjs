import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RUNTIME_CREDENTIALS, credentialVariable, forbiddenLogins, safeFailure, selectedCredentials,
} from '../../services/ehr-api/scripts/verify-runtime-logins.mjs';

const everyCredential = Object.fromEntries(Object.keys(RUNTIME_CREDENTIALS)
  .map((credential) => [credentialVariable(credential), `postgresql://${credential}@db.invalid/hid`]));

test('maps the ten runtime credentials to their aggregates, the EHR scanner pool to the scanner role', () => {
  assert.deepEqual(RUNTIME_CREDENTIALS, {
    'identity-api': 'hid_identity_api_runtime',
    'ehr-api': 'hid_ehr_api_runtime',
    'ehr-api-scanner': 'hid_document_scanner',
    'lab-api': 'hid_lab_api_runtime',
    'pharmacy-api': 'hid_pharmacy_api_runtime',
    'ocr-api': 'hid_ocr_api_runtime',
    'ocr-worker': 'hid_ocr_worker',
    'outreach-api': 'hid_outreach_api_runtime',
    'event-dispatcher': 'hid_event_dispatcher',
    'notification-worker': 'hid_notification_worker',
  });
  assert.equal(credentialVariable('ehr-api-scanner'), 'DATABASE_LOGIN_URL_EHR_API_SCANNER');
});

test('requires every credential unless partial verification is asked for', () => {
  assert.equal(selectedCredentials(everyCredential).selected.length, 10);
  const one = { [credentialVariable('identity-api')]: 'postgresql://identity@db.invalid/hid' };
  assert.throws(() => selectedCredentials(one), /missing for ehr-api, ehr-api-scanner/);
  const partial = selectedCredentials(one, { partial: true });
  assert.deepEqual(partial.selected, [{ credential: 'identity-api', role: 'hid_identity_api_runtime',
    url: 'postgresql://identity@db.invalid/hid' }]);
  assert.equal(partial.missing.length, 9);
  assert.throws(() => selectedCredentials({}, { partial: true }), /No runtime credential URL is set/);
});

test('reads forbidden login names and refuses anything else', () => {
  assert.deepEqual(forbiddenLogins({}), []);
  assert.deepEqual(forbiddenLogins({ DATABASE_FORBIDDEN_LOGINS: 'hid_platform_bootstrap, hid_migration_login' }),
    ['hid_platform_bootstrap', 'hid_migration_login']);
  assert.throws(() => forbiddenLogins({ DATABASE_FORBIDDEN_LOGINS: "x'; drop role y" }), /role names/);
});

test('reports SQL assertion failures and nothing that could carry a URL or password', () => {
  assert.equal(safeFailure(Object.assign(new Error('runtime login verification failed for x: y'), { code: 'P0001' })),
    'runtime login verification failed for x: y');
  assert.equal(safeFailure(Object.assign(new Error('password authentication failed for user "x"'), { code: '28P01' })),
    'connection or query failed (code 28P01)');
  assert.equal(safeFailure(new Error('getaddrinfo ENOTFOUND db.invalid')), 'connection or query failed (code unknown)');
});
