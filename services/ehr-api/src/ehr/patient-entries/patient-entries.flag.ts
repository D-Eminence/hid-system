import { getEnvironment } from '../../config/environment';

/**
 * PATIENT_ENTRIES_ENABLED (0116, off by default). While off, the routes of
 * PatientEntriesController answer a plain 404, the records answer keeps
 * today's keys, and neither chat reads ehr.patient_entries, so this image
 * also runs on a database without 0116.
 */
export function patientEntriesEnabled(): boolean {
  return getEnvironment().PATIENT_ENTRIES_ENABLED;
}
