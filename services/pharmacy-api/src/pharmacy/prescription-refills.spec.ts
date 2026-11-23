import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { getEnvironment, resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import type { IdentityService } from '../identity/identity.service';
import { CHANGES_AFTER_DISPENSING_QUERY, PharmacyChangesAfterDispensing } from './changes-after-dispensing';
import { PharmacyOrderRouteAccess } from './order-route-access';
import { PharmacyOrderRouteCards } from './order-route-cards';
import { OWN_WORK_STATES_QUERY, OWN_WORK_STEPS_QUERY, PharmacyOwnWork } from './own-work-access';
import { OWN_WORK_PATIENT_CARDS_OFF, PharmacyOwnWorkPatientCards } from './own-work-patient-cards';
import { PharmacyModule } from './pharmacy.module';
import { DISPENSING_REPLAY_QUERY, INSERT_DISPENSING, LATER_FILL_QUERY, PharmacyService, WORK_ITEM_SELECT,
  WORK_LIST_QUERY, WORK_LIST_QUERY_0133 } from './pharmacy.service';
import { PharmacyPrescriptionDetails, PRESCRIPTION_DETAILS_OFF } from './prescription-dispensing-details';
import { CreateDispensingBodyPipe, DISPENSING_KEY_CONSTRAINT, FILL_KEY_CONSTRAINT, PharmacyRefills,
  REFILL_CANDIDATES_QUERY, REFILLS_OFF, WORK_ITEM_REFILLS_QUERY, dispensingDigestInput } from './prescription-refills';
import { workListSince } from './work-list-window';

/*
 * ORD-12 (refills; owner decision Q131 A, 19 November 2026; the clinical
 * owner's design note on hid-system#258, Rahman's review and the clinical
 * owner's answers, 23 November 2026; migration 0152) in pharmacy-api. The
 * database is faked with tables (work items, fills, reversals, the outbox and
 * the audit rows) and answers each of pharmacy-api's statements as PostgreSQL
 * answers it on a database with 0152 (the same statements were run against
 * PostgreSQL 16 with 0152, under a superuser and a NOSUPERUSER NOBYPASSRLS
 * owner, through the Pharmacy runtime); every statement runs through the real
 * DatabaseService (its SERIALIZABLE retry) and the real AuditService. 0152's
 * reader answers what each fictional prescription allows. Fictional ids and
 * names only.
 */

const facilityId = '10000000-0000-4000-8000-000000000152';
const orderingFacilityId = '10000000-0000-4000-8000-000000000252';
const pharmacistAccount = '20000000-0000-4000-8000-0000000002a1';
const pharmacistMembership = '40000000-0000-4000-8000-0000000002a1';
const colleagueAccount = '20000000-0000-4000-8000-0000000002a2';
const doctorAccount = '20000000-0000-4000-8000-0000000002d1';
const routeId = '80000000-0000-4000-8000-0000000002c1';
const ada = '50000000-0000-4000-8000-0000000002e1';
const id = (n: number) => `15200000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const fillId = (n: number, fill: number) => `65200000-0000-4000-8${String(fill).padStart(3, '0')}-${String(n).padStart(12, '0')}`;
const DAY = 86_400_000;
const NOW = Date.now();
const ago = (days: number, minute = 0) => new Date(NOW - days * DAY + minute * 60_000);

const pharmacist: DataAccessContext = { correlationId: 'ord12-correlation-0001', facilityId,
  membershipId: pharmacistMembership, purposeOfUse: 'direct-care', authorization: 'Bearer pharmacist', actor: {
    id: pharmacistAccount, subject: 'staff:pharmacist-ord12', accountId: pharmacistAccount, authenticationMethod: 'local',
    roles: ['pharmacist'], permissions: ['pharmacy.work-item.read', 'pharmacy.dispensing.create',
      'pharmacy.dispensing.reverse'], facilityIds: [facilityId], facilities: [],
    facility: { id: facilityId, membershipId: pharmacistMembership, organizationId: facilityId,
      name: 'Fictional Riverside Hospital', roles: ['pharmacist'], permissions: [], isPrimary: true } } };

/** A fictional work item: who sent it, when it was received, what its prescription allows (0152's reader). */
interface Item {
  n: number;
  /** Another facility's prescription, accepted with its order route (one fill). */
  routed?: boolean;
  /** Days since it was received (`accepted_at`). */
  received?: number;
  /** The refills the prescription allows (null as 0). */
  refills?: number;
  /** Why the reader says no fill is open after the first, when it is not `none_left`. */
  closed?: 'changed' | 'stopped' | 'ended';
  /** The fills already recorded: their age in days, and whether each was reversed. */
  fills?: { days: number; reversed?: boolean; by?: string; key?: string; body?: Record<string, unknown> }[];
  /** `ends_on` (YYYY-MM-DD), the prescription's as accepted. */
  endsOn?: string;
}

interface FillRow {
  id: string; work_item_id: string; work_item_version: string; patient_id: string; facility_id: string;
  medication_code_system: null; medication_code: null; medication_display: string; quantity_dispensed: string;
  quantity_unit: string; status: 'dispensed'; dispensed_by: string; dispensed_by_membership_id: string;
  dispensed_at: Date; reason: string; idempotency_key: string; request_sha256: string; correlation_id: string;
  row_version: string; created_at: Date; fill_number: number;
}
interface ReversalRow {
  id: string; dispensing_id: string; dispensing_version: string; work_item_id: string; patient_id: string;
  facility_id: string; status: 'reversed'; reversed_by: string; reversed_at: Date; row_version: string;
  created_at: Date; idempotency_key: string; request_sha256: string;
}
interface State { fills: FillRow[]; reversals: ReversalRow[]; outbox: { type: string; payload: unknown }[]; audits: unknown[][] }

const body = { expectedWorkItemVersion: 1, quantityDispensed: 30, quantityUnit: 'tablet',
  reason: 'Handed to the patient with counselling' };
const digestOf = (n: number, input: Record<string, unknown>) =>
  requestDigest('pharmacy.dispensing.create', { workItemId: id(n), ...dispensingDigestInput(input as never) });

const sqlError = (code: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`synthetic ${code}`), { code }, extra);

interface Options {
  items: Item[];
  /** PRESCRIPTION_REFILLS_ENABLED. */
  on?: boolean;
  /** Raised by 0152's reader, one per statement, then it answers. */
  readerErrors?: Error[];
  /** Raised by the candidates statement. */
  candidatesError?: Error;
  /** Raised by the next dispensing INSERTs (the database's own refusals), in order. */
  insertErrors?: Error[];
  /**
   * A fill another request commits while this request's INSERT runs (the race of two fills): the INSERT then fails
   * 23505 on the key it meets, as PostgreSQL answers once the winner commits.
   */
  race?: { n: number; fill: number; by?: string; key?: string; body?: Record<string, unknown>; hidden?: boolean };
  /** A fill row-level security hides from this member (its key still taken in the index). */
  hiddenFills?: { n: number; fill: number; key?: string }[];
}

function harness(options: Options) {
  const items = options.items;
  const itemOf = new Map(items.map((item) => [id(item.n), item]));
  const fillRow = (item: Item, fill: number, entry: NonNullable<Item['fills']>[number]): FillRow => ({
    id: fillId(item.n, fill), work_item_id: id(item.n), work_item_version: '1', patient_id: ada, facility_id: facilityId,
    medication_code_system: null, medication_code: null, medication_display: 'Amlodipine 5 mg tablet',
    quantity_dispensed: '30', quantity_unit: 'tablet', status: 'dispensed', dispensed_by: entry.by ?? pharmacistAccount,
    dispensed_by_membership_id: pharmacistMembership, dispensed_at: ago(entry.days), reason: 'Handed over',
    idempotency_key: entry.key ?? `ord12-seeded-key-${item.n}-${fill}-000000`,
    request_sha256: digestOf(item.n, { ...body, ...(entry.body ?? {}), ...(fill > 1 ? { fillNumber: fill } : {}) }),
    correlation_id: 'ord12-seeded-0001', row_version: '1', created_at: ago(entry.days), fill_number: fill });
  const committed: State = { fills: [], reversals: [], outbox: [], audits: [] };
  for (const item of items) {
    for (const [index, entry] of (item.fills ?? []).entries()) {
      const row = fillRow(item, index + 1, entry);
      committed.fills.push(row);
      if (entry.reversed) committed.reversals.push({ id: `66200000-0000-4000-8000-${String(item.n * 100 + index + 1)
        .padStart(12, '0')}`, dispensing_id: row.id, dispensing_version: '1', work_item_id: row.work_item_id,
      patient_id: ada, facility_id: facilityId, status: 'reversed', reversed_by: pharmacistAccount,
      reversed_at: ago(entry.days, 5), row_version: '1', created_at: ago(entry.days, 5),
      idempotency_key: `ord12-seeded-reversal-${item.n}-${index + 1}`, request_sha256: 'e'.repeat(64) });
    }
  }
  const hidden = new Set((options.hiddenFills ?? []).map((entry) => fillId(entry.n, entry.fill)));
  for (const entry of options.hiddenFills ?? []) {
    committed.fills.push(fillRow(itemOf.get(id(entry.n))!, entry.fill, { days: 0, key: entry.key, by: colleagueAccount }));
  }
  const copy = (state: State): State => ({ fills: [...state.fills], reversals: [...state.reversals],
    outbox: [...state.outbox], audits: [...state.audits] });
  const statements: { sql: string; values: unknown[] }[] = [];
  const readerErrors = [...(options.readerErrors ?? [])];
  const insertErrors = [...(options.insertErrors ?? [])];
  let race = options.race;
  let inserts = 0;

  const visible = (state: State) => state.fills.filter((row) => !hidden.has(row.id));
  const fillsOf = (state: State, workItemId: string) => visible(state).filter((row) => row.work_item_id === workItemId)
    .sort((a, b) => a.fill_number - b.fill_number);
  const reversalOf = (state: State, dispensingId: string) => state.reversals.find((row) => row.dispensing_id === dispensingId);
  /** WORK_ITEM_SELECT's row: the item once, with its latest fill (0152: by fill number) and its count. */
  const workRow = (state: State, item: Item) => {
    const fills = fillsOf(state, id(item.n));
    const latest = fills[fills.length - 1];
    return { id: id(item.n), patient_id: ada, facility_id: facilityId,
      ordering_facility_id: item.routed ? orderingFacilityId : facilityId, source_ehr_prescription_id: `30000000-0000-4000-8000-${String(item.n).padStart(12, '0')}`,
      source_ehr_prescription_version: '1', source_encounter_id: '70000000-0000-4000-8000-0000000002b1',
      source_status: 'active', status: 'accepted', medication_code_system: null, medication_code: null,
      medication_display: 'Amlodipine 5 mg tablet', dose_quantity: '1', dose_unit: 'tablet', route_code: 'oral',
      frequency: 'Once daily', instructions: 'In the morning', starts_on: null, ends_on: item.endsOn ?? null,
      prescribed_by: doctorAccount, prescribed_at: ago(item.received ?? 1), accepted_by: doctorAccount,
      accepted_by_membership_id: '40000000-0000-4000-8000-0000000002d1', accepted_at: ago(item.received ?? 1, item.n),
      row_version: '1', created_at: ago(item.received ?? 1), order_route_id: item.routed ? routeId : null,
      dispensing_id: latest?.id ?? null, dispensing_status: latest ? 'dispensed' : null,
      reversal_id: latest ? reversalOf(state, latest.id)?.id ?? null : null,
      dispensing_fill_number: latest?.fill_number ?? null, last_filled_at: latest?.dispensed_at ?? null,
      fills_recorded: fills.length };
  };
  /** What 0152's reader answers for an own item. */
  const refillsRow = (state: State, item: Item) => {
    const allowed = item.refills ?? 0;
    const recorded = state.fills.filter((row) => row.work_item_id === id(item.n)).length;
    const closed = recorded === 0 ? null : recorded >= 1 + allowed ? 'none_left' : item.closed ?? null;
    return { work_item_id: id(item.n), refills_allowed: allowed, fills_recorded: recorded,
      refill_open: recorded >= 1 && closed === null, closed_reason: closed };
  };
  const today = new Date(NOW).toISOString().slice(0, 10);

  const answer = (sql: string, values: unknown[], working: State): unknown[] => {
    if (sql === WORK_LIST_QUERY || sql === WORK_LIST_QUERY_0133) {
      const since = new Date(`${values[0] as string}T00:00:00+01:00`);
      const refillOpen = new Set(values[1] as string[]);
      const rows = items.map((item) => workRow(working, item)).map((row) => ({ row,
        open: row.dispensing_id === null || refillOpen.has(row.id),
        refill: row.dispensing_id !== null && refillOpen.has(row.id) }))
        .filter((entry) => entry.open || entry.row.accepted_at >= since);
      rows.sort((a, b) => Number(b.open) - Number(a.open) || Number(a.refill) - Number(b.refill)
        || (a.open ? a.row.accepted_at.getTime() - b.row.accepted_at.getTime() : b.row.accepted_at.getTime() - a.row.accepted_at.getTime()));
      return rows.slice(0, 200).map((entry) => entry.row);
    }
    if (sql === `${WORK_ITEM_SELECT} where w.id=$1`) {
      const item = itemOf.get(values[0] as string);
      return item ? [workRow(working, item)] : [];
    }
    if (sql === REFILL_CANDIDATES_QUERY) {
      if (options.candidatesError) throw options.candidatesError;
      return items.filter((item) => !item.routed && (item.endsOn === undefined || item.endsOn >= today))
        .map((item) => ({ item, fills: fillsOf(working, id(item.n)) }))
        .filter((entry) => entry.fills.length >= 1 && entry.fills.length <= 11)
        .sort((a, b) => b.fills[b.fills.length - 1]!.dispensed_at.getTime() - a.fills[a.fills.length - 1]!.dispensed_at.getTime())
        .slice(0, 200).map((entry) => ({ work_item_id: id(entry.item.n) }));
    }
    if (sql === WORK_ITEM_REFILLS_QUERY) {
      const injected = readerErrors.shift();
      if (injected) throw injected;
      const asked = values[0] as string[];
      if (asked.length > 200) throw sqlError('22023', { message: 'WORK_ITEM_REFILLS_INVALID' });
      return asked.map((workItemId) => itemOf.get(workItemId)).filter((item): item is Item => Boolean(item && !item.routed))
        .map((item) => refillsRow(working, item));
    }
    if (sql === DISPENSING_REPLAY_QUERY) {
      const [facility, account, key, workItemId, fill] = values as [string, string, string, string, number];
      return visible(working).filter((row) => (row.facility_id === facility && row.dispensed_by === account
        && row.idempotency_key === key) || (row.work_item_id === workItemId && row.fill_number === fill))
        .map((row) => ({ ...row, reversal_id: reversalOf(working, row.id)?.id ?? null,
          reversed_at: reversalOf(working, row.id)?.reversed_at ?? null,
          by_key: row.facility_id === facility && row.dispensed_by === account && row.idempotency_key === key }))
        .sort((a, b) => Number(b.by_key) - Number(a.by_key));
    }
    if (sql === INSERT_DISPENSING) {
      inserts += 1;
      const [rowId, workItemId,,,,,,, quantity, unit, account,,reason, key, digest, correlation, fill] = values as
        [string, string, number, string, string, null, null, string, number, string, string, string, string, string,
          string, string, number];
      if (race) {
        const item = itemOf.get(id(race.n))!;
        const winner = fillRow(item, race.fill, { days: 0, by: race.by ?? colleagueAccount, key: race.key, body: race.body });
        committed.fills.push(winner);
        if (race.hidden) hidden.add(winner.id);
        const conflict = race.key === key && (race.by ?? colleagueAccount) === account;
        race = undefined;
        throw sqlError('23505', { constraint: conflict ? DISPENSING_KEY_CONSTRAINT : FILL_KEY_CONSTRAINT });
      }
      const injected = insertErrors.shift();
      if (injected) throw injected;
      if (working.fills.some((row) => row.work_item_id === workItemId && row.fill_number === fill)) {
        throw sqlError('23505', { constraint: FILL_KEY_CONSTRAINT });
      }
      if (working.fills.some((row) => row.facility_id === facilityId && row.dispensed_by === account
        && row.idempotency_key === key)) throw sqlError('23505', { constraint: DISPENSING_KEY_CONSTRAINT });
      const row: FillRow = { id: rowId, work_item_id: workItemId, work_item_version: '1', patient_id: ada,
        facility_id: facilityId, medication_code_system: null, medication_code: null,
        medication_display: 'Amlodipine 5 mg tablet', quantity_dispensed: String(quantity), quantity_unit: unit,
        status: 'dispensed', dispensed_by: account, dispensed_by_membership_id: pharmacistMembership,
        dispensed_at: new Date(), reason, idempotency_key: key, request_sha256: digest, correlation_id: correlation,
        row_version: '1', created_at: new Date(), fill_number: fill };
      working.fills.push(row);
      return [row];
    }
    if (/from pharmacy\.dispensings d left join pharmacy\.dispensing_reversals r on r\.dispensing_id=d\.id\s+where d\.id=\$1$/.test(sql)) {
      const row = visible(working).find((entry) => entry.id === values[0]);
      return row ? [{ ...row, reversal_id: reversalOf(working, row.id)?.id ?? null,
        reversed_at: reversalOf(working, row.id)?.reversed_at ?? null }] : [];
    }
    if (sql === LATER_FILL_QUERY) {
      return [{ later: working.fills.some((row) => row.work_item_id === values[0] && row.fill_number > (values[1] as number)) }];
    }
    if (/^select \* from pharmacy\.dispensing_reversals/.test(sql)) {
      return working.reversals.filter((row) => (row.facility_id === values[0] && row.reversed_by === values[1]
        && row.idempotency_key === values[2]) || row.dispensing_id === values[3]);
    }
    if (/^insert into pharmacy\.dispensing_reversals/.test(sql)) {
      const [rowId, dispensingId, version, workItemId,,, account,, , key, digest] = values as string[];
      const row: ReversalRow = { id: rowId!, dispensing_id: dispensingId!, dispensing_version: String(version),
        work_item_id: workItemId!, patient_id: ada, facility_id: facilityId, status: 'reversed', reversed_by: account!,
        reversed_at: new Date(), row_version: '1', created_at: new Date(), idempotency_key: key!, request_sha256: digest! };
      working.reversals.push(row);
      return [row];
    }
    if (/^insert into pharmacy\.outbox_events/.test(sql)) {
      working.outbox.push({ type: values[0] as string, payload: JSON.parse(values[6] as string) });
      return [];
    }
    if (/^insert into audit\.events/.test(sql)) { working.audits.push(values); return []; }
    if (/from pharmacy\.order_route_access_for/.test(sql)) {
      const resourceId = (sql.includes("('work_item', $1, $2)") ? values[0] : values[1]) as string;
      const workItemId = itemOf.has(resourceId) ? resourceId
        : working.fills.find((row) => row.id === resourceId)?.work_item_id;
      return itemOf.get(workItemId ?? '')?.routed ? [{ outcome: 'allowed', route_id: routeId, work_item_id: workItemId }]
        : [{ outcome: 'none', route_id: null, work_item_id: workItemId ?? null }];
    }
    if (/from pharmacy\.own_work_access_for/.test(sql)) return [{ work_item_id: values[1], basis: 'own-work' }];
    if (sql === OWN_WORK_STEPS_QUERY || sql === OWN_WORK_STATES_QUERY) {
      return (values[0] as string[]).filter((workItemId) => !itemOf.get(workItemId)?.routed).map((workItemId) => ({
        work_item_id: workItemId, basis: 'own-work', withdrawn: false, withdrawn_reason: null, sent_automatically: false,
        accepted_at: null, accepted_by_membership_id: null, accepted_with: null }));
    }
    if (/from pharmacy\.order_route_cards/.test(sql)) {
      return (values[0] as string[]).filter((workItemId) => itemOf.get(workItemId)?.routed).map((workItemId) => ({
        work_item_id: workItemId, route_id: routeId, reference: 'RX-ORD12-0001', effective_state: 'completed',
        access: 'read', ordering_facility_name: 'Fictional Lakeside Hospital', orderer_name: 'Dr Fictional Orderer',
        orderer_licence_body: null, orderer_licence_number: null, patient_full_name: 'Ada Refill', patient_sex: 'female',
        patient_date_of_birth: '1990-04-05', patient_health_id_last4: 'RF12', row_version: '3', ended_kind: null }));
    }
    if (sql === CHANGES_AFTER_DISPENSING_QUERY) return [];
    if (/pharmacy\.order_route_receives_here\(\)/.test(sql)) return [{ receives: true, routes_here: { waiting: false, held: false } }];
    throw new Error(`unexpected statement: ${sql}`);
  };

  const pool = {
    connect: async () => {
      let working = copy(committed);
      const savepoints = new Map<string, State>();
      return {
        query: async (sql: string, values: unknown[] = []) => {
          const text = sql.trim();
          statements.push({ sql: text, values });
          if (text === 'BEGIN' || text.startsWith('SET TRANSACTION') || text.startsWith('select set_config(')) return { rows: [] };
          if (text === 'COMMIT') { Object.assign(committed, working); return { rows: [] }; }
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
  const refills = new PharmacyRefills(options.on ?? false);
  const service = new PharmacyService(database, identity as unknown as IdentityService, new AuditService(),
    new PharmacyOrderRouteAccess(identity as unknown as IdentityService, ownWork), new PharmacyOrderRouteCards(database),
    OWN_WORK_PATIENT_CARDS_OFF, PRESCRIPTION_DETAILS_OFF, ownWork, new PharmacyChangesAfterDispensing(true), refills);
  const audited = () => committed.audits.map((values) => ({ action: values[7], resourceId: values[9],
    details: JSON.parse(values[11] as string) as Record<string, unknown> }));
  const sent = (predicate: (sql: string) => boolean) => statements.filter((statement) => predicate(statement.sql));
  return { service, committed, statements, audited, sent, inserts: () => inserts };
}

type Answer = Record<string, unknown>;
const listOf = async (h: ReturnType<typeof harness>) => (await h.service.listWorkItems(pharmacist)).items as unknown as Answer[];
const readOf = async (h: ReturnType<typeof harness>, n: number) => await h.service.getWorkItem(pharmacist, id(n)) as unknown as Answer;
const dispense = (h: ReturnType<typeof harness>, n: number, key: string, extra: Record<string, unknown> = {}) =>
  h.service.dispense(pharmacist, id(n), { ...body, ...extra } as never, key) as Promise<Answer>;
const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DomainProblem) return { status: error.getStatus(), code: error.code, ...(error.extensions ?? {}) };
    throw error;
  }
  throw new Error('expected a refusal');
};
const wire = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

/** Today's fields of a work item, in today's order (Release B with 0148), and nothing else. */
const TODAY_KEYS = ['id', 'patientId', 'facilityId', 'sourceEhrPrescriptionId', 'sourceEncounterId',
  'sourceEhrPrescriptionVersion', 'status', 'medication', 'doseQuantity', 'doseUnit', 'routeCode', 'frequency',
  'instructions', 'acceptedAt', 'version', 'dispensing', 'pharmacyStep', 'pharmacistAcceptance'];

/** Item 1: three fills (refills 2), the second reversed; item 2: no fill; item 3: one fill, refills 1 (open). */
const SEVERAL: Item[] = [
  { n: 1, refills: 2, received: 20, fills: [{ days: 19 }, { days: 9, reversed: true }, { days: 2 }] },
  { n: 2, refills: 2, received: 3 },
  { n: 3, refills: 1, received: 5, fills: [{ days: 4 }] },
];

beforeEach(() => jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined));
afterEach(() => jest.restoreAllMocks());

describe('ORD-12: one row per item, whatever the setting', () => {
  it.each([[false], [true]])('R1 the work list answers an item with three fills once, with its latest fill (on: %p)',
    async (on) => {
      const h = harness({ items: SEVERAL, on });
      const items = await listOf(h);
      expect(items.map((item) => item.id)).toEqual(on ? [id(2), id(3), id(1)] : [id(2), id(3), id(1)]);
      expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
      const three = items.find((item) => item.id === id(1))!;
      // The latest fill (3), not the reversed second one nor the first.
      expect(three.dispensing).toEqual({ id: fillId(1, 3), status: 'dispensed', reversed: false, ...(on ? { fillNumber: 3 } : {}) });
      expect(three.pharmacyStep).toBe('dispensed');
      // Every statement that reads work items and their fills reads each item once (WORK_ITEM_SELECT).
      const reads = h.sent((sql) => /pharmacy\.dispensings/.test(sql) && /pharmacy\.work_items w/.test(sql));
      expect(reads.length).toBeGreaterThan(0);
      for (const statement of reads) {
        expect(statement.sql).not.toMatch(/left join pharmacy\.dispensings d on/);
      }
    });

  it('R2 setting off: the answers are today\'s fields only, the statements today\'s plus the latest-fill read', async () => {
    const h = harness({ items: SEVERAL });
    const items = await listOf(h);
    for (const item of items) expect(Object.keys(item)).toEqual(TODAY_KEYS);
    expect(Object.keys(await readOf(h, 1))).toEqual(TODAY_KEYS);
    // No reader, no candidates, no new parameter but an empty list of open refills.
    expect(h.sent((sql) => sql === WORK_ITEM_REFILLS_QUERY || sql === REFILL_CANDIDATES_QUERY)).toEqual([]);
    expect(h.sent((sql) => sql === WORK_LIST_QUERY_0133).map((statement) => statement.values[1])).toEqual([[]]);
    // Item 3 still has a refill open in the database, but off it is done work like any dispensed item.
    expect(items.map((item) => [item.id, item.dispensing === null])).toEqual([[id(2), true], [id(3), false], [id(1), false]]);
  });

  it('R3 WORK_ITEM_SELECT takes the latest fill by number, with its time and the item\'s count, in one probe per item', () => {
    const flat = WORK_ITEM_SELECT.replace(/\s+/g, ' ');
    expect(flat).toContain('left join lateral (select df.id,df.status,df.fill_number,df.dispensed_at,'
      + '(count(*) over ())::integer as fills_recorded from pharmacy.dispensings df where df.work_item_id=w.id '
      + 'order by df.fill_number desc limit 1) d on true');
    expect(flat).toContain('left join pharmacy.dispensing_reversals r on r.dispensing_id=d.id');
    expect(flat.startsWith('select w.*,d.id::text as dispensing_id,d.status as dispensing_status, r.id::text as reversal_id,'))
      .toBe(true);
  });

  it('R4 a single read answers the latest fill; reversed is that fill\'s', async () => {
    const reversedLast: Item[] = [{ n: 4, refills: 2, fills: [{ days: 3 }, { days: 1, reversed: true }] }];
    for (const on of [false, true]) {
      const read = await readOf(harness({ items: reversedLast, on }), 4);
      expect(read.dispensing).toEqual({ id: fillId(4, 2), status: 'dispensed', reversed: true, ...(on ? { fillNumber: 2 } : {}) });
      expect(read.pharmacyStep).toBe('dispensing_reversed');
    }
  });
});

describe('ORD-12: refills on the work item (setting on)', () => {
  it('F1 an own item carries refills from 0152\'s reader; lastFilledAt and the latest fill\'s number', async () => {
    const h = harness({ items: SEVERAL, on: true });
    const items = await listOf(h);
    const byId = (n: number) => items.find((item) => item.id === id(n))!;
    expect(byId(1).refills).toEqual({ allowed: 2, recorded: 3, open: false, closedReason: 'none_left' });
    expect(byId(2).refills).toEqual({ allowed: 2, recorded: 0, open: false, closedReason: null });
    expect(byId(3).refills).toEqual({ allowed: 1, recorded: 1, open: true, closedReason: null });
    expect(wire(byId(1).lastFilledAt)).toBe(ago(2).toISOString());
    expect(byId(2)).not.toHaveProperty('lastFilledAt');
    // After today's fields, before Q132's notice (none here): refills last, lastFilledAt before it.
    expect(Object.keys(byId(1))).toEqual([...TODAY_KEYS, 'lastFilledAt', 'refills']);
    expect(Object.keys(byId(2))).toEqual([...TODAY_KEYS, 'refills']);
  });

  it('F2 the reader is asked for the candidates first, then once for the shown own rows it has not answered', async () => {
    const h = harness({ items: SEVERAL, on: true });
    await listOf(h);
    const asked = h.sent((sql) => sql === WORK_ITEM_REFILLS_QUERY).map((statement) => statement.values[0]);
    // Candidates: own items with 1-11 fills, the latest fill first (item 3's fill is older than item 1's third).
    expect(asked).toEqual([[id(1), id(3)], [id(2)]]);
    const order = h.statements.map((statement) => statement.sql).filter((sql) => sql === REFILL_CANDIDATES_QUERY
      || sql === WORK_ITEM_REFILLS_QUERY || sql === WORK_LIST_QUERY_0133);
    expect(order).toEqual([REFILL_CANDIDATES_QUERY, WORK_ITEM_REFILLS_QUERY, WORK_LIST_QUERY_0133, WORK_ITEM_REFILLS_QUERY]);
  });

  it('F3 a route-backed item carries one fill and none allowed, without asking the reader about it', async () => {
    const items: Item[] = [{ n: 5, routed: true, fills: [{ days: 1 }] }, { n: 6, routed: true }];
    const h = harness({ items, on: true });
    const listed = await listOf(h);
    expect(listed.map((item) => [item.id, item.refills])).toEqual([
      [id(6), { allowed: 0, recorded: 0, open: false, closedReason: null }],
      [id(5), { allowed: 0, recorded: 1, open: false, closedReason: 'none_left' }]]);
    expect(h.sent((sql) => sql === WORK_ITEM_REFILLS_QUERY)).toEqual([]);
    expect((await readOf(h, 5)).refills).toEqual({ allowed: 0, recorded: 1, open: false, closedReason: 'none_left' });
    // No prescription id or encounter of the other facility comes with it (PRIV P4.3).
    expect(listed[1]).not.toHaveProperty('sourceEhrPrescriptionId');
  });

  it.each([['changed'], ['stopped'], ['ended']] as const)('F4 the closed reason %s is answered as the reader gives it',
    async (closed) => {
      const h = harness({ items: [{ n: 7, refills: 2, closed, fills: [{ days: 1 }] }], on: true });
      expect((await readOf(h, 7)).refills).toEqual({ allowed: 2, recorded: 1, open: false, closedReason: closed });
    });

  it('F5 a reader that fails leaves refills out and opens no item; it never fails the list or the read', async () => {
    const failing = () => [sqlError('42883'), sqlError('57014'), sqlError('42501')];
    const h = harness({ items: SEVERAL, on: true, readerErrors: failing() });
    const items = await listOf(h);
    expect(items.map((item) => item.id)).toEqual([id(2), id(3), id(1)]);
    for (const item of items) expect(item).not.toHaveProperty('refills');
    expect(h.sent((sql) => /^rollback to savepoint pharmacy_work_item_refills$/.test(sql))).toHaveLength(2);
    expect(await readOf(h, 3)).not.toHaveProperty('refills');
    expect(Logger.prototype.warn).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Refills on own work could not be read', sqlState: '42883' }));
    const noCandidates = harness({ items: SEVERAL, on: true, candidatesError: sqlError('57014') });
    expect((await listOf(noCandidates)).map((item) => item.id)).toEqual([id(2), id(3), id(1)]);
  });

  it('F6 a closed reason this image does not know is answered as null, never passed on', () => {
    expect(new PharmacyRefills(true).forRow({ order_route_id: null }, { work_item_id: id(1), refills_allowed: 2,
      fills_recorded: 1, refill_open: false, closed_reason: 'something_new' })).toEqual({ allowed: 2, recorded: 1,
      open: false, closedReason: null });
    expect(REFILLS_OFF.forRow({ order_route_id: null }, { work_item_id: id(1), refills_allowed: 2, fills_recorded: 1,
      refill_open: true, closed_reason: null })).toBeUndefined();
  });

  it('F7 the reader is asked at most 200 ids a statement', async () => {
    const refills = new PharmacyRefills(true);
    const query = jest.fn(async (sql: string, values?: unknown[]) => ({
      rows: sql === WORK_ITEM_REFILLS_QUERY ? (values![0] as string[]).map((workItemId) => ({ work_item_id: workItemId,
        refills_allowed: 0, fills_recorded: 0, refill_open: false, closed_reason: null })) : [] }));
    const ids = Array.from({ length: 450 }, (_, index) => id(1000 + index));
    const found = await refills.read({ query } as never, ids, 'ord12-correlation-0002');
    expect(found.size).toBe(450);
    expect(query.mock.calls.filter(([sql]) => sql === WORK_ITEM_REFILLS_QUERY).map(([, values]) => (values![0] as string[]).length))
      .toEqual([200, 200, 50]);
  });
});

describe('ORD-12: open work on the list (setting on)', () => {
  // Item 10: received 200 days ago, two fills, refills 3, one still open; item 11: received 200 days ago, one fill,
  // none left; item 12: received 120 days ago, no fill; item 13: received 2 days ago, one fill, refills 0;
  // item 14: received 30 days ago, one fill, refills 2 but its prescription changed; item 15: received today, no fill.
  const OLD: Item[] = [
    { n: 10, refills: 3, received: 200, fills: [{ days: 199 }, { days: 30 }] },
    { n: 11, refills: 0, received: 200, fills: [{ days: 199 }] },
    { n: 12, refills: 1, received: 120 },
    { n: 13, refills: 0, received: 2, fills: [{ days: 2 }] },
    { n: 14, refills: 2, received: 30, closed: 'changed', fills: [{ days: 29 }] },
    { n: 15, refills: 0, received: 0 },
  ];

  it('O1 an own item with a refill open is open work of any age, after the items waiting for a first fill', async () => {
    const h = harness({ items: OLD, on: true });
    const items = await listOf(h);
    expect(items.map((item) => item.id)).toEqual([id(12), id(15), id(10), id(13), id(14)]);
    // Item 10 (200 days, a refill open) is listed; item 11 (200 days, none left) is not: done work keeps 90 days.
    expect(h.sent((sql) => sql === WORK_LIST_QUERY_0133).map((statement) => statement.values))
      .toEqual([[workListSince(), [id(10)]]]);
    expect(items.find((item) => item.id === id(10))!.refills).toEqual({ allowed: 3, recorded: 2, open: true, closedReason: null });
  });

  it('O2 off, the same items: an item with any fill is done work, so item 10 is left out', async () => {
    const h = harness({ items: OLD });
    expect((await listOf(h)).map((item) => item.id)).toEqual([id(12), id(15), id(13), id(14)]);
  });

  it('O3 the candidates: own items with 1-11 fills whose end date is not past, the latest fill first, 200 at most', () => {
    const flat = REFILL_CANDIDATES_QUERY.replace(/\s+/g, ' ');
    expect(flat).toContain('where w.order_route_id is null and f.fills between 1 and 11');
    expect(flat).toContain("(w.ends_on is null or w.ends_on >= (now() at time zone 'Africa/Lagos')::date)");
    expect(flat).toContain('order by f.last_filled_at desc, w.id desc limit 200');
    expect(flat).not.toMatch(/\$\d/);
  });

  it('O4 an item whose prescription ended is no candidate; one with a 12th fill neither', async () => {
    const items: Item[] = [
      { n: 20, refills: 2, received: 10, endsOn: '2000-01-01', fills: [{ days: 9 }] },
      { n: 21, refills: 11, received: 10, fills: Array.from({ length: 12 }, (_, index) => ({ days: 9 - index * 0.5 })) },
      { n: 22, refills: 2, received: 10, endsOn: '2999-12-31', fills: [{ days: 9 }] },
    ];
    const h = harness({ items, on: true });
    await listOf(h);
    expect(h.sent((sql) => sql === WORK_ITEM_REFILLS_QUERY)[0]!.values[0]).toEqual([id(22)]);
  });
});

describe('ORD-12: recording a fill', () => {
  const ONE: Item[] = [{ n: 30, refills: 2, fills: [{ days: 3 }] }];

  it('D1 the next fill (fills + 1) is recorded with its number; MedicationDispensed names it, and the audit row', async () => {
    const h = harness({ items: ONE, on: true });
    const answer = await dispense(h, 30, 'ord12-dispense-key-000000000001', { fillNumber: 2 });
    expect(answer).toMatchObject({ workItemId: id(30), status: 'dispensed', fillNumber: 2 });
    expect(h.sent((sql) => sql === INSERT_DISPENSING).map((statement) => statement.values[16])).toEqual([2]);
    expect(h.committed.outbox).toEqual([{ type: 'MedicationDispensed',
      payload: { dispensingId: answer.id, workItemId: id(30), status: 'dispensed', fillNumber: 2 } }]);
    expect(h.audited()).toEqual([{ action: 'pharmacy.dispensing.create', resourceId: answer.id,
      details: { workItemId: id(30), workItemVersion: 1, status: 'dispensed', fillNumber: 2, basis: 'own-work' } }]);
  });

  it('D2 a first fill writes today\'s MedicationDispensed and audit row (no fillNumber), with the setting on or off', async () => {
    for (const on of [false, true]) {
      const h = harness({ items: [{ n: 31, refills: 2 }], on });
      const answer = await dispense(h, 31, 'ord12-dispense-key-000000000002');
      expect(h.committed.outbox).toEqual([{ type: 'MedicationDispensed',
        payload: { dispensingId: answer.id, workItemId: id(31), status: 'dispensed' } }]);
      expect(h.audited()[0]!.details).toEqual({ workItemId: id(31), workItemVersion: 1, status: 'dispensed', basis: 'own-work' });
      expect(h.sent((sql) => sql === INSERT_DISPENSING).map((statement) => statement.values[16])).toEqual([1]);
      // Off, the answer is today's dispensing; on, it names its fill.
      expect(Object.keys(answer)).toEqual(['id', 'workItemId', 'patientId', 'facilityId', 'status', 'effectiveStatus',
        'medication', 'quantityDispensed', 'quantityUnit', 'dispensedAt', 'reversalId', 'version', ...(on ? ['fillNumber'] : [])]);
    }
  });

  it('D3 every fill writes its own MedicationDispensed: three fills, three events, the refills naming 2 and 3', async () => {
    const h = harness({ items: [{ n: 32, refills: 2 }], on: true });
    await dispense(h, 32, 'ord12-dispense-key-000000000031');
    await dispense(h, 32, 'ord12-dispense-key-000000000032', { fillNumber: 2 });
    await dispense(h, 32, 'ord12-dispense-key-000000000033', { fillNumber: 3 });
    expect(h.committed.outbox.map((event) => [event.type, (event.payload as Answer).fillNumber]))
      .toEqual([['MedicationDispensed', undefined], ['MedicationDispensed', 2], ['MedicationDispensed', 3]]);
    expect(new Set(h.committed.outbox.map((event) => (event.payload as Answer).dispensingId)).size).toBe(3);
  });

  it.each([[1, 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED', {}], [3, 'PHARMACY_FILL_NUMBER_CHANGED', { fillsRecorded: 1 }],
    [4, 'PHARMACY_FILL_NUMBER_CHANGED', { fillsRecorded: 1 }]] as const)(
    'D4 a fill number that is not the next (%p after one fill) is 409 %s, nothing written', async (fill, code, extra) => {
      const h = harness({ items: ONE, on: true });
      // Fill 1 left out with another quantity: today's request for an item already dispensed (the same request replays,
      // P3).
      expect(await refusal(dispense(h, 30, 'ord12-dispense-key-000000000004', fill === 1 ? { quantityDispensed: 28 }
        : { fillNumber: fill })))
        .toEqual({ status: 409, code, ...extra });
      expect(h.inserts()).toBe(0);
      expect(h.committed.outbox).toEqual([]);
    });

  it('D5 a refill of a route-backed item is 409 PHARMACY_NO_REFILLS_LEFT before the insert', async () => {
    const h = harness({ items: [{ n: 33, routed: true, fills: [{ days: 1 }] }], on: true });
    expect(await refusal(dispense(h, 33, 'ord12-dispense-key-000000000005', { fillNumber: 2 })))
      .toEqual({ status: 409, code: 'PHARMACY_NO_REFILLS_LEFT' });
    expect(h.inserts()).toBe(0);
  });

  it('D6 setting off: a refill asked of the service directly is 409 PHARMACY_REFILLS_NOT_AVAILABLE, nothing written', async () => {
    const h = harness({ items: ONE });
    expect(await refusal(dispense(h, 30, 'ord12-dispense-key-000000000006', { fillNumber: 2 })))
      .toEqual({ status: 409, code: 'PHARMACY_REFILLS_NOT_AVAILABLE' });
    expect(h.inserts()).toBe(0);
  });

  it.each([
    [sqlError('23514', { message: 'NO_REFILLS_LEFT' }), 'PHARMACY_NO_REFILLS_LEFT'],
    [sqlError('23514', { message: 'REFILL_PRESCRIPTION_ENDED' }), 'PHARMACY_REFILL_PRESCRIPTION_ENDED'],
    [sqlError('23514', { message: 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE' }), 'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE'],
    [sqlError('23514', { message: 'PRESCRIPTION_SOURCE_NOT_DISPENSABLE', detail: 'not_claimed' }),
      'PHARMACY_PRESCRIPTION_NOT_DISPENSABLE'],
  ])('D7 the database\'s refusal %p is a plain 409 %s, never a 500', async (error, code) => {
    const h = harness({ items: ONE, on: true, insertErrors: [error] });
    expect(await refusal(dispense(h, 30, 'ord12-dispense-key-000000000007', { fillNumber: 2 })))
      .toMatchObject({ status: 409, code });
    expect(h.committed.outbox).toEqual([]);
    expect(h.committed.fills).toHaveLength(1);
  });

  it('D8 another 23514 is passed on unchanged (a broken session, not a refusal for the pharmacist)', async () => {
    const other = sqlError('23514', { message: 'Dispensing does not match its eligible Pharmacy work item and actor context' });
    const h = harness({ items: ONE, on: true, insertErrors: [other] });
    await expect(dispense(h, 30, 'ord12-dispense-key-000000000008', { fillNumber: 2 })).rejects.toBe(other);
  });

  it('D9 no fill above the first accepts the item (ORD-4): only a first fill asks the steps reader', async () => {
    const h = harness({ items: ONE, on: true });
    await dispense(h, 30, 'ord12-dispense-key-000000000009', { fillNumber: 2 });
    expect(h.sent((sql) => sql === OWN_WORK_STEPS_QUERY)).toEqual([]);
    const first = harness({ items: [{ n: 34, refills: 1 }], on: true });
    await dispense(first, 34, 'ord12-dispense-key-000000000010');
    expect(first.sent((sql) => sql === OWN_WORK_STEPS_QUERY)).toHaveLength(1);
  });
});

describe('ORD-12: replay by the item, the fill number and the request', () => {
  const TWO: Item[] = [{ n: 40, refills: 2, fills: [{ days: 3 }, { days: 1 }] }];

  it('P1 the same refill under a new key (a second press) answers the recorded fill, 201, writing nothing', async () => {
    const h = harness({ items: TWO, on: true });
    const answer = await dispense(h, 40, 'ord12-replay-key-00000000000001', { fillNumber: 2 });
    expect(answer).toMatchObject({ id: fillId(40, 2), fillNumber: 2 });
    expect(h.inserts()).toBe(0);
    expect(h.committed.outbox).toEqual([]);
    expect(h.committed.audits).toEqual([]);
  });

  it('P2 the same fill number with another body is 409 PHARMACY_FILL_NUMBER_CHANGED (fill 2), ALREADY_DISPENSED (fill 1)',
    async () => {
      const h = harness({ items: TWO, on: true });
      expect(await refusal(dispense(h, 40, 'ord12-replay-key-00000000000002', { fillNumber: 2, quantityDispensed: 28 })))
        .toEqual({ status: 409, code: 'PHARMACY_FILL_NUMBER_CHANGED', fillsRecorded: 2 });
      expect(await refusal(dispense(h, 40, 'ord12-replay-key-00000000000003', { quantityDispensed: 28 })))
        .toEqual({ status: 409, code: 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED' });
      expect(h.inserts()).toBe(0);
    });

  it('P3 a request without fillNumber, or naming fill 1, replays fill 1 on an item with refills (today\'s clients)', async () => {
    for (const on of [false, true]) {
      const h = harness({ items: TWO, on });
      expect(await dispense(h, 40, 'ord12-replay-key-00000000000004')).toMatchObject({ id: fillId(40, 1) });
      if (on) expect(await dispense(h, 40, 'ord12-replay-key-00000000000005', { fillNumber: 1 })).toMatchObject({ id: fillId(40, 1), fillNumber: 1 });
      expect(h.inserts()).toBe(0);
    }
  });

  it('P4 the digest of a first fill is today\'s, with or without fillNumber 1; a refill\'s names its number', () => {
    expect(digestOf(40, body)).toBe(requestDigest('pharmacy.dispensing.create', { workItemId: id(40), ...body }));
    expect(digestOf(40, { ...body, fillNumber: 1 })).toBe(digestOf(40, body));
    expect(digestOf(40, { ...body, fillNumber: undefined })).toBe(digestOf(40, body));
    expect(digestOf(40, { ...body, fillNumber: 2 })).toBe(requestDigest('pharmacy.dispensing.create',
      { workItemId: id(40), ...body, fillNumber: 2 }));
    expect(digestOf(40, { ...body, fillNumber: 2 })).not.toBe(digestOf(40, { ...body, fillNumber: 3 }));
  });

  it('P5 this member\'s key used for another request is 409: IDEMPOTENCY_CONFLICT for a refill, ALREADY_DISPENSED for fill 1',
    async () => {
      const h = harness({ items: [...TWO, { n: 41, refills: 2 }], on: true });
      const key = 'ord12-seeded-key-40-2-000000';
      expect(await refusal(dispense(h, 40, key, { fillNumber: 3 })))
        .toEqual({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
      expect(await refusal(dispense(h, 41, key))).toEqual({ status: 409, code: 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED' });
      // The same key and request: the recorded fill.
      expect(await dispense(h, 40, key, { fillNumber: 2 })).toMatchObject({ id: fillId(40, 2) });
      expect(h.inserts()).toBe(0);
    });

  it('P6 two presses at once: the loser meets 0152\'s key, runs again and answers the winner\'s fill (same request)',
    async () => {
      const h = harness({ items: TWO, on: true, race: { n: 40, fill: 3, by: pharmacistAccount,
        key: 'ord12-race-winner-key-0000000001' } });
      const answer = await dispense(h, 40, 'ord12-race-loser-key-00000000001', { fillNumber: 3 });
      expect(answer).toMatchObject({ id: fillId(40, 3), fillNumber: 3 });
      expect(h.sent((sql) => sql === 'ROLLBACK')).toHaveLength(1);
      expect(h.committed.outbox).toEqual([]);
    });

  it('P7 another member records the same fill first: the loser runs again and is 409 PHARMACY_FILL_NUMBER_CHANGED', async () => {
    const h = harness({ items: TWO, on: true, race: { n: 40, fill: 3, body: { quantityDispensed: 10 } } });
    expect(await refusal(dispense(h, 40, 'ord12-race-loser-key-00000000002', { fillNumber: 3 })))
      .toEqual({ status: 409, code: 'PHARMACY_FILL_NUMBER_CHANGED', fillsRecorded: 3 });
  });

  it('P8 a second 23505 on a key (the winner hidden from this member) is a 409, never a 500', async () => {
    const fillKey = harness({ items: TWO, on: true, race: { n: 40, fill: 3, hidden: true },
      insertErrors: [sqlError('23505', { constraint: FILL_KEY_CONSTRAINT })] });
    expect(await refusal(dispense(fillKey, 40, 'ord12-race-loser-key-00000000003', { fillNumber: 3 })))
      .toEqual({ status: 409, code: 'PHARMACY_FILL_NUMBER_CHANGED', fillsRecorded: 2 });
    const firstFill = harness({ items: [{ n: 42, refills: 1 }], on: true,
      insertErrors: [sqlError('23505', { constraint: FILL_KEY_CONSTRAINT }), sqlError('23505', { constraint: FILL_KEY_CONSTRAINT })] });
    expect(await refusal(dispense(firstFill, 42, 'ord12-race-loser-key-00000000004')))
      .toEqual({ status: 409, code: 'PHARMACY_WORK_ITEM_ALREADY_DISPENSED' });
    const memberKey = harness({ items: TWO, on: true, insertErrors: [sqlError('23505', { constraint: DISPENSING_KEY_CONSTRAINT }),
      sqlError('23505', { constraint: DISPENSING_KEY_CONSTRAINT })] });
    expect(await refusal(dispense(memberKey, 40, 'ord12-race-loser-key-00000000005', { fillNumber: 3 })))
      .toEqual({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });
});

describe('ORD-12: only the latest fill can be reversed (setting on or off)', () => {
  const FILLS: Item[] = [{ n: 50, refills: 2, fills: [{ days: 3 }, { days: 1 }] }];
  const reverse = (h: ReturnType<typeof harness>, fill: number, key: string) =>
    h.service.reverse(pharmacist, fillId(50, fill), { expectedDispensingVersion: 1, reason: 'Returned unopened' }, key);

  it.each([[false], [true]])('V1 reversing an earlier fill is 409 PHARMACY_DISPENSING_NOT_LATEST_FILL (on: %p)', async (on) => {
    const h = harness({ items: FILLS, on });
    expect(await refusal(reverse(h, 1, 'ord12-reverse-key-0000000000001')))
      .toEqual({ status: 409, code: 'PHARMACY_DISPENSING_NOT_LATEST_FILL' });
    expect(h.committed.reversals).toEqual([]);
    expect(h.sent((sql) => sql === LATER_FILL_QUERY).map((statement) => statement.values)).toEqual([[id(50), 1]]);
  });

  it('V2 the latest fill is reversed as before, and the item then answers it reversed', async () => {
    const h = harness({ items: FILLS, on: true });
    await expect(reverse(h, 2, 'ord12-reverse-key-0000000000002')).resolves.toMatchObject({ dispensingId: fillId(50, 2),
      status: 'reversed' });
    expect(h.committed.outbox.map((event) => event.type)).toEqual(['MedicationDispensingReversed']);
    const read = await readOf(h, 50);
    expect(read.dispensing).toEqual({ id: fillId(50, 2), status: 'dispensed', reversed: true, fillNumber: 2 });
    expect(read.pharmacyStep).toBe('dispensing_reversed');
  });

  it('V3 a reversal already recorded on an earlier fill still replays (a reversal recorded before the refill)', async () => {
    const h = harness({ items: [{ n: 50, refills: 2, fills: [{ days: 3, reversed: true }, { days: 1 }] }], on: true });
    const stored = h.committed.reversals[0]!;
    const replay = await h.service.reverse(pharmacist, fillId(50, 1), { expectedDispensingVersion: 1,
      reason: 'Returned unopened' }, stored.idempotency_key).catch((error: unknown) => error);
    // The stored reversal's digest is another request's: 409 ALREADY_REVERSED, decided before the latest-fill rule.
    expect(replay).toMatchObject({ code: 'PHARMACY_DISPENSING_ALREADY_REVERSED' });
    expect(h.sent((sql) => sql === LATER_FILL_QUERY)).toEqual([]);
  });
});

describe('ORD-12: the dispensing body (CreateDispensingBodyPipe)', () => {
  const pipe = (on: boolean) => new CreateDispensingBodyPipe(new PharmacyRefills(on));
  const problem = async (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as DomainProblem);

  it('B1 off: today\'s body, and fillNumber refused as any field the route does not take', async () => {
    await expect(pipe(false).transform(body)).resolves.toEqual(body);
    const refused = await problem(pipe(false).transform({ ...body, fillNumber: 2 }));
    expect(refused).toMatchObject({ code: 'VALIDATION_FAILED', errors: [{ field: 'fillNumber',
      messages: ['property fillNumber should not exist'] }] });
    expect(await problem(pipe(false).transform({ ...body, fillNumber: 1 }))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('B2 on: fillNumber 1-12 taken, left out taken; null, 0, 13, 2.5 and "2" refused', async () => {
    await expect(pipe(true).transform({ ...body, fillNumber: 2 })).resolves.toMatchObject({ fillNumber: 2 });
    await expect(pipe(true).transform({ ...body, fillNumber: 12 })).resolves.toMatchObject({ fillNumber: 12 });
    await expect(pipe(true).transform(body)).resolves.toMatchObject(body);
    for (const fillNumber of [null, 0, 13, 2.5, '2']) {
      expect(await problem(pipe(true).transform({ ...body, fillNumber }))).toMatchObject({ code: 'VALIDATION_FAILED',
        errors: [{ field: 'fillNumber' }] });
    }
    expect(await problem(pipe(true).transform({ ...body, refillsLeft: 1 }))).toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('ORD-12: wiring (PRESCRIPTION_REFILLS_ENABLED)', () => {
  const original = { ...process.env };
  const base = { NODE_ENV: 'test', PHARMACY_DATABASE_URL: 'postgresql://pharmacy:test@localhost:5432/hid',
    DATABASE_SSL: 'false', CORS_ORIGINS: 'http://localhost:3000', PHARMACY_INTERNAL_SERVICE_TOKEN: 'z'.repeat(32) };
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key];
    Object.assign(process.env, original);
    resetEnvironmentForTests();
  });
  const provider = () => (Reflect.getMetadata('providers', PharmacyModule) as unknown[]).find((entry) =>
    typeof entry === 'object' && entry !== null && (entry as { provide?: unknown }).provide === PharmacyRefills) as
    { useFactory: () => PharmacyRefills };

  it('W1 is off unless set to true, separate from 0125\'s setting; PharmacyModule follows it', () => {
    Object.assign(process.env, base, { PRESCRIPTION_DISPENSING_DETAILS_ENABLED: 'true' });
    delete process.env.PRESCRIPTION_REFILLS_ENABLED;
    resetEnvironmentForTests();
    expect(getEnvironment().PRESCRIPTION_REFILLS_ENABLED).toBe(false);
    expect(provider().useFactory().enabled).toBe(false);
    process.env.PRESCRIPTION_REFILLS_ENABLED = 'true';
    process.env.PRESCRIPTION_DISPENSING_DETAILS_ENABLED = 'false';
    resetEnvironmentForTests();
    expect(getEnvironment().PRESCRIPTION_REFILLS_ENABLED).toBe(true);
    expect(provider().useFactory().enabled).toBe(true);
  });

  it('W2 refuses any value but true or false', () => {
    Object.assign(process.env, base, { PRESCRIPTION_REFILLS_ENABLED: 'yes' });
    resetEnvironmentForTests();
    expect(() => getEnvironment()).toThrow(/PRESCRIPTION_REFILLS_ENABLED/);
  });

  it('W3 is the service\'s last parameter, what Nest injects, and off in a module without it', async () => {
    const types = Reflect.getMetadata('design:paramtypes', PharmacyService) as unknown[];
    expect(types).toHaveLength(10);
    expect(types[9]).toBe(PharmacyRefills);
    const identityToken = types[1];
    const others = [{ provide: DatabaseService, useValue: {} }, { provide: identityToken, useValue: {} },
      { provide: AuditService, useValue: {} }, { provide: PharmacyOrderRouteAccess, useValue: {} },
      { provide: PharmacyOrderRouteCards, useValue: {} },
      { provide: PharmacyOwnWorkPatientCards, useValue: OWN_WORK_PATIENT_CARDS_OFF },
      { provide: PharmacyPrescriptionDetails, useValue: PRESCRIPTION_DETAILS_OFF },
      { provide: PharmacyOwnWork, useValue: new PharmacyOwnWork(false) }];
    const on = new PharmacyRefills(true);
    const withIt = await Test.createTestingModule({ providers: [PharmacyService, ...others,
      { provide: PharmacyRefills, useValue: on }] as never[] }).compile();
    expect((withIt.get(PharmacyService) as unknown as { refills: unknown }).refills).toBe(on);
    const without = await Test.createTestingModule({ providers: [PharmacyService, ...others] as never[] }).compile();
    expect((without.get(PharmacyService) as unknown as { refills: unknown }).refills).toBe(REFILLS_OFF);
  });
});
