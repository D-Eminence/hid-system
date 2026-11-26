import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { RecordLicenceRenewalDto, WithdrawLicenceRenewalDto } from './workforce.dto';
import { lagosDate, outcomeProblem, WORKFORCE_MESSAGES, workforceDatabaseProblem } from './workforce-problems';

/**
 * ROS-1 routes 1-5 (0199): licence renewals and expiry for the facility's
 * administrator. Every call works through 0199's SECURITY DEFINER functions,
 * which admit the caller with 0086's identity.staff_management_actor (a staff
 * session with workforce.manage at a self-signed-up facility), decide and
 * audit in the request's transaction. A status is a warning only (Q243 A):
 * nothing is refused or changed because a licence has expired.
 */

export const STAFF_LICENCE_LIST_SQL = 'select * from identity.staff_licence_status_list()';
export const STAFF_LICENCE_MEMBER_SQL = 'select * from identity.staff_licence_member_read($1)';
export const STAFF_LICENCE_EXPORT_SQL = 'select * from identity.staff_licence_export_rows()';
export const STAFF_LICENCE_RECORD_SQL =
  'select * from identity.staff_licence_renewal_record($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)';
export const STAFF_LICENCE_WITHDRAW_SQL = 'select * from identity.staff_licence_renewal_withdraw($1, $2, $3, $4)';
/** The text the administrator confirms (0199, identity.staff_attestation_texts). */
export const LICENCE_RENEWAL_ATTESTATION_VERSION = 'facility-licence-renewal-v1';

export type LicenceStatus = 'valid' | 'expiring_60' | 'expiring_30' | 'expired' | 'not_recorded' | 'no_licence';

/** The licence answer, as 0199 builds it (the contract's "licence"). */
export interface LicenceAnswer {
  role: string;
  body: string | null;
  numberHint: string | null;
  status: LicenceStatus;
  validUntil: string | null;
  daysLeft: number | null;
  renewal: Record<string, unknown> | null;
}

interface ListRow extends QueryResultRow {
  membership_id: string;
  member_name: string;
  member_roles: string[] | null;
  is_self: boolean;
  role_code: string | null;
  status: LicenceStatus | null;
  licence: LicenceAnswer | null;
}

interface ExportRow extends QueryResultRow {
  member_name: string;
  member_roles: string[] | null;
  licence_body: string | null;
  number_hint: string | null;
  status: LicenceStatus;
  valid_until: string | Date | null;
  checked_how: string | null;
  checked_on: string | Date | null;
  checked_by_name: string | null;
  self_recorded: boolean | null;
  as_of: string | Date;
}

/** Most urgent first: expired, then 30, 60, not recorded, no licence, valid; no licensed role last. */
const URGENCY: Readonly<Record<LicenceStatus, number>> = {
  expired: 0, expiring_30: 1, expiring_60: 2, not_recorded: 3, no_licence: 4, valid: 5,
};

/** The export's words for each status and method (the screens use the same). */
export const LICENCE_STATUS_WORDS: Readonly<Record<LicenceStatus, string>> = {
  valid: 'Valid',
  expiring_60: 'Expires within 60 days',
  expiring_30: 'Expires within 30 days',
  expired: 'Expired',
  not_recorded: 'No renewal recorded',
  no_licence: 'No licence on record',
};
export const CHECKED_HOW_WORDS: Readonly<Record<string, string>> = {
  regulator_register: 'Checked on the regulator\'s register',
  certificate_seen: 'Original licence certificate seen',
  in_person: 'Checked in person',
};
export const LICENCE_EXPORT_HEADER = ['Staff name', 'Roles', 'Licence body', 'Number ending', 'Status', 'Valid until',
  'Checked how', 'Checked on', 'Checked by', 'Recorded by the member themselves'] as const;

function dateOnly(value: string | Date | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
  }
  return value.slice(0, 10);
}

/**
 * One CSV cell: a cell that a spreadsheet would read as a formula (it starts
 * with =, +, -, @, a tab or a carriage return) is prefixed with a single
 * quote; a cell with a comma, a quote or a line break is quoted.
 */
export function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

/** The export: a byte-order mark, the header, one row per licence, CRLF line ends. */
export function licenceExportCsv(rows: readonly ExportRow[]): string {
  const lines = [LICENCE_EXPORT_HEADER.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push([
      row.member_name,
      (row.member_roles ?? []).join('; '),
      row.licence_body ?? '',
      row.number_hint ?? '',
      LICENCE_STATUS_WORDS[row.status] ?? row.status,
      dateOnly(row.valid_until),
      row.checked_how ? CHECKED_HOW_WORDS[row.checked_how] ?? row.checked_how : '',
      dateOnly(row.checked_on),
      row.checked_by_name ?? '',
      row.self_recorded === null || row.self_recorded === undefined ? '' : row.self_recorded ? 'Yes' : 'No',
    ].map((cell) => csvCell(String(cell))).join(','));
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}

@Injectable()
export class StaffLicencesService {
  constructor(private readonly database: DatabaseService) {}

  /** Route 1: every active member, each licensed role with its status, and the counts. */
  async list(context: DataAccessContext) {
    let rows: ListRow[];
    try {
      rows = await this.database.withTransaction(context, async (client) =>
        (await client.query<ListRow>(STAFF_LICENCE_LIST_SQL)).rows);
    } catch (error) {
      throw workforceDatabaseProblem(error, 'hr');
    }
    const counts = { valid: 0, expiring60: 0, expiring30: 0, expired: 0, notRecorded: 0, noLicence: 0 };
    const countKey: Readonly<Record<LicenceStatus, keyof typeof counts>> = {
      valid: 'valid', expiring_60: 'expiring60', expiring_30: 'expiring30', expired: 'expired',
      not_recorded: 'notRecorded', no_licence: 'noLicence',
    };
    const members = new Map<string, { membershipId: string; name: string; roles: string[]; isSelf: boolean;
      licences: LicenceAnswer[] }>();
    for (const row of rows) {
      const member = members.get(row.membership_id) ?? { membershipId: row.membership_id, name: row.member_name,
        roles: row.member_roles ?? [], isSelf: row.is_self === true, licences: [] };
      members.set(row.membership_id, member);
      if (row.role_code && row.licence) {
        member.licences.push(row.licence);
        counts[countKey[row.licence.status]] += 1;
      }
    }
    const urgency = (licences: LicenceAnswer[]) => licences.length === 0 ? 6
      : Math.min(...licences.map((licence) => URGENCY[licence.status] ?? 6));
    return {
      facilityId: context.facilityId,
      asOf: lagosDate(),
      counts,
      members: [...members.values()].sort((left, right) => urgency(left.licences) - urgency(right.licences)
        || left.name.localeCompare(right.name, 'en') || left.membershipId.localeCompare(right.membershipId)),
    };
  }

  /** Route 2: one member's licences, each with every renewal (withdrawn ones marked). */
  async member(context: DataAccessContext, membershipId: string) {
    let row: { outcome: string; member: Record<string, unknown> | null } | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) =>
        (await client.query<{ outcome: string; member: Record<string, unknown> | null }>(STAFF_LICENCE_MEMBER_SQL,
          [membershipId])).rows[0]);
    } catch (error) {
      throw workforceDatabaseProblem(error, 'hr');
    }
    if (row?.outcome !== 'found' || !row.member) throw outcomeProblem(row?.outcome ?? 'unknown', 'hr', 'staff');
    return row.member;
  }

  /** Route 3: the export's CSV and its Lagos-dated file name. */
  async export(context: DataAccessContext): Promise<{ filename: string; body: string }> {
    let rows: ExportRow[];
    try {
      rows = await this.database.withTransaction(context, async (client) =>
        (await client.query<ExportRow>(STAFF_LICENCE_EXPORT_SQL)).rows);
    } catch (error) {
      throw workforceDatabaseProblem(error, 'hr');
    }
    const asOf = rows[0] ? dateOnly(rows[0].as_of) : lagosDate();
    return { filename: `licence-check-${asOf}.csv`, body: licenceExportCsv(rows) };
  }

  /** Route 4: record a renewal. 201 the first time; the same Idempotency-Key and request answer 200, replayed. */
  async record(context: DataAccessContext, input: RecordLicenceRenewalDto, idempotencyKey: string) {
    const licenceYear = input.licenceYear ?? null;
    const validUntil = input.validUntil ?? null;
    if ((input.period === 'licence_year' && (licenceYear === null || validUntil !== null))
      || (input.period === 'expiry_date' && (validUntil === null || licenceYear !== null))) {
      throw new DomainProblem(400, 'VALIDATION_FAILED', WORKFORCE_MESSAGES.validation,
        [{ field: input.period === 'licence_year' ? 'licenceYear' : 'validUntil',
          messages: ['Give the licence year or the expiry date, as the period says'] }]);
    }
    const digest = requestDigest('identity.staff-licence.renewal-record', {
      membershipId: input.membershipId, role: input.role, period: input.period, licenceYear, validUntil,
      checkedHow: input.checkedHow, checkedOn: input.checkedOn, attested: true,
    });
    let row: { outcome: string; replayed: boolean; renewal: unknown; licence: unknown } | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<{ outcome: string;
        replayed: boolean; renewal: unknown; licence: unknown }>(STAFF_LICENCE_RECORD_SQL, [input.membershipId,
        input.role, input.period, licenceYear, validUntil, input.checkedHow, input.checkedOn,
        LICENCE_RENEWAL_ATTESTATION_VERSION, idempotencyKey, digest])).rows[0]);
    } catch (error) {
      throw workforceDatabaseProblem(error, 'hr');
    }
    if (row?.outcome !== 'recorded') throw outcomeProblem(row?.outcome, 'hr', 'staff');
    return { status: row.replayed ? 200 : 201,
      body: { renewal: row.renewal, licence: row.licence, replayed: row.replayed === true } };
  }

  /** Route 5: withdraw a renewal entered by mistake (a reason code, never free text). */
  async withdraw(context: DataAccessContext, renewalId: string, input: WithdrawLicenceRenewalDto,
    idempotencyKey: string) {
    const digest = requestDigest('identity.staff-licence.renewal-withdraw', { renewalId, reasonCode: input.reasonCode });
    let row: { outcome: string; replayed: boolean; licence: unknown } | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<{ outcome: string;
        replayed: boolean; licence: unknown }>(STAFF_LICENCE_WITHDRAW_SQL, [renewalId, input.reasonCode,
        idempotencyKey, digest])).rows[0]);
    } catch (error) {
      throw workforceDatabaseProblem(error, 'hr');
    }
    if (row?.outcome !== 'withdrawn') throw outcomeProblem(row?.outcome, 'hr', 'renewal');
    return { licence: row.licence ?? null, replayed: row.replayed === true };
  }
}
