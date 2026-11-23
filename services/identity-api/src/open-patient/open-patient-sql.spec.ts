jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn(), SignJWT: jest.fn() }));
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPEN_PATIENT_CLEAR_ELSEWHERE_SQL } from '../auth/open-patient';
import { OPEN_PATIENT_CARD_SQL, OPEN_PATIENT_CLEAR_READ_SQL, OPEN_PATIENT_CLEAR_SQL, OPEN_PATIENT_PRESENTED_SQL,
  OPEN_PATIENT_READ_SQL, OPEN_PATIENT_STORE_SQL } from './open-patient.service';

// The database suite (services/ehr-api/test/database/session-open-patient.integration.sql,
// section 4) runs Identity's own statements against a real 0140 schema as
// the Identity API runtime. This holds it to their exact text, in order, so
// a change here that the suite has not run fails.

const SUITE = readFileSync(join(__dirname,
  '../../../ehr-api/test/database/session-open-patient.integration.sql'), 'utf8');
const normalized = (sql: string) => sql.replace(/\s+/g, ' ').trim();

describe('the 0140 database suite runs Identity\'s open-patient statements verbatim (SX-8)', () => {
  it('section 4 executes each statement, in this order, with the same text', () => {
    const executed = [...SUITE.matchAll(/execute \$sql\$([\s\S]*?)\$sql\$/g)].map(([, body]) => normalized(body!));
    expect(executed).toEqual([
      OPEN_PATIENT_PRESENTED_SQL, OPEN_PATIENT_STORE_SQL, OPEN_PATIENT_READ_SQL, OPEN_PATIENT_CLEAR_SQL,
      OPEN_PATIENT_CLEAR_READ_SQL, OPEN_PATIENT_CLEAR_ELSEWHERE_SQL, OPEN_PATIENT_CARD_SQL,
    ].map(normalized));
  });

  it('as the Identity API runtime, with the card read under the staff context', () => {
    const section = SUITE.slice(SUITE.indexOf("-- 4. Identity's own statements, verbatim."));
    expect(section).toContain('set local role hid_identity_api_runtime;');
    expect(section).toMatch(/set_config\('app\.purpose_of_use', 'direct-care', true\)[\s\S]*op_card\(/);
  });
});
