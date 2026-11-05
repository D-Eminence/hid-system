import { patientEntriesEnabled } from './patient-entries.flag';

/**
 * PATIENT_ENTRY_FILES_ENABLED (0117; its own switch since the coordinator's
 * decision of 4 Nov 2026, on by default; 'false' switches it off). Files hang
 * off the records patients add, so they are served only while
 * PATIENT_ENTRIES_ENABLED is on too. While off, the upload routes answer a
 * plain 404 as if not built, every record's documents list is empty, the
 * records answer carries no patientEntryFiles flag, and no chat or scanner
 * route reads the files, so this image also runs on a database without 0117.
 * Text entries (0116) are unaffected by it.
 *
 * It reads only its own variables, with the rule environment.ts applies (on
 * unless exactly 'false'), as patientEntriesEnabled does.
 */
export function patientEntryFilesEnabled(): boolean {
  return patientEntriesEnabled() && process.env.PATIENT_ENTRY_FILES_ENABLED !== 'false';
}
