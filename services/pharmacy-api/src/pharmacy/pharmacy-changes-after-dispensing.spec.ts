import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { CHANGES_AFTER_DISPENSING_OFF, CHANGES_AFTER_DISPENSING_QUERY, type ChangedAfterDispensing,
  PharmacyChangesAfterDispensing } from './changes-after-dispensing';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { OWN_WORK_STEPS_QUERY, PharmacyOwnWork } from './own-work-access';
import { OWN_WORK_PATIENT_CARDS_OFF, PharmacyOwnWorkPatientCards } from './own-work-patient-cards';
import { PharmacyModule } from './pharmacy.module';
import { PharmacyService, WORK_LIST_QUERY, WORK_LIST_QUERY_0133 } from './pharmacy.service';
import { PharmacyPrescriptionDetails, PRESCRIPTION_DETAILS_OFF } from './prescription-dispensing-details';

/*
 * Q132 A (owner decision of 19 November 2026; coordinator decision 1 of 20
 * November 2026; SPEC decisions 20-24): a dispensed work item whose
 * prescription the prescribing team changed afterwards carries
 * `changedAfterDispensing: { change, changedAt, changeCount }` on the work
 * list, a single read and the hand-off replay (accept-ehr-prescription), own
 * and route-backed alike. The database part (0148's trigger, table and reader)
 * is faked here with the answers its reader gives; every statement runs
 * through the real DatabaseService (its SERIALIZABLE retry) and the real
 * AuditService, and the rest of the service (0133's list query, ORD-4's steps,
 * the route cards) is answered as on a database with 0133 and 0144. Fictional
 * ids and names only.
 */

const facilityId = '10000000-0000-4000-8000-000000000148';
const orderingFacilityId = '10000000-0000-4000-8000-000000000248';
const pharmacistAccount = '20000000-0000-4000-8000-0000000001a1';
const pharmacistMembership = '40000000-0000-4000-8000-0000000001a1';
const doctorAccount = '20000000-0000-4000-8000-0000000001d1';
const doctorMembership = '40000000-0000-4000-8000-0000000001d1';
const routeMemberAccount = '20000000-0000-4000-8000-0000000001c1';
const routeMemberMembership = '40000000-0000-4000-8000-0000000001c1';
const ada = '50000000-0000-4000-8000-0000000001e1';
const bola = '50000000-0000-4000-8000-0000000001e2';
const routeId = '80000000-0000-4000-8000-0000000001c1';
const id = (n: number) => `14800000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const prescriptionId = (n: number) => `30000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const encounterId = '70000000-0000-4000-8000-0000000001b1';
const at = (minute: number) => new Date(Date.UTC(2026, 10, 20, 9, minute));

const pharmacist: DataAccessContext = { correlationId: 'q132-correlation-0001', facilityId,
  membershipId: pharmacistMembership, purposeOfUse: 'direct-care', authorization: 'Bearer pharmacist', actor: {
    id: pharmacistAccount, subject: 'staff:pharmacist-q132', accountId: pharmacistAccount, authenticationMethod: 'local',
    roles: ['pharmacist'], permissions: ['pharmacy.work-item.read', 'pharmacy.work-item.accept',
      'pharmacy.dispensing.create', 'pharmacy.order-route.receive'], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId: pharmacistMembership, organizationId: facilityId,
      name: 'Fictional Riverside Hospital', roles: ['pharmacist'], permissions: [], isPrimary: true } } };

/** How each fictional work item came to this pharmacy, and where it is. */
interface Item {
  n: number;
  /** Another facility's prescription, accepted with its order route (0086). */
  routed?: boolean;
  /** An own item a pharmacist handed in by hand (not sent automatically). */
  handOff?: boolean;
  dispensed?: boolean;
  reversed?: boolean;
  /** 0133 D8: withdrawn before it was dispensed. */
  withdrawn?: 'changed';
}

const ITEMS: Item[] = [
  // Own, sent automatically, not dispensed yet.
  { n: 1 },
  // Own, sent automatically and dispensed; then cancelled (after a hold): cancelled, 2.
  { n: 2, dispensed: true },
  // Own, handed in by a pharmacist and dispensed; then edited: edited, 1.
  { n: 3, handOff: true, dispensed: true },
  // From another facility's order route, dispensed; then put on hold there: on_hold, 1.
  { n: 4, routed: true, dispensed: true },
  // From another facility's order route, not dispensed yet.
  { n: 5, routed: true },
  // Own, withdrawn before it was dispensed (0133 D8): ORD-2's flag, never Q132's notice.
  { n: 6, withdrawn: 'changed' },
  // Own, dispensed and reversed; held and resumed as dispensed meanwhile: resumed, 2 (the claim keeps its dispensing).
  { n: 7, dispensed: true, reversed: true },
  // Own, dispensed, never changed: no notice.
  { n: 8, dispensed: true },
  // Own, handed in by a pharmacist, not dispensed yet.
  { n: 9, handOff: true },
];

/** What 0148's reader answers, by item: the latest shown change, its minute and the count. */
const NOTICES: Record<number, { change: string; minute: number; count: number }> = {
  2: { change: 'cancelled', minute: 52, count: 2 },
  3: { change: 'edited', minute: 53, count: 1 },
  4: { change: 'on_hold', minute: 54, count: 1 },
  7: { change: 'resumed', minute: 57, count: 2 },
};
const notice = (n: number) => ({ change: NOTICES[n]!.change, changedAt: at(NOTICES[n]!.minute), changeCount: NOTICES[n]!.count });
const DISPENSED = ITEMS.filter((item) => item.dispensed).map((item) => item.n);
const NOT_DISPENSED = ITEMS.filter((item) => !item.dispensed).map((item) => item.n);

const workRow = (item: Item) => ({ id: id(item.n), patient_id: item.routed ? bola : ada, facility_id: facilityId,
  ordering_facility_id: item.routed ? orderingFacilityId : facilityId, source_ehr_prescription_id: prescriptionId(item.n),
  source_ehr_prescription_version: '2', source_encounter_id: encounterId, source_status: 'active', status: 'accepted',
  medication_code_system: null, medication_code: null, medication_display: 'Amoxicillin 500 mg capsule', dose_quantity: '1',
  dose_unit: 'capsule', route_code: 'oral', frequency: 'Every 8 hours', instructions: 'After food', starts_on: null,
  ends_on: null, prescribed_by: doctorAccount, prescribed_at: at(item.n),
  accepted_by: item.routed ? routeMemberAccount : item.handOff ? pharmacistAccount : doctorAccount,
  accepted_by_membership_id: item.routed ? routeMemberMembership : item.handOff ? pharmacistMembership : doctorMembership,
  accepted_at: at(item.n), row_version: '1', created_at: at(item.n),
  dispensing_id: item.dispensed ? `65000000-0000-4000-8000-${String(item.n).padStart(12, '0')}` : null,
  dispensing_status: item.dispensed ? 'dispensed' : null,
  reversal_id: item.reversed ? `66000000-0000-4000-8000-${String(item.n).padStart(12, '0')}` : null,
  order_route_id: item.routed ? routeId : null });

/** What a pharmacist sends to hand in item n by hand (accept-ehr-prescription); a replay sends it again. */
const handOffInput = (n: number) => ({ patientId: ada, orderingFacilityId: facilityId,
  sourceEhrPrescriptionId: prescriptionId(n), sourceEhrPrescriptionVersion: 2, sourceEncounterId: encounterId,
  sourceStatus: 'active' as const, medicationDisplay: 'Amoxicillin 500 mg capsule', frequency: 'Every 8 hours',
  instructions: 'After food', prescribedBy: doctorAccount, prescribedAt: '2026-11-20T09:03:00.000Z',
  acceptanceReason: 'Handed in at the counter' });
const HANDOFF_ACTION = 'pharmacy.work-item.accept-ehr-prescription';

const sqlError = (code: string) => Object.assign(new Error(`synthetic ${code}`), { code });

interface Options {
  /** The work items row-level security lets this session see (default: ITEMS). */
  items?: Item[];
  /** The notices reader the service is given (default: the real one, on, against this fake database). */
  reader?: PharmacyChangesAfterDispensing;
  /** Raised by the reader's statement, in order (one per statement); then it answers NOTICES. */
  readerErrors?: Error[];
  /** 0125's details on, answering a priority for item 2 (so the notice must still come last). */
  details?: boolean;
}

interface State { audits: unknown[][] }

/**
 * The fake database. Statements run against a working copy of the committed
 * state; COMMIT keeps it, ROLLBACK drops it, and a savepoint rollback goes
 * back to the copy taken at the savepoint, as PostgreSQL does.
 */
function harness(options: Options = {}) {
  const items = options.items ?? ITEMS;
  const rows = new Map(items.map((item) => [id(item.n), workRow(item)]));
  const itemOf = new Map(items.map((item) => [id(item.n), item]));
  const committed: State = { audits: [] };
  const copy = (state: State): State => ({ audits: [...state.audits] });
  const transactions: { statements: { sql: string; values: unknown[] }[]; committed: boolean }[] = [];
  const readerErrors = [...(options.readerErrors ?? [])];

  const answer = (sql: string, values: unknown[], working: State): unknown[] => {
    if (sql === WORK_LIST_QUERY || sql === WORK_LIST_QUERY_0133) return [...rows.values()];
    if (/from pharmacy\.work_items w[\s\S]*where w\.id=\$1$/.test(sql)) {
      const row = rows.get(values[0] as string);
      return row ? [row] : [];
    }
    if (/or w\.source_ehr_prescription_id=\$4/.test(sql)) {
      const item = items.find((entry) => prescriptionId(entry.n) === values[3]);
      return item ? [{ ...workRow(item), request_sha256: requestDigest(HANDOFF_ACTION, handOffInput(item.n)) }] : [];
    }
    if (/from pharmacy\.order_route_access_for/.test(sql)) {
      const workItemId = (sql.includes("('work_item', $1, $2)") ? values[0] : values[1]) as string;
      return itemOf.get(workItemId)?.routed ? [{ outcome: 'allowed', route_id: routeId, work_item_id: workItemId }]
        : [{ outcome: 'none', route_id: null, work_item_id: workItemId }];
    }
    if (/from pharmacy\.own_work_access_for/.test(sql)) return [{ work_item_id: values[1], basis: 'own-work' }];
    if (sql === OWN_WORK_STEPS_QUERY) {
      // ORD-4's reader: own items only; withdrawn only before a dispensing (0133's rule).
      return (values[0] as string[]).filter((workItemId) => !itemOf.get(workItemId)!.routed).map((workItemId) => {
        const item = itemOf.get(workItemId)!;
        const withdrawn = item.withdrawn && !item.dispensed ? item.withdrawn : null;
        return { work_item_id: workItemId, basis: 'own-work', withdrawn: withdrawn !== null, withdrawn_reason: withdrawn,
          sent_automatically: !item.handOff, accepted_at: null, accepted_by_membership_id: null, accepted_with: null };
      });
    }
    if (/from pharmacy\.order_route_cards/.test(sql)) {
      return (values[0] as string[]).filter((workItemId) => itemOf.get(workItemId)!.routed).map((workItemId) => ({
        work_item_id: workItemId, route_id: routeId, reference: 'RX-Q132-0004', effective_state: 'completed',
        access: 'read', ordering_facility_name: 'Fictional Lakeside Hospital', orderer_name: 'Dr Fictional Orderer',
        orderer_licence_body: null, orderer_licence_number: null, patient_full_name: 'Bola Route', patient_sex: 'female',
        patient_date_of_birth: '1990-01-02', patient_health_id_last4: 'Q132', row_version: '3', ended_kind: null }));
    }
    if (/from pharmacy\.work_item_prescription_details/.test(sql)) {
      return (values[0] as string[]).filter((workItemId) => workItemId === id(2)).map((workItemId) => ({
        work_item_id: workItemId, priority: 'urgent', medication_strength: '500 mg', medication_dose_form: 'capsule',
        duration_value: 7, duration_unit: 'day', quantity_to_dispense: '21', quantity_unit: 'capsule' }));
    }
    if (sql === CHANGES_AFTER_DISPENSING_QUERY) {
      const injected = readerErrors.shift();
      if (injected) throw injected;
      return (values[0] as string[]).flatMap((workItemId) => {
        const n = itemOf.get(workItemId)?.n;
        const found = n === undefined ? undefined : NOTICES[n];
        return found ? [{ work_item_id: workItemId, change: found.change, changed_at: at(found.minute),
          change_count: found.count }] : [];
      });
    }
    if (/pharmacy\.order_route_receives_here\(\)/.test(sql)) {
      return [{ receives: true, routes_here: { waiting: false, held: true } }];
    }
    if (/^insert into audit\.events/.test(sql)) { working.audits.push(values); return []; }
    throw new Error(`unexpected statement: ${sql}`);
  };

  const pool = {
    connect: async () => {
      const transaction = { statements: [] as { sql: string; values: unknown[] }[], committed: false };
      transactions.push(transaction);
      let working = copy(committed);
      const savepoints = new Map<string, State>();
      return {
        query: async (sql: string, values: unknown[] = []) => {
          const text = sql.trim();
          transaction.statements.push({ sql: text, values });
          if (text === 'BEGIN' || text.startsWith('SET TRANSACTION') || text.startsWith('select set_config(')) {
            return { rows: [] };
          }
          if (text === 'COMMIT') { Object.assign(committed, working); transaction.committed = true; return { rows: [] }; }
          if (text === 'ROLLBACK') { working = copy(committed); return { rows: [] }; }
          const savepoint = /^savepoint (\w+)$/.exec(text);
          if (savepoint) { savepoints.set(savepoint[1]!, copy(working)); return { rows: [] }; }
          const back = /^rollback to savepoint (\w+)$/.exec(text);
          if (back) { working = copy(savepoints.get(back[1]!)!); return { rows: [] }; }
          if (/^release savepoint \w+$/.test(text)) return { rows: [] };
          return { rows: answer(sql, values, working) };
        },
        release: () => undefined,
      };
    },
    query: async () => ({ rows: [{ orders: true, work: true }] }),
  };
  const database = Object.create(DatabaseService.prototype) as DatabaseService;
  Object.assign(database, { pool, pauseBeforeRetry: async () => undefined });
  const identity = { authorize: jest.fn().mockResolvedValue({ allowed: true, breakGlass: false }) };
  const ownWork = new PharmacyOwnWork(true);
  const service = new PharmacyService(database, identity as unknown as IdentityService, new AuditService(),
    new PharmacyOrderRouteAccess(identity as unknown as IdentityService, ownWork), new PharmacyOrderRouteCards(database),
    OWN_WORK_PATIENT_CARDS_OFF, options.details ? new PharmacyPrescriptionDetails(true) : PRESCRIPTION_DETAILS_OFF, ownWork,
    options.reader ?? new PharmacyChangesAfterDispensing(true));
  /** Audit rows committed: action, patient, resource type and id, and details. */
  const audited = () => committed.audits.map((values) => ({ action: values[7], patientId: values[6],
    resourceType: values[8], resourceId: values[9], details: JSON.parse(values[11] as string) as unknown }));
  const last = () => transactions[transactions.length - 1]!;
  return { service, transactions, audited, last };
}

/**
 * Each statement by what it does, for the order tests: savepoints, BEGIN, SET TRANSACTION and COMMIT as they
 * are (checked first, since a savepoint's name can contain a reader's), every other statement by its reader.
 */
const KINDS: [(sql: string) => boolean, string][] = [
  [(sql) => sql.startsWith('select set_config('), 'session'],
  [(sql) => sql === WORK_LIST_QUERY_0133.trim(), 'list'],
  [(sql) => /where w\.id=\$1$/.test(sql), 'work item'],
  [(sql) => /or w\.source_ehr_prescription_id=\$4/.test(sql), 'replay lookup'],
  [(sql) => /order_route_access_for/.test(sql), 'route access'],
  [(sql) => /own_work_access_for/.test(sql), 'own-work basis'],
  [(sql) => sql === OWN_WORK_STEPS_QUERY.trim(), 'steps'],
  [(sql) => /order_route_cards/.test(sql), 'cards'],
  [(sql) => /work_item_prescription_details/.test(sql), 'details'],
  [(sql) => sql === CHANGES_AFTER_DISPENSING_QUERY.trim(), 'changes'],
  [(sql) => /order_route_receives_here/.test(sql), 'receiving'],
  [(sql) => /^insert into audit\.events/.test(sql), 'audit'],
];
const kind = (sql: string) => (/^(savepoint|release savepoint|rollback to savepoint) /.test(sql) ? sql
  : KINDS.find(([matches]) => matches(sql))?.[1] ?? sql);
const kinds = (transaction: { statements: { sql: string }[] }) => transaction.statements.map((statement) => kind(statement.sql));
const readerStatements = (transaction: { statements: { sql: string; values: unknown[] }[] }) =>
  transaction.statements.filter((statement) => statement.sql === CHANGES_AFTER_DISPENSING_QUERY.trim());

type Answer = Record<string, unknown>;
const listOf = async (h: ReturnType<typeof harness>) => {
  const page = await h.service.listWorkItems(pharmacist);
  return { page, items: page.items as unknown as Answer[] };
};
const byId = (items: Answer[], n: number) => items.find((item) => item.id === id(n))!;
const readOf = async (h: ReturnType<typeof harness>, n: number) =>
  await h.service.getWorkItem(pharmacist, id(n)) as unknown as Answer;
const replayOf = async (h: ReturnType<typeof harness>, n: number) =>
  await h.service.acceptPrescription(pharmacist, handOffInput(n) as never, `q132-handoff-key-${n}`) as unknown as Answer;
/** The answer as it goes out on the wire (dates as ISO text). */
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;
/** A notices reader that answers a notice for every id of ITEMS, whatever it was asked: proves the service's own guards. */
class EveryItem extends PharmacyChangesAfterDispensing {
  readonly asked: string[][] = [];
  constructor() { super(true); }
  override async changes(_client: PoolClient, workItemIds: readonly string[]): Promise<Map<string, ChangedAfterDispensing>> {
    this.asked.push([...workItemIds]);
    return new Map(ITEMS.map((item) => [id(item.n), { change: 'cancelled', changedAt: at(59), changeCount: 1 }]));
  }
}

beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('Q132 A: changedAfterDispensing on the work list', () => {
  it('W1 asks once, for the dispensed rows only, own and route-backed, after the states and details, before the '
    + 'projection', async () => {
    const h = harness({ details: true });
    const { items } = await listOf(h);
    expect(h.transactions).toHaveLength(1);
    const statements = readerStatements(h.last());
    expect(statements).toHaveLength(1);
    // Dispensed rows only, in the list's order: own sent automatically, own handed in, route-backed, reversed.
    expect(statements[0]!.values).toEqual([DISPENSED.map(id)]);
    expect(DISPENSED.map((n) => [n, ITEMS[n - 1]!.routed === true])).toEqual([[2, false], [3, false], [4, true],
      [7, false], [8, false]]);
    // In the list's one transaction: after the rows, the audit rows, the cards, the states and the details,
    // before the receiving facts and the commit.
    expect(kinds(h.last())).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'session',
      'savepoint pharmacy_work_list', 'list', 'release savepoint pharmacy_work_list', 'audit',
      'savepoint pharmacy_order_route_cards', 'cards', 'release savepoint pharmacy_order_route_cards',
      'savepoint pharmacy_own_work_states', 'steps', 'release savepoint pharmacy_own_work_states', 'audit', 'audit',
      'savepoint pharmacy_prescription_details', 'details', 'release savepoint pharmacy_prescription_details',
      'savepoint pharmacy_changes_after_dispensing', 'changes', 'release savepoint pharmacy_changes_after_dispensing',
      'savepoint pharmacy_order_route_receives', 'receiving', 'release savepoint pharmacy_order_route_receives', 'COMMIT']);
    // Before the projection: the answer carries what the reader answered.
    expect(Object.fromEntries(items.filter((item) => 'changedAfterDispensing' in item)
      .map((item) => [item.id, item.changedAfterDispensing]))).toEqual(Object.fromEntries(Object.keys(NOTICES)
      .map((n) => [id(Number(n)), notice(Number(n))])));
  });

  it('W1 asks nothing, not even a savepoint, when no listed row is dispensed', async () => {
    const h = harness({ items: ITEMS.filter((item) => !item.dispensed) });
    const { items } = await listOf(h);
    expect(items.map((item) => item.id)).toEqual(NOT_DISPENSED.map(id));
    expect(kinds(h.last()).filter((entry) => /changes/.test(entry))).toEqual([]);
    expect(items.filter((item) => 'changedAfterDispensing' in item)).toEqual([]);
  });

  it('W2 the notice is the item\'s last field, absent when the reader has none for it', async () => {
    const h = harness({ details: true });
    const { items } = await listOf(h);
    for (const n of Object.keys(NOTICES).map(Number)) {
      const item = byId(items, n);
      expect([n, Object.keys(item).at(-1)]).toEqual([n, 'changedAfterDispensing']);
      expect(Object.keys(item.changedAfterDispensing as object)).toEqual(['change', 'changedAt', 'changeCount']);
    }
    // After 0125's details too (item 2 carries a priority, a duration and a quantity).
    expect(byId(items, 2)).toMatchObject({ priority: 'urgent', duration: { value: 7, unit: 'day' },
      quantityToDispense: 21 });
    // The wire shape of decision 21.
    expect(wire(byId(items, 2).changedAfterDispensing)).toEqual({ change: 'cancelled',
      changedAt: '2026-11-20T09:52:00.000Z', changeCount: 2 });
    // Dispensed and never changed: no key at all.
    expect(byId(items, 8)).not.toHaveProperty('changedAfterDispensing');
    expect(byId(items, 8)).toMatchObject({ dispensing: { reversed: false }, pharmacyStep: 'dispensed' });
  });

  it('W3 never on an item with no dispensing, even when the reader answers one for it', async () => {
    const reader = new EveryItem();
    const h = harness({ reader });
    const { items } = await listOf(h);
    expect(reader.asked).toEqual([DISPENSED.map(id)]);
    expect(items.filter((item) => 'changedAfterDispensing' in item).map((item) => item.id)).toEqual(DISPENSED.map(id));
    for (const n of NOT_DISPENSED) {
      expect(byId(items, n)).toMatchObject({ dispensing: null });
      expect(byId(items, n)).not.toHaveProperty('changedAfterDispensing');
    }
    // A read and a replay of an undispensed item do not ask, and answer no notice.
    for (const n of NOT_DISPENSED) expect(await readOf(h, n)).not.toHaveProperty('changedAfterDispensing');
    expect(await replayOf(h, 9)).not.toHaveProperty('changedAfterDispensing');
    expect(reader.asked).toEqual([DISPENSED.map(id)]);
  });

  it('W4 never together with withdrawn, which exists only before a dispensing', async () => {
    const reader = new EveryItem();
    const h = harness({ reader });
    const { items } = await listOf(h);
    expect(items.filter((item) => item.withdrawn === true).map((item) => [item.id, item.withdrawnReason]))
      .toEqual([[id(6), 'changed']]);
    expect(items.filter((item) => 'withdrawn' in item && 'changedAfterDispensing' in item)).toEqual([]);
    expect(await readOf(h, 6)).toMatchObject({ withdrawn: true, withdrawnReason: 'changed' });
    expect(await readOf(h, 6)).not.toHaveProperty('changedAfterDispensing');
  });

  it('W12 a route-backed row keeps its orderRoute card, with the ordering facility\'s name, next to the notice',
    async () => {
      const { items } = await listOf(harness());
      const { items: before } = await listOf(harness({ reader: CHANGES_AFTER_DISPENSING_OFF }));
      expect(byId(items, 4)).toMatchObject({ orderRoute: { id: routeId, orderingFacilityName: 'Fictional Lakeside Hospital',
        access: 'read', effectiveState: 'completed' }, patient: { fullName: 'Bola Route' },
      changedAfterDispensing: notice(4) });
      expect(byId(items, 4).orderRoute).toEqual(byId(before, 4).orderRoute);
      expect(byId(items, 4).patient).toEqual(byId(before, 4).patient);
    });
});

describe('Q132 A: changedAfterDispensing on a single read and the hand-off replay', () => {
  it('W5 the read answers it for an own and for a route-backed dispensed item, asking for that item alone', async () => {
    const h = harness();
    for (const n of [2, 3, 4, 7]) {
      const item = await readOf(h, n);
      expect([n, item.changedAfterDispensing]).toEqual([n, notice(n)]);
      expect(Object.keys(item).at(-1)).toBe('changedAfterDispensing');
      expect(readerStatements(h.last()).map((statement) => statement.values)).toEqual([[[id(n)]]]);
    }
    // The own read asks after the states; the route-backed one after its card; both after the read's audit row.
    expect(kinds(h.transactions[0]!)).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'session',
      'work item', 'route access', 'savepoint pharmacy_own_work_access', 'own-work basis',
      'release savepoint pharmacy_own_work_access', 'audit', 'savepoint pharmacy_own_work_states', 'steps',
      'release savepoint pharmacy_own_work_states', 'savepoint pharmacy_changes_after_dispensing', 'changes',
      'release savepoint pharmacy_changes_after_dispensing', 'COMMIT']);
    expect(kinds(h.transactions[2]!)).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL READ COMMITTED', 'session',
      'work item', 'route access', 'audit', 'savepoint pharmacy_order_route_cards', 'cards',
      'release savepoint pharmacy_order_route_cards', 'savepoint pharmacy_changes_after_dispensing', 'changes',
      'release savepoint pharmacy_changes_after_dispensing', 'COMMIT']);
    // Dispensed and never changed: asked, and no key.
    const unchanged = await readOf(h, 8);
    expect(unchanged).not.toHaveProperty('changedAfterDispensing');
    expect(readerStatements(h.last())).toHaveLength(1);
  });

  it('W6 the hand-off replay answers it as the read does, in its SERIALIZABLE transaction', async () => {
    const h = harness();
    const read = await readOf(h, 3);
    const replay = await replayOf(h, 3);
    expect(replay.changedAfterDispensing).toEqual(read.changedAfterDispensing);
    expect(replay.changedAfterDispensing).toEqual(notice(3));
    expect(Object.keys(replay).at(-1)).toBe('changedAfterDispensing');
    // The replay keeps answering ORD-4's step as the read does.
    expect([replay.pharmacyStep, replay.pharmacistAcceptance]).toEqual([read.pharmacyStep, read.pharmacistAcceptance]);
    expect(kinds(h.last())).toEqual(['BEGIN', 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE', 'session', 'replay lookup',
      'savepoint pharmacy_own_work_states', 'steps', 'release savepoint pharmacy_own_work_states',
      'savepoint pharmacy_changes_after_dispensing', 'changes', 'release savepoint pharmacy_changes_after_dispensing',
      'COMMIT']);
    expect(readerStatements(h.last()).map((statement) => statement.values)).toEqual([[[id(3)]]]);
    // An item handed in and not dispensed yet: the replay asks nothing new.
    const undispensed = await replayOf(h, 9);
    expect(undispensed).not.toHaveProperty('changedAfterDispensing');
    expect(readerStatements(h.last())).toEqual([]);
  });

  it('W9 a route-backed notice adds no sourceEhrPrescriptionId, sourceEncounterId or any other key', async () => {
    const h = harness();
    const off = harness({ reader: CHANGES_AFTER_DISPENSING_OFF });
    const { items } = await listOf(h);
    const { items: before } = await listOf(off);
    const answers = [[byId(items, 4), byId(before, 4)], [await readOf(h, 4), await readOf(off, 4)]];
    for (const [now, then] of answers) {
      expect(Object.keys(now!)).toEqual([...Object.keys(then!), 'changedAfterDispensing']);
      expect(now).not.toHaveProperty('sourceEhrPrescriptionId');
      expect(now).not.toHaveProperty('sourceEncounterId');
      const { changedAfterDispensing, ...rest } = now!;
      expect(rest).toEqual(then);
      // Only the code, the time and the count: no prescription id, version, encounter or name of the other facility.
      expect(wire(changedAfterDispensing)).toEqual({ change: 'on_hold', changedAt: '2026-11-20T09:54:00.000Z',
        changeCount: 1 });
      expect(JSON.stringify(changedAfterDispensing)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    }
  });
});

describe('Q132 A: the list and the read stay as before when the notice is not there', () => {
  it('W7 a reader failure leaves the list and the read answering, without the field, with one warning each',
    async () => {
      for (const code of ['57014', '42501']) {
        (Logger.prototype.warn as jest.Mock).mockClear();
        const h = harness({ readerErrors: [sqlError(code), sqlError(code)] });
        const off = harness({ reader: CHANGES_AFTER_DISPENSING_OFF });
        const { page } = await listOf(h);
        const { page: before } = await listOf(off);
        expect(page).toEqual(before);
        expect(h.transactions.map((transaction) => transaction.committed)).toEqual([true]);
        expect(await readOf(h, 2)).toEqual(await readOf(off, 2));
        expect((Logger.prototype.warn as jest.Mock).mock.calls).toEqual([
          [{ message: 'Changes after dispensing could not be read', sqlState: code, correlationId: pharmacist.correlationId }],
          [{ message: 'Changes after dispensing could not be read', sqlState: code, correlationId: pharmacist.correlationId }]]);
        // The savepoint was rolled back, so the rest of the transaction went on.
        expect(kinds(h.transactions[0]!)).toContain('rollback to savepoint pharmacy_changes_after_dispensing');
      }
    });

  it('W8 a 40001 from the reader runs the hand-off replay again, which then answers the notice', async () => {
    const h = harness({ readerErrors: [sqlError('40001')] });
    const replay = await replayOf(h, 3);
    expect(replay.changedAfterDispensing).toEqual(notice(3));
    expect(h.transactions.map((transaction) => [transaction.committed,
      kinds(transaction).filter((entry) => entry.startsWith('SET TRANSACTION'))])).toEqual([
      [false, ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE']], [true, ['SET TRANSACTION ISOLATION LEVEL SERIALIZABLE']]]);
    // The cancelled attempt ended at the reader: no savepoint rollback, the whole transaction rolled back.
    expect(kinds(h.transactions[0]!).slice(-3)).toEqual(['savepoint pharmacy_changes_after_dispensing', 'changes',
      'ROLLBACK']);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it('W10 the list\'s and the read\'s audit rows are exactly as before', async () => {
    const h = harness({ details: true });
    const off = harness({ details: true, reader: CHANGES_AFTER_DISPENSING_OFF });
    await listOf(h);
    await listOf(off);
    for (const n of [2, 4, 8]) { await readOf(h, n); await readOf(off, n); }
    expect(h.audited()).toEqual(off.audited());
    // The collection row, the route-backed patient shown, the own patient with 0133's basis, then one row per read.
    expect(h.audited().map((row) => [row.action, row.patientId, row.details])).toEqual([
      ['pharmacy.work-item.list', null, { returnedCount: ITEMS.length }],
      ['pharmacy.work-item.list', bola, { basis: 'order-route', workItemIds: [id(4), id(5)], orderRouteIds: [routeId, routeId] }],
      ['pharmacy.work-item.list', ada, { basis: 'own-work', workItemIds: [1, 2, 3, 6, 7, 8, 9].map(id) }],
      ['pharmacy.work-item.read', ada, { basis: 'own-work' }],
      ['pharmacy.work-item.read', bola, { basis: 'order-route', orderRouteId: routeId }],
      ['pharmacy.work-item.read', ada, { basis: 'own-work' }]]);
    // No audit statement comes after the notices are read.
    const list = kinds(h.transactions[0]!);
    expect(list.lastIndexOf('audit')).toBeLessThan(list.indexOf('changes'));
  });

  it('W11 on a schema without 0148 (42883) every ORD-4 field answers as before, and nothing is logged', async () => {
    const missing = () => Array.from({ length: 8 }, () => sqlError('42883'));
    const h = harness({ readerErrors: missing() });
    const off = harness({ reader: CHANGES_AFTER_DISPENSING_OFF });
    const { page } = await listOf(h);
    const { page: before } = await listOf(off);
    expect(page).toEqual(before);
    for (const n of [2, 3, 4, 7]) expect(await readOf(h, n)).toEqual(await readOf(off, n));
    expect(await replayOf(h, 3)).toEqual(await replayOf(off, 3));
    // ORD-4's fields are there, as on a schema with 0144 and without 0148.
    expect((page.items as unknown as Answer[]).map((item) => [item.id, item.pharmacyStep])).toEqual([
      [id(1), 'received'], [id(2), 'dispensed'], [id(3), 'dispensed'], [id(4), 'dispensed'], [id(5), 'accepted'],
      [id(6), 'received'], [id(7), 'dispensing_reversed'], [id(8), 'dispensed'], [id(9), 'accepted']]);
    expect((page.items as unknown as Answer[]).filter((item) => 'changedAfterDispensing' in item)).toEqual([]);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });
});

describe('Q132 A: wiring', () => {
  const provider = () => (Reflect.getMetadata('providers', PharmacyModule) as unknown[]).find((entry) =>
    typeof entry === 'object' && entry !== null
    && (entry as { provide?: unknown }).provide === PharmacyChangesAfterDispensing) as
    { provide: unknown; useFactory: () => PharmacyChangesAfterDispensing };
  const others = [
    { provide: DatabaseService, useValue: {} }, { provide: 'IdentityService', useValue: {} },
    { provide: AuditService, useValue: {} }, { provide: PharmacyOrderRouteAccess, useValue: {} },
    { provide: PharmacyOrderRouteCards, useValue: {} },
    { provide: PharmacyOwnWorkPatientCards, useValue: OWN_WORK_PATIENT_CARDS_OFF },
    { provide: PharmacyPrescriptionDetails, useValue: PRESCRIPTION_DETAILS_OFF },
    { provide: PharmacyOwnWork, useValue: new PharmacyOwnWork(false) }];
  const identityToken = () => (Reflect.getMetadata('design:paramtypes', PharmacyService) as unknown[])[1];
  const build = (extra: unknown[]) => Test.createTestingModule({ providers: [PharmacyService,
    ...others.map((entry) => (entry.provide === 'IdentityService' ? { ...entry, provide: identityToken() } : entry)),
    ...extra] as never[] }).compile();

  it('is provided always on by PharmacyModule (no environment setting), as the service\'s last parameter', () => {
    expect(provider().useFactory().enabled).toBe(true);
    const types = Reflect.getMetadata('design:paramtypes', PharmacyService) as unknown[];
    expect(types).toHaveLength(9);
    expect(types[8]).toBe(PharmacyChangesAfterDispensing);
  });

  it('is what Nest injects from the module\'s provider; without one (a module built before Q132) it is off', async () => {
    const withIt = await build([provider()]);
    const injected = (withIt.get(PharmacyService) as unknown as { dispensedChanges: PharmacyChangesAfterDispensing })
      .dispensedChanges;
    expect(injected).toBeInstanceOf(PharmacyChangesAfterDispensing);
    expect(injected.enabled).toBe(true);
    const without = await build([]);
    expect((without.get(PharmacyService) as unknown as { dispensedChanges: unknown }).dispensedChanges)
      .toBe(CHANGES_AFTER_DISPENSING_OFF);
  });
});
