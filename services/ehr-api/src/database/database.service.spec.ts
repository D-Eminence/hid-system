import type { DataAccessContext } from '../common/request-context';
import { DatabaseService, OWN_FACILITY_WORK, VITALS_STATUS_AWARE } from './database.service';

// 0133 D13 and D14 (owner's Q120 B and Q121 A): the new ehr-api sets app.own_facility_work to '0133' in every staff
// transaction of withTransaction, so the order-route send and its resend flag follow D14's rule. It never sets it in
// withStaffTransaction's (ORD-9's recent diagnoses, which read no order route) or in a patient-self, system or workload
// transaction. Fictional values only.
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
  || call.values.includes(OWN_FACILITY_WORK) || call.sql.includes('vitals_status') || call.values.includes(VITALS_STATUS_AWARE));
const VITALS_SWITCH = /set_config\('app\.vitals_status',\s*\$(\d+),\s*true\)/;
const vitalsSwitchValue = (calls: Call[]) => {
  const settings = calls.find((call) => call.sql.includes('set_config'))!;
  const parameter = VITALS_SWITCH.exec(settings.sql);
  return parameter ? settings.values[Number(parameter[1]) - 1] : undefined;
};
/** The value a transaction-local set_config of app.<name> is given, from its parameter; undefined when it is not set. */
const staffSetting = (calls: Call[], name: string) => {
  const pattern = new RegExp(`set_config\\('app\\.${name}',\\s*\\$(\\d+),\\s*true\\)`);
  const settings = calls.find((call) => pattern.test(call.sql));
  const parameter = settings && pattern.exec(settings.sql);
  return settings && parameter ? settings.values[Number(parameter[1]) - 1] : undefined;
};

describe('EHR DatabaseService staff session (0133 D13 and D14, owner\'s Q120 B and Q121 A)', () => {
  it('sets app.own_facility_work to 0133 in every withTransaction staff transaction, beside the staff context', async () => {
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

  it('sets app.vitals_status to 0142 in every withTransaction staff transaction (0142 D2: this image reads withdrawn readings)', async () => {
    const { database, connections } = service();
    await database.withTransaction(context, async () => 'done');
    await database.withTransaction(context, async () => 'read', { readOnly: true });
    expect(VITALS_STATUS_AWARE).toBe('0142');
    expect(connections.map(vitalsSwitchValue)).toEqual(['0142', '0142']);
  });

  it('sets the membership and no purpose of use in a staff transaction (ORD-9\'s recent diagnoses, 0153)', async () => {
    // 0153's record and read find the caller by app.membership_id (and app.facility_id and app.actor_subject); the
    // recent list reads no patient, so withStaffTransaction sets no purpose of use (Rahman's re-review of #321, nit 5).
    const { database, connections } = service();
    await database.withStaffTransaction({ subject: 'synthetic:doctor', facilityId: 'facility', membershipId: 'membership',
      correlationId: 'correlation-staff' }, async () => 'read');
    expect(connections).toHaveLength(1);
    const calls = connections[0]!;
    expect(calls[0]!.sql).toBe('BEGIN');
    expect(calls.at(-1)!.sql).toBe('COMMIT');
    expect(staffSetting(calls, 'membership_id')).toBe('membership');
    expect(staffSetting(calls, 'facility_id')).toBe('facility');
    expect(staffSetting(calls, 'actor_subject')).toBe('synthetic:doctor');
    expect(staffSetting(calls, 'correlation_id')).toBe('correlation-staff');
    expect(calls.some((call) => /purpose_of_use/.test(call.sql))).toBe(false);
    expect(calls.flatMap((call) => call.values)).not.toContain('direct-care');
    // The recent list reads no order route and no vitals, so neither switch is set here (database.service.ts's
    // OWN_FACILITY_WORK and VITALS_STATUS_AWARE: withTransaction's staff transactions only).
    expect(mentionsSwitch(calls)).toBe(false);
  });

  it('never sets either switch in a patient-self, system or workload transaction', async () => {
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
