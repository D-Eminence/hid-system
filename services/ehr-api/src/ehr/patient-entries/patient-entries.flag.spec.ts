import { patientEntriesEnabled } from './patient-entries.flag';
import { resetEnvironmentForTests } from '../../config/environment';

/**
 * The flag is read where the chat and records code run, including scripts and
 * services built without the rest of the server's configuration (the CI
 * runtime test of the patient evidence builds the services with no
 * DATABASE_URL). It reads only its own variable: exactly 'true' is on, and
 * anything else is off. The server still refuses a malformed value at boot,
 * where main.ts validates the whole environment.
 */
describe('patientEntriesEnabled', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; resetEnvironmentForTests(); });

  it('reads only PATIENT_ENTRIES_ENABLED, without the rest of the server configuration', () => {
    for (const key of ['DATABASE_URL', 'CORS_ORIGINS', 'STORAGE_MODE']) delete process.env[key];
    resetEnvironmentForTests();
    delete process.env.PATIENT_ENTRIES_ENABLED;
    expect(() => patientEntriesEnabled()).not.toThrow();
    // On unless switched off (the owner's decision of 4 Nov 2026, as PATIENT_SHARES_ENABLED: production sets no key).
    expect(patientEntriesEnabled()).toBe(true);
    process.env.PATIENT_ENTRIES_ENABLED = 'false';
    expect(patientEntriesEnabled()).toBe(false);
  });

  it('is on for true, off only for exactly false', () => {
    process.env.PATIENT_ENTRIES_ENABLED = 'true';
    expect(patientEntriesEnabled()).toBe(true);
    process.env.PATIENT_ENTRIES_ENABLED = 'false';
    expect(patientEntriesEnabled()).toBe(false);
  });
});
