import { createHash, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import { platformAuditActor } from '../admin/admin-context';
import type { HidRequest, PlatformAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import type { CreateDemoRequestDto, ListDemoRequestsDto, UpdateDemoRequestStatusDto } from './demo-request.dto';
import { requirePlatformAssurance } from '../auth/platform-assurance';

interface DemoRequestRow extends QueryResultRow {
  id: string;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  contactRole: string | null;
  organizationName: string | null;
  organizationType: string | null;
  productCode: string;
  message: string | null;
  sourcePage: string | null;
  sourceSection: string | null;
  ctaLabel: string | null;
  status: string;
  version: string;
  createdAt: Date;
  updatedAt: Date;
}

const DEMO_PROJECTION = `id::text, contact_name as "contactName", contact_email as "contactEmail",
  contact_phone as "contactPhone", contact_role as "contactRole", organization_name as "organizationName",
  organization_type as "organizationType", product_code as "productCode", message,
  source_page as "sourcePage", source_section as "sourceSection", cta_label as "ctaLabel",
  status, row_version::text as version, created_at as "createdAt", updated_at as "updatedAt"`;

@Injectable()
export class DemoRequestsService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async submit(input: CreateDemoRequestDto, idempotencyKey: string, request: HidRequest) {
    const requestId = randomUUID();
    const keyHash = createHash('sha256').update(`hid-demo-request\n${idempotencyKey}`).digest('hex');
    const inserted = await this.database.withSystemTransaction(request.correlationId, async (client) => {
      const result = await client.query(
        `insert into identity.demo_requests (id, idempotency_key_sha256, contact_name,
           contact_email, contact_phone, contact_role, organization_name, organization_type,
           product_code, message, source_page, source_section, cta_label)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         on conflict (idempotency_key_sha256) do nothing`,
        [requestId, keyHash, input.contactName, input.contactEmail.toLowerCase(),
          input.contactPhone ?? null, input.contactRole ?? null, input.organizationName ?? null,
          input.organizationType ?? null, input.productCode, input.message ?? null,
          input.sourcePage ?? null, input.sourceSection ?? null, input.ctaLabel ?? null],
      );
      if (result.rowCount === 1) {
        await this.audit.recordWithClient(client, {
          correlationId: request.correlationId,
          actorType: 'system',
          action: 'commercial.demo-request.submitted',
          resourceType: 'demo-request',
          resourceId: requestId,
          outcome: 'success',
          sourceIp: request.ip,
          userAgent: request.header('user-agent'),
          details: { productCode: input.productCode },
        });
      }
      return result.rowCount === 1;
    });
    return { accepted: true, replayed: !inserted };
  }

  async list(context: PlatformAccessContext, filters: ListDemoRequestsDto) {
    const limit = filters.limit ?? 50;
    return this.database.withTransaction(context, async (client) => {
      const result = await client.query<DemoRequestRow>(
        `select ${DEMO_PROJECTION} from identity.demo_requests
         where ($1::text is null or status = $1)
           and ($2::text is null or product_code = $2)
         order by created_at desc, id desc limit $3`,
        [filters.status ?? null, filters.productCode ?? null, limit],
      );
      await this.audit.recordWithClient(client, this.adminAudit(context, 'commercial.demo-requests.list',
        'demo-request-collection', undefined, { returnedCount: result.rows.length }));
      return { items: result.rows.map(this.present) };
    });
  }

  async transition(context: PlatformAccessContext, requestId: string, expectedVersion: number,
    input: UpdateDemoRequestStatusDto) {
    return this.database.withTransaction(context, async (client) => {
      await requirePlatformAssurance(client, context, 'platform.demo-request.status');
      const current = await client.query<DemoRequestRow>(
        `select ${DEMO_PROJECTION} from identity.demo_requests where id = $1 for update`, [requestId]);
      const row = current.rows[0];
      if (!row) throw new DomainProblem(404, 'DEMO_REQUEST_NOT_FOUND', 'Demo request was not found');
      if (Number(row.version) !== expectedVersion) {
        throw new DomainProblem(409, 'DEMO_REQUEST_VERSION_CONFLICT', 'Demo request changed; refresh and try again');
      }
      if (row.status === input.status) return { ...this.present(row), replayed: true };
      const updated = await client.query<DemoRequestRow>(
        `update identity.demo_requests set status = $2, row_version = row_version + 1,
           updated_at = clock_timestamp() where id = $1 returning ${DEMO_PROJECTION}`,
        [requestId, input.status],
      );
      const next = updated.rows[0];
      if (!next) throw new DomainProblem(503, 'DEMO_REQUEST_UNAVAILABLE', 'Demo request could not be updated');
      await client.query(
        `insert into identity.demo_request_events
           (request_id, from_status, to_status, reason, actor_account_id, correlation_id)
         values ($1,$2,$3,$4,$5,$6)`,
        [requestId, row.status, input.status, input.reason, context.actor.accountId, context.correlationId],
      );
      await this.audit.recordWithClient(client, this.adminAudit(context, 'commercial.demo-request.status',
        'demo-request', requestId, { from: row.status, to: input.status, version: Number(next.version) }));
      return { ...this.present(next), replayed: false };
    });
  }

  private present(row: DemoRequestRow) {
    return { ...row, version: Number(row.version),
      createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
  }

  private adminAudit(context: PlatformAccessContext, action: string, resourceType: string,
    resourceId?: string, details?: Record<string, unknown>) {
    return {
      ...platformAuditActor(context),
      action, resourceType, resourceId, outcome: 'success' as const,
      purposeOfUse: context.purposeOfUse,
      details,
    };
  }
}
