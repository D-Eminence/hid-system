import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { DataAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { IdentityService } from '../identity/identity.service';
import type { CreateRegistrationCaseDto } from './dto/create-registration-case.dto';
import type { LinkExistingPatientDto } from './dto/link-existing-patient.dto';
import type { CreateCampaignDto } from './dto/create-campaign.dto';
import type { UpdateCampaignStatusDto } from './dto/update-campaign-status.dto';
import type { AddCampaignMemberDto } from './dto/add-campaign-member.dto';
import type { OutreachCampaign, CampaignMember, CampaignRole, CampaignStaff } from './campaign.types';
import { registrationCase, type OutreachRegistrationCase, type RegistrationRow } from './outreach.types';

interface IdempotencyRow { request_sha256: string; registration_case_id: string }

/** 403 for anyone but a campaign's own admins (0122, ADR-045 option B). */
function campaignAdminRequired(what: string): DomainProblem {
  return new DomainProblem(403, 'OUTREACH_CAMPAIGN_ADMIN_REQUIRED', `Only this Outreach campaign's admins can ${what}`);
}

/** The database's own admin refusals (0122's trigger and member policy) as the same 403; anything else unchanged. */
function adminRefusal(error: unknown, what: string): unknown {
  const code = typeof error === 'object' && error && 'code' in error ? (error as { code?: string }).code : undefined;
  const message = error instanceof Error ? error.message : '';
  if (code === '42501' && (message === 'Outreach campaign admin is required'
    || message.includes('"outreach_campaign_members_admin_create"'))) return campaignAdminRequired(what);
  return error;
}

@Injectable()
export class OutreachService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly identity: IdentityService,
  ) {}

  async create(input: CreateRegistrationCaseDto, idempotencyKey: string,
    context: DataAccessContext): Promise<OutreachRegistrationCase> {
    const normalized = { ...input, fullName: input.fullName.trim(),
      phone: input.phone?.trim() || null, operationalNotes: input.operationalNotes?.trim() || null };
    const digest = requestDigest('outreach.registration-case.create', normalized);
    try {
      return await this.database.withTransaction(context, async (client) => {
        const replay = await this.replay(client, context, 'registration_case_create', idempotencyKey, digest);
        if (replay) return replay;
        if (normalized.campaignId) await this.assertCampaignAcceptsRegistration(client, normalized.campaignId, context);
        const inserted = await client.query<RegistrationRow>(`insert into outreach.registration_cases (
          facility_id,created_by_account_id,created_by_membership_id,local_command_id,
          temporary_patient_id,full_name,sex,age_years,phone,operational_notes,campaign_id
        ) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
        [context.facilityId, context.actor.accountId, context.membershipId, normalized.localCommandId,
          normalized.temporaryPatientId, normalized.fullName, normalized.sex, normalized.ageYears,
          normalized.phone, normalized.operationalNotes, normalized.campaignId ?? null]);
        const row = inserted.rows[0];
        if (!row) throw new Error('Outreach registration insert returned no row');
        await client.query(`insert into outreach.registration_case_events (
          registration_case_id,event_type,facility_id,temporary_patient_id,actor_account_id,actor_membership_id
        ) values ($1,'registration_case_received',$2,$3,$4,$5)`,
        [row.id, context.facilityId, row.temporary_patient_id, context.actor.accountId, context.membershipId]);
        await client.query(`insert into outreach.command_idempotency (
          requester_account_id,requester_membership_id,facility_id,operation,idempotency_key,
          request_sha256,registration_case_id
        ) values ($1,$2,$3,'registration_case_create',$4,$5,$6)`,
        [context.actor.accountId, context.membershipId, context.facilityId, idempotencyKey, digest, row.id]);
        await this.outbox(client, 'OutreachRegistrationCaseCreated', row.id, 1, context, null,
          { registrationCaseId: row.id, temporaryPatientId: row.temporary_patient_id,
            campaignId: row.campaign_id, status: 'identity_resolution_pending' });
        await this.audit.recordWithClient(client, context, 'outreach.registration-case.received', row.id);
        return registrationCase(row);
      }, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      // Outside the transaction: a duplicate of a concurrent identical request
      // is retried and replayed; only a conflict that remains is a 409.
      this.translateConflict(error, 'OUTREACH_REGISTRATION_CONFLICT',
        'This local Outreach registration was already received');
      throw error;
    }
  }

  async list(context: DataAccessContext): Promise<readonly OutreachRegistrationCase[]> {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<RegistrationRow>(`select * from outreach.registration_cases
        where facility_id=$1 and outreach.registration_campaign_member(campaign_id, facility_id)
        order by created_at desc,id desc limit 100`, [context.facilityId]);
      await this.audit.recordWithClient(client, context, 'outreach.registration-case.list', context.facilityId);
      return result.rows.map(registrationCase);
    });
  }

  async get(id: string, context: DataAccessContext): Promise<OutreachRegistrationCase> {
    return this.database.withTransaction(context, async (client) => {
      const value = await this.find(client, id);
      await this.audit.recordWithClient(client, context, 'outreach.registration-case.read', id,
        value.resolvedPatientId ?? undefined);
      return value;
    });
  }

  async linkExisting(id: string, input: LinkExistingPatientDto, idempotencyKey: string,
    context: DataAccessContext): Promise<OutreachRegistrationCase> {
    await this.identity.authorizeExistingPatient(input.canonicalPatientId, context);
    const normalized = { ...input, reason: input.reason.trim() };
    const digest = requestDigest('outreach.registration-case.link-existing', { id, ...normalized });
    try {
      return await this.database.withTransaction(context, async (client) => {
        const replay = await this.replay(client, context, 'registration_case_link_existing',
          idempotencyKey, digest);
        if (replay) return replay;
        const currentResult = await client.query<RegistrationRow>(
          'select * from outreach.registration_cases where id=$1 for update', [id]);
        const current = currentResult.rows[0];
        if (!current) throw new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND',
          'The Outreach registration case was not found');
        if (current.status !== 'identity_resolution_pending') throw new DomainProblem(409,
          'OUTREACH_REGISTRATION_ALREADY_RESOLVED', 'The Outreach registration case is already resolved');
        if (Number(current.row_version) !== normalized.expectedVersion) throw new DomainProblem(412,
          'VERSION_CONFLICT', 'The Outreach registration case changed; reload before reconciling');
        await client.query(`insert into outreach.patient_mappings (
          registration_case_id,facility_id,temporary_patient_id,canonical_patient_id,
          resolution_kind,resolved_by_account_id,resolved_by_membership_id,reason
        ) values ($1,$2,$3,$4,'linked_existing',$5,$6,$7)`,
        [id, context.facilityId, current.temporary_patient_id, normalized.canonicalPatientId,
          context.actor.accountId, context.membershipId, normalized.reason]);
        const updated = await client.query<RegistrationRow>(`update outreach.registration_cases set
          status='identity_resolved',resolved_patient_id=$2,resolution_kind='linked_existing',
          resolved_by_account_id=$3,resolved_by_membership_id=$4,resolution_reason=$5,
          resolved_at=clock_timestamp(),row_version=row_version+1
          where id=$1 and row_version=$6 returning *`,
        [id, normalized.canonicalPatientId, context.actor.accountId, context.membershipId,
          normalized.reason, normalized.expectedVersion]);
        const row = updated.rows[0];
        if (!row) throw new DomainProblem(412, 'VERSION_CONFLICT',
          'The Outreach registration case changed; reload before reconciling');
        await client.query(`insert into outreach.registration_case_events (
          registration_case_id,event_type,facility_id,temporary_patient_id,canonical_patient_id,
          actor_account_id,actor_membership_id,reason
        ) values ($1,'existing_patient_linked',$2,$3,$4,$5,$6,$7)`,
        [id, context.facilityId, row.temporary_patient_id, normalized.canonicalPatientId,
          context.actor.accountId, context.membershipId, normalized.reason]);
        await client.query(`insert into outreach.command_idempotency (
          requester_account_id,requester_membership_id,facility_id,operation,idempotency_key,
          request_sha256,registration_case_id
        ) values ($1,$2,$3,'registration_case_link_existing',$4,$5,$6)`,
        [context.actor.accountId, context.membershipId, context.facilityId, idempotencyKey, digest, id]);
        await this.outbox(client, 'OutreachPatientResolved', id, Number(row.row_version), context,
          normalized.canonicalPatientId, { registrationCaseId: id,
            temporaryPatientId: row.temporary_patient_id, campaignId: row.campaign_id,
            canonicalPatientId: normalized.canonicalPatientId,
            resolutionKind: 'linked_existing' });
        await this.audit.recordWithClient(client, context, 'outreach.patient.linked-existing', id,
          normalized.canonicalPatientId);
        return registrationCase(row);
      }, { isolationLevel: 'SERIALIZABLE' });
    } catch (error) {
      this.translateConflict(error, 'OUTREACH_RESOLUTION_CONFLICT',
        'The Outreach registration has a conflicting patient resolution');
      throw error;
    }
  }


  async listCampaigns(context: DataAccessContext): Promise<readonly OutreachCampaign[]> {
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query(`select id, facility_id as "facilityId", name, services, status, starts_at as "startsAt",
        ends_at as "endsAt", row_version as "rowVersion", created_at as "createdAt", updated_at as "updatedAt"
        from outreach.campaigns where facility_id=$1 order by starts_at desc,id`, [context.facilityId]);
      return result.rows.map((row) => ({ ...row, rowVersion: Number(row.rowVersion),
        startsAt: new Date(row.startsAt).toISOString(), endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
        createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() }));
    }, { readOnly: true });
  }

  async createCampaign(input: CreateCampaignDto, context: DataAccessContext): Promise<OutreachCampaign> {
    const services = [...new Set(input.services)];
    if (input.endsAt && new Date(input.endsAt).getTime() <= new Date(input.startsAt).getTime()) {
      throw new DomainProblem(400, 'OUTREACH_CAMPAIGN_DATES_INVALID', 'An Outreach campaign must end after it starts');
    }
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query(`insert into outreach.campaigns
        (facility_id,created_by_account_id,created_by_membership_id,name,services,starts_at,ends_at)
        values ($1,$2,$3,$4,$5,$6,$7) returning id,facility_id as "facilityId",name,services,status,
        starts_at as "startsAt",ends_at as "endsAt",row_version as "rowVersion",created_at as "createdAt",updated_at as "updatedAt"`,
        [context.facilityId, context.actor.accountId, context.membershipId, input.name.trim(), services,
          input.startsAt, input.endsAt ?? null]);
      const row = result.rows[0];
      if (!row) throw new DomainProblem(503, 'OUTREACH_CAMPAIGN_UNAVAILABLE', 'Campaign could not be created');
      await client.query(`insert into outreach.campaign_members
        (campaign_id,facility_id,membership_id,role,added_by_account_id,added_by_membership_id)
        values ($1,$2,$3,'admin',$4,$3)`,
      [row.id, context.facilityId, context.membershipId, context.actor.accountId]);
      await client.query(`insert into outreach.campaign_events
        (campaign_id,facility_id,event_type,actor_account_id,actor_membership_id,details,correlation_id)
        values ($1,$2,'campaign_created',$3,$4,$5::jsonb,$6)`,
        [row.id, context.facilityId, context.actor.accountId, context.membershipId,
          JSON.stringify({ name: row.name, services }), context.correlationId]);
      await client.query(`insert into outreach.campaign_events
        (campaign_id,facility_id,event_type,actor_account_id,actor_membership_id,details,correlation_id)
        values ($1,$2,'campaign_member_added',$3,$4,$5::jsonb,$6)`,
        [row.id, context.facilityId, context.actor.accountId, context.membershipId,
          JSON.stringify({ membershipId: context.membershipId, role: 'admin' }), context.correlationId]);
      await this.audit.recordWithClient(client, context, 'outreach.campaign.created', row.id);
      return { ...row, rowVersion: Number(row.rowVersion), startsAt: new Date(row.startsAt).toISOString(),
        endsAt: row.endsAt ? new Date(row.endsAt).toISOString() : null,
        createdAt: new Date(row.createdAt).toISOString(), updatedAt: new Date(row.updatedAt).toISOString() };
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  async updateCampaignStatus(id: string, input: UpdateCampaignStatusDto, expectedVersion: number, context: DataAccessContext): Promise<OutreachCampaign> {
    return this.database.withTransaction(context, async (client) => {
      const current = (await client.query(`select * from outreach.campaigns where id=$1 and facility_id=$2 for update`, [id, context.facilityId])).rows[0];
      if (!current) throw new DomainProblem(404, 'OUTREACH_CAMPAIGN_NOT_FOUND', 'The Outreach campaign was not found');
      // 0122 (ADR-045 option B): only this campaign's own admins open or close it.
      if (await this.campaignRole(client, id, context) !== 'admin') throw campaignAdminRequired('open or close it');
      if (Number(current.row_version) !== expectedVersion) throw new DomainProblem(412, 'VERSION_CONFLICT', 'The Outreach campaign changed; reload before retrying');
      if (current.status === input.status) throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_STATE_CONFLICT', 'The Outreach campaign is already in that state');
      if (current.status === 'closed') throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_CLOSED', 'A closed Outreach campaign cannot be reopened');
      if (input.status === 'active' && new Date(current.starts_at).getTime() > Date.now()) throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_NOT_STARTED', 'The Outreach campaign cannot become active before its start time');
      const updated = (await client.query(`update outreach.campaigns set status=$3,row_version=row_version+1 where id=$1 and facility_id=$2 returning *`, [id, context.facilityId, input.status])
        .catch((error: unknown) => { throw adminRefusal(error, 'open or close it'); })).rows[0];
      await client.query(`insert into outreach.campaign_events
        (campaign_id,facility_id,event_type,actor_account_id,actor_membership_id,details,correlation_id)
        values ($1,$2,'campaign_status_changed',$3,$4,$5::jsonb,$6)`,
        [id, context.facilityId, context.actor.accountId, context.membershipId,
          JSON.stringify({ from: current.status, to: input.status, reason: input.reason.trim() }), context.correlationId]);
      await this.audit.recordWithClient(client, context, 'outreach.campaign.status-changed', id);
      return { id: updated.id, facilityId: updated.facility_id, name: updated.name, services: updated.services,
        status: updated.status, startsAt: new Date(updated.starts_at).toISOString(), endsAt: updated.ends_at ? new Date(updated.ends_at).toISOString() : null,
        rowVersion: Number(updated.row_version), createdAt: new Date(updated.created_at).toISOString(), updatedAt: new Date(updated.updated_at).toISOString() };
    });
  }

  async listCampaignMembers(id: string, context: DataAccessContext): Promise<readonly CampaignMember[]> {
    return this.database.withTransaction(context, async (client) => {
      const exists = await client.query(`select 1 from outreach.campaigns where id=$1 and facility_id=$2`, [id, context.facilityId]);
      if (!exists.rowCount) throw new DomainProblem(404, 'OUTREACH_CAMPAIGN_NOT_FOUND', 'The Outreach campaign was not found');
      const result = await client.query(`select id,campaign_id as "campaignId",membership_id as "membershipId",role,created_at as "createdAt"
        from outreach.campaign_members where campaign_id=$1 and facility_id=$2 order by created_at,id`, [id, context.facilityId]);
      return result.rows.map((row) => ({ ...row, createdAt: new Date(row.createdAt).toISOString() }));
    }, { readOnly: true });
  }

  async addCampaignMember(id: string, input: AddCampaignMemberDto, context: DataAccessContext): Promise<CampaignMember> {
    return this.database.withTransaction(context, async (client) => {
      const campaign = await client.query(`select 1 from outreach.campaigns where id=$1 and facility_id=$2`, [id, context.facilityId]);
      if (!campaign.rowCount) throw new DomainProblem(404, 'OUTREACH_CAMPAIGN_NOT_FOUND', 'The Outreach campaign was not found');
      // 0122 (ADR-045 option B): only this campaign's own admins add members, and only active staff at the facility.
      if (await this.campaignRole(client, id, context) !== 'admin') throw campaignAdminRequired('add members');
      const person = (await client.query<{ campaign_role: string | null }>(`select campaign_role
        from outreach.campaign_staff($1) where membership_id=$2`, [id, input.membershipId])).rows[0];
      if (!person) throw new DomainProblem(422, 'OUTREACH_STAFF_NOT_AVAILABLE', 'That person is not an active staff member at this facility');
      if (person.campaign_role) throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_MEMBER_EXISTS', 'The staff member is already in this Outreach campaign');
      try {
        const result = await client.query(`insert into outreach.campaign_members
          (campaign_id,facility_id,membership_id,role,added_by_account_id,added_by_membership_id)
          values ($1,$2,$3,$4,$5,$6) returning id,campaign_id as "campaignId",membership_id as "membershipId",role,created_at as "createdAt"`,
          [id, context.facilityId, input.membershipId, input.role, context.actor.accountId, context.membershipId]);
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'OUTREACH_CAMPAIGN_UNAVAILABLE', 'Campaign membership could not be added');
        await client.query(`insert into outreach.campaign_events
          (campaign_id,facility_id,event_type,actor_account_id,actor_membership_id,details,correlation_id)
          values ($1,$2,'campaign_member_added',$3,$4,$5::jsonb,$6)`,
          [id, context.facilityId, context.actor.accountId, context.membershipId, JSON.stringify({ membershipId: input.membershipId, role: input.role }), context.correlationId]);
        await this.audit.recordWithClient(client, context, 'outreach.campaign.member-added', id);
        return { ...row, createdAt: new Date(row.createdAt).toISOString() };
      } catch (error) {
        if (typeof error === 'object' && error && 'code' in error && (error as { code?: string }).code === '23505') {
          throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_MEMBER_EXISTS', 'The staff member is already in this Outreach campaign');
        }
        throw adminRefusal(error, 'add members');
      }
    }, { isolationLevel: 'SERIALIZABLE' });
  }

  /**
   * Who is in a campaign, by name, and to its admins who could be added (0122's outreach.campaign_staff), with the
   * caller's own role in it. A non-member gets no one.
   */
  async listCampaignStaff(id: string, context: DataAccessContext): Promise<CampaignStaff> {
    return this.database.withTransaction(context, async (client) => {
      const exists = await client.query(`select 1 from outreach.campaigns where id=$1 and facility_id=$2`, [id, context.facilityId]);
      if (!exists.rowCount) throw new DomainProblem(404, 'OUTREACH_CAMPAIGN_NOT_FOUND', 'The Outreach campaign was not found');
      const result = await client.query<{ membership_id: string; display_name: string; campaign_role: CampaignRole | null }>(
        `select membership_id, display_name, campaign_role from outreach.campaign_staff($1)`, [id]);
      const people = result.rows.map((row) => ({ membershipId: row.membership_id, name: row.display_name,
        campaignRole: row.campaign_role }));
      return { yourRole: people.find((person) => person.membershipId === context.membershipId)?.campaignRole ?? null, people };
    }, { readOnly: true });
  }

  /** The caller's own role in a campaign of its facility, or null. */
  private async campaignRole(client: PoolClient, campaignId: string, context: DataAccessContext): Promise<string | null> {
    const result = await client.query<{ role: string }>(`select role from outreach.campaign_members
      where campaign_id=$1 and facility_id=$2 and membership_id=$3`, [campaignId, context.facilityId, context.membershipId]);
    return result.rows[0]?.role ?? null;
  }

  private async replay(client: PoolClient, context: DataAccessContext, operation: string,
    key: string, digest: string): Promise<OutreachRegistrationCase | null> {
    const result = await client.query<IdempotencyRow>(`select request_sha256,registration_case_id
      from outreach.command_idempotency where requester_account_id=$1 and facility_id=$2
      and operation=$3 and idempotency_key=$4`,
    [context.actor.accountId, context.facilityId, operation, key]);
    const replay = result.rows[0];
    if (!replay) return null;
    if (replay.request_sha256 !== digest) throw new DomainProblem(409, 'IDEMPOTENCY_CONFLICT',
      'The Idempotency-Key belongs to a different Outreach request');
    return this.find(client, replay.registration_case_id);
  }

  /**
   * Requires the actor's membership in an active registration campaign, and
   * share-locks the campaign until the registration commits: a status change
   * locks it FOR UPDATE, so it waits for the registration, or the registration
   * for it. The membership row is read, not locked. The runtime role cannot
   * lock campaign_members (no UPDATE, 42501), and no API command changes or
   * deletes a membership; a membership deleted after this check is caught by
   * the registration trigger, which locks the campaign and the membership as
   * its owner (Phase 4 Stage 9). The campaign lock needs the campaign UPDATE
   * policy, so it relies on every role with outreach.registration.write also
   * holding outreach.campaign.write (runtime-command-privileges.integration.sql
   * checks this); without it the lock returns no row and the request is refused.
   */
  private async assertCampaignAcceptsRegistration(client: PoolClient, campaignId: string,
    context: DataAccessContext): Promise<void> {
    const result = await client.query<{ status: string; services: string[];
      starts_at: Date | string; ends_at: Date | string | null }>(`select campaign.status,campaign.services,
        campaign.starts_at,campaign.ends_at from outreach.campaigns campaign
        join outreach.campaign_members member on member.campaign_id=campaign.id
          and member.facility_id=campaign.facility_id and member.membership_id=$3
        where campaign.id=$1 and campaign.facility_id=$2 for share of campaign`,
    [campaignId, context.facilityId, context.membershipId]);
    const campaign = result.rows[0];
    if (!campaign) throw new DomainProblem(403, 'OUTREACH_CAMPAIGN_ACCESS_DENIED',
      'Exact membership in this Outreach campaign is required');
    const now = Date.now();
    if (campaign.status !== 'active' || !campaign.services.includes('registration')
      || new Date(campaign.starts_at).getTime() > now
      || (campaign.ends_at && new Date(campaign.ends_at).getTime() <= now)) {
      throw new DomainProblem(409, 'OUTREACH_CAMPAIGN_NOT_ACCEPTING_REGISTRATIONS',
        'This Outreach campaign is not accepting registrations');
    }
  }

  private async find(client: PoolClient, id: string): Promise<OutreachRegistrationCase> {
    const result = await client.query<RegistrationRow>(
      'select * from outreach.registration_cases where id=$1', [id]);
    const row = result.rows[0];
    if (!row) throw new DomainProblem(404, 'OUTREACH_REGISTRATION_NOT_FOUND',
      'The Outreach registration case was not found');
    return registrationCase(row);
  }

  private outbox(client: PoolClient, eventType: string, id: string, version: number,
    context: DataAccessContext, patientId: string | null, payload: Record<string, unknown>) {
    return client.query(`insert into outreach.outbox_events (
      event_type,aggregate_id,aggregate_version,facility_id,patient_id,correlation_id,payload
    ) values ($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [eventType, id, version, context.facilityId, patientId, context.correlationId, JSON.stringify(payload)]);
  }

  private translateConflict(error: unknown, problemCode: string, detail: string): void {
    const code = typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code : undefined;
    if (code === '23505') throw new DomainProblem(409, problemCode, detail);
  }
}
