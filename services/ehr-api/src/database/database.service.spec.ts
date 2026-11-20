import type { DataAccessContext } from '../common/request-context';
import { DatabaseService, OWN_FACILITY_WORK } from './database.service';

// 0133 D13 and D14 (owner's Q120 B and Q121 A): the new ehr-api sets app.own_facility_work to '0133' in every staff
// transaction, so the order-route send and its resend flag follow D14's rule. It never sets it in a patient-self,
// system or workload transaction. Fictional values only.
const context = { correlationId: 'correlation-own-facility-work', facilityId: 'facility', membershipId: 'membership',
  purposeOfUse: 'direct-care', authorization: 'Bearer user',
  actor: { id: 'account', subject: 'synthetic:doctor', accountId: 'account' } } as unknown as DataAccessContext;
const SWITCH = /set_config\('app\.own_facility_work',\s*\$(\d+),\s*true\)/;

interface Call { sql: string; values: unknown[] }

/** A DatabaseService over fake pools that record each connection's statements. */
function service() {
  const connections: Call[][] = [];
  const pool = () => ({
    connect: async () => {
      const calls: Call[] = [];
      connections.push(calls);
      return {
        query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return { rows: [], rowCount: 0 }; },
        release: () => undefined,
      };
    },
  });
  const database = Object.create(DatabaseService.prototype) as DatabaseService;
  Object.assign(database, { pool: pool(), workloadPool: pool(), pauseBeforeRetry: async () => undefined });
  return { database, connections };
}

const switchValue = (calls: Call[]) => {
  const settings = calls.find((call) => call.sql.includes('set_config'))!;
  const parameter = SWITCH.exec(settings.sql);
  return parameter ? settings.values[Number(parameter[1]) - 1] : undefined;
};
const mentionsSwitch = (calls: Call[]) => calls.some((call) => call.sql.includes('own_facility_work')
  || call.values.includes(OWN_FACILITY_WORK));

describe('EHR DatabaseService staff session (0133 D13 and D14, owner\'s Q120 B and Q121 A)', () => {
  it('sets app.own_facility_work to 0133 in every staff transaction, beside the staff context', async () => {
    const { database, connections } = service();
    await database.withTransaction(context, async () => 'done');
    expect(OWN_FACILITY_WORK).toBe('0133');
    expect(connections).toHaveLength(1);
    expect(switchValue(connections[0]!)).toBe('0133');
    const settings = connections[0]!.find((call) => call.sql.includes('set_config'))!;
    expect(settings.values).toEqual(expect.arrayContaining(['synthetic:doctor', 'facility', 'membership', 'direct-care']));
  });

  it('sets it again in every attempt of a retried SERIALIZABLE transaction, and in a read-only one', async () => {
    const { database, connections } = service();
    let runs = 0;
    await database.withTransaction(context, async () => {
      runs += 1;
      if (runs < 3) throw Object.assign(new Error('synthetic conflict'), { code: runs === 1 ? '40001' : '40P01' });
      return 'sent';
    }, { isolationLevel: 'SERIALIZABLE' });
    await database.withTransaction(context, async () => 'read', { readOnly: true });
    expect(connections).toHaveLength(4);
    expect(connections.map(switchValue)).toEqual(['0133', '0133', '0133', '0133']);
  });

  it('never sets it in a patient-self, system or workload transaction', async () => {
    const { database, connections } = service();
    await database.withPatientTransaction({ subject: 'synthetic:patient', accountId: 'account', sessionId: 'session',
      patientId: 'patient', expiresAt: new Date(Date.now() + 30_000).toISOString() }, 'correlation', async () => 'done');
    await database.withSystemTransaction('correlation', async () => 'done');
    await database.withWorkloadTransaction('synthetic:document-scanner', 'correlation', async () => 'done');
    expect(connections).toHaveLength(3);
    for (const calls of connections) {
      expect(calls.some((call) => call.sql.includes('set_config'))).toBe(true);
      expect(mentionsSwitch(calls)).toBe(false);
    }
  });
});
