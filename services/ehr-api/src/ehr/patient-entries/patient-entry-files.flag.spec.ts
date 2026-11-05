import { patientEntryFilesEnabled } from './patient-entry-files.flag';
import { patientEntriesEnabled } from './patient-entries.flag';
import { resetEnvironmentForTests } from '../../config/environment';

describe('patientEntryFilesEnabled', () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; resetEnvironmentForTests(); });

  it('is on by default, without the rest of the server configuration', () => {
    for (const key of ['DATABASE_URL', 'CORS_ORIGINS', 'STORAGE_MODE', 'PATIENT_ENTRIES_ENABLED',
      'PATIENT_ENTRY_FILES_ENABLED']) delete process.env[key];
    resetEnvironmentForTests();
    expect(patientEntryFilesEnabled()).toBe(true);
  });

  it('is off for exactly false, and leaves text entries on', () => {
    delete process.env.PATIENT_ENTRIES_ENABLED;
    process.env.PATIENT_ENTRY_FILES_ENABLED = 'false';
    expect(patientEntryFilesEnabled()).toBe(false);
    expect(patientEntriesEnabled()).toBe(true);
  });

  it('is off while the records patients add are off', () => {
    process.env.PATIENT_ENTRIES_ENABLED = 'false';
    process.env.PATIENT_ENTRY_FILES_ENABLED = 'true';
    expect(patientEntryFilesEnabled()).toBe(false);
  });
});
