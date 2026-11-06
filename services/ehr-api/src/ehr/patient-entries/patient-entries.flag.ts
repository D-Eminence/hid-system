/**
 * PATIENT_ENTRIES_ENABLED (0116, on by default since the owner's decision of 4 Nov 2026; 'false' switches it off). While off, the routes of
 * PatientEntriesController answer a plain 404, the records answer keeps
 * today's keys, and neither chat reads ehr.patient_entries, so this image
 * also runs on a database without 0116.
 *
 * It reads only its own variable, with the rule environment.ts applies
 * (on unless exactly 'false'), and not the whole validated configuration: the
 * chat and records code also runs in scripts and tests built without the
 * rest of the server's settings. The server still refuses a malformed value
 * at boot, where main.ts validates the whole environment.
 */
export function patientEntriesEnabled(): boolean {
  return process.env.PATIENT_ENTRIES_ENABLED !== 'false';
}
