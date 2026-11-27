/**
 * The detail line of a diagnosis or a lab request in the encounter's clinical timeline. From migration 0156
 * ehr-api may answer a diagnosis or a lab request saved by its name only, with both codes null
 * (DIAGNOSIS_NAME_ONLY_ENABLED, LAB_REQUEST_NAME_ONLY_ENABLED). The line then leaves the code out, and the name stays
 * the record's title, so one such record never fails the timeline page.
 * No imports, so the node test can load it on its own.
 */
export const NO_CODE = 'No code';

/** 'ICD-10 • B50.9' for a coded diagnosis; 'No code' when either code is missing. */
export const diagnosisDetail = (codeSystem: string | undefined, code: string | undefined): string =>
  codeSystem && code ? `${codeSystem} • ${code}` : NO_CODE;

/** 'MP-SMEAR • ROUTINE' for a coded lab request; 'ROUTINE' alone when the test code is missing. */
export const labRequestDetail = (testCode: string | undefined, priority: string): string =>
  [testCode, priority.toUpperCase()].filter(Boolean).join(' • ');
