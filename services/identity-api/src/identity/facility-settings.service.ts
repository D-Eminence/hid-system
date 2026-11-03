import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

type Timestamp = Date | string | null;

interface StateRow extends QueryResultRow {
  enabled: boolean | null;
  changed_at: Timestamp;
  changed_by_name: string | null;
  reason: string | null;
}

interface ChangeRow extends QueryResultRow {
  enabled: boolean;
  changed_at: Timestamp;
  setting_id: string;
}

function iso(value: Timestamp | undefined): string | null {
  if (value === null || value === undefined) return null;
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

/**
 * The answers to the facility settings commands (migration 0111). The database
 * raises each refusal with a bare code as the message: 42501 for authority,
 * 22023 for invalid input, P0001 for a business refusal. Anything else is not
 * an answer about the request and is 503.
 */
export function facilitySettingProblem(error: unknown): DomainProblem {
  if (error instanceof DomainProblem) return error;
  const { code, message } = (typeof error === 'object' && error !== null ? error : {}) as
    { code?: unknown; message?: unknown };
  if (code === '42501') {
    return new DomainProblem(403, 'FACILITY_SETTING_PERMISSION_DENIED',
      'Only the facility administrator can change facility settings');
  }
  if (code === '22023' && message === 'FACILITY_SETTING_REASON_INVALID') {
    return new DomainProblem(400, 'FACILITY_SETTING_REASON_INVALID', 'Enter a reason of 10 to 500 characters');
  }
  if (code === '22023' && message === 'FACILITY_SETTING_INVALID') {
    return new DomainProblem(400, 'FACILITY_SETTING_INVALID', 'The setting is invalid');
  }
  if (code === 'P0001' && message === 'FACILITY_SETTING_UNCHANGED') {
    return new DomainProblem(409, 'FACILITY_SETTING_UNCHANGED', 'The facility already has this setting');
  }
  return new DomainProblem(503, 'FACILITY_SETTINGS_UNAVAILABLE', 'Facility settings are temporarily unavailable');
}

/**
 * A facility's own settings, changed by its administrator (organization.manage
 * at the X-Facility-ID facility). Today one: One-person lab (owner decision
 * 33.3). Every facility is two-person until it is switched on; each switch is
 * recorded with who, when, which way and the typed reason, and audited by the
 * database (identity.facility.one-person-lab.on / .off).
 */
@Injectable()
export class FacilitySettingsService {
  constructor(private readonly database: DatabaseService) {}

  async read(context: DataAccessContext) {
    let row: StateRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) =>
        (await client.query<StateRow>('select * from identity.facility_one_person_lab_state()')).rows[0],
      { readOnly: true });
    } catch (error) {
      throw facilitySettingProblem(error);
    }
    if (!row) throw facilitySettingProblem(undefined);
    return {
      onePersonLab: {
        enabled: row.enabled === true,
        changedAt: iso(row.changed_at),
        changedByName: row.changed_by_name,
        reason: row.reason,
      },
    };
  }

  async setOnePersonLab(context: DataAccessContext, enabled: boolean, reason: string) {
    let row: ChangeRow | undefined;
    try {
      row = await this.database.withTransaction(context, async (client) => (await client.query<ChangeRow>(
        'select * from identity.set_facility_one_person_lab($1,$2)', [enabled, reason])).rows[0]);
    } catch (error) {
      throw facilitySettingProblem(error);
    }
    if (!row) throw facilitySettingProblem(undefined);
    return { enabled: row.enabled === true, changedAt: iso(row.changed_at), settingId: row.setting_id };
  }
}
