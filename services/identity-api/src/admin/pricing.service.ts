import { Injectable } from '@nestjs/common';
import type { QueryResultRow } from 'pg';
import { AuditService } from '../audit/audit.service';
import { requestDigest } from '../common/idempotency';
import { DomainProblem } from '../common/problem';
import type { PlatformAccessContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';
import { platformAuditActor } from './admin-context';
import type { PricePricingCommandDto, ProductPricingCommandDto } from './dto/pricing-command.dto';
import { requirePlatformAssurance } from '../auth/platform-assurance';

interface PublicPriceRow extends QueryResultRow {
  product_slug: string;
  context: string;
  visibility: string;
  amount_minor: string | null;
  currency: string;
  billing_period: string | null;
  unit: string | null;
}

interface ProductRow extends QueryResultRow {
  id: string;
  slug: string;
  name: string;
  status: string;
  row_version: string;
  updated_at: Date;
}

interface AdminPriceRow extends PublicPriceRow {
  product_id: string;
  active: boolean;
  row_version: string;
  updated_at: Date;
}

interface ProductCommandRow extends QueryResultRow {
  slug: string;
  name: string;
  status: string;
  row_version: string;
  replayed: boolean;
}

interface PriceCommandRow extends PublicPriceRow {
  active: boolean;
  row_version: string;
  replayed: boolean;
}

@Injectable()
export class PricingService {
  constructor(private readonly database: DatabaseService, private readonly audit: AuditService) {}

  async publicPrices() {
    const result = await this.database.query<PublicPriceRow>(
      `select * from platform.public_list_commercial_prices()`,
    );
    return { data: result.rows.map((row) => this.publicPrice(row)) };
  }

  async adminCatalog(context: PlatformAccessContext) {
    try {
      return await this.database.withTransaction(context, async (client) => {
        const products = await client.query<ProductRow>(`select * from platform.admin_list_commercial_products()`);
        const prices = await client.query<AdminPriceRow>(`select * from platform.admin_list_commercial_prices()`);
        return {
          products: products.rows.map((row) => ({
            id: row.id, slug: row.slug, name: row.name, status: row.status,
            version: Number(row.row_version), updated_at: new Date(row.updated_at).toISOString(),
          })),
          prices: prices.rows.map((row) => ({
            ...this.publicPrice(row), product_id: row.product_id, active: row.active,
            version: Number(row.row_version), updated_at: new Date(row.updated_at).toISOString(),
          })),
        };
      }, { readOnly: true });
    } catch (error) { throw this.commandError(error); }
  }

  async updateProduct(context: PlatformAccessContext, slug: string, expectedVersion: number,
    input: ProductPricingCommandDto, idempotencyKey: string) {
    this.assertKey(slug);
    const name = input.name.trim();
    const reason = input.reason.trim();
    const digest = requestDigest('platform.pricing.product.update',
      { slug, expectedVersion, name, status: input.status, reason });
    try {
      return await this.database.withTransaction(context, async (client) => {
        await requirePlatformAssurance(client, context, 'platform.pricing.product');
        const result = await client.query<ProductCommandRow>(
          `select * from platform.admin_set_commercial_product($1,$2,$3,$4,$5,$6,$7)`,
          [slug, expectedVersion, name, input.status, reason, idempotencyKey, digest],
        );
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'PRICING_UNAVAILABLE', 'Product pricing could not be updated');
        if (!row.replayed) await this.audit.recordWithClient(client, this.auditEvent(context,
          'admin.pricing.product.update', row.slug, reason,
          { name: row.name, status: row.status, version: Number(row.row_version) }));
        return { slug: row.slug, name: row.name, status: row.status,
          version: Number(row.row_version), replayed: row.replayed };
      });
    } catch (error) { throw this.commandError(error); }
  }

  async updatePrice(context: PlatformAccessContext, slug: string, priceContext: string,
    expectedVersion: number, input: PricePricingCommandDto, idempotencyKey: string) {
    this.assertKey(slug);
    if (!/^(core|addon|standalone|usage|setup|migration_project|enterprise)$/.test(priceContext)) {
      throw new DomainProblem(400, 'PRICING_CONTEXT_INVALID', 'Pricing context is invalid');
    }
    const hasAmount = input.visibility === 'fixed' || input.visibility === 'starting_from';
    if (hasAmount !== (typeof input.amountMinor === 'number' && Number.isSafeInteger(input.amountMinor)
      && input.amountMinor >= 0)) {
      throw new DomainProblem(400, 'PRICING_AMOUNT_INVALID', 'Amount must match pricing visibility');
    }
    const unit = input.unit?.trim() || null;
    const billingPeriod = input.billingPeriod ?? null;
    const reason = input.reason.trim();
    const digest = requestDigest('platform.pricing.price.update', {
      slug, priceContext, expectedVersion, visibility: input.visibility,
      amountMinor: input.amountMinor, currency: input.currency, billingPeriod,
      unit, active: input.active, reason,
    });
    try {
      return await this.database.withTransaction(context, async (client) => {
        await requirePlatformAssurance(client, context, 'platform.pricing.price');
        const result = await client.query<PriceCommandRow>(
          `select * from platform.admin_set_commercial_price($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [slug, priceContext, expectedVersion, input.visibility, input.amountMinor,
            input.currency, billingPeriod, unit, input.active, reason, idempotencyKey, digest],
        );
        const row = result.rows[0];
        if (!row) throw new DomainProblem(503, 'PRICING_UNAVAILABLE', 'Product price could not be updated');
        if (!row.replayed) await this.audit.recordWithClient(client, this.auditEvent(context,
          'admin.pricing.price.update', `${slug}:${priceContext}`, reason,
          { visibility: row.visibility, amountMinor: row.amount_minor,
            currency: row.currency, active: row.active, version: Number(row.row_version) }));
        return { ...this.publicPrice(row), active: row.active,
          version: Number(row.row_version), replayed: row.replayed };
      });
    } catch (error) { throw this.commandError(error); }
  }

  private publicPrice(row: PublicPriceRow) {
    return { product_slug: row.product_slug, context: row.context,
      visibility: row.visibility, amount_minor: row.amount_minor === null ? null : Number(row.amount_minor),
      currency: row.currency, billing_period: row.billing_period, unit: row.unit };
  }

  private assertKey(slug: string): void {
    if (!/^[a-z][a-z0-9-]{1,63}$/.test(slug)) {
      throw new DomainProblem(400, 'PRICING_PRODUCT_INVALID', 'Product slug is invalid');
    }
  }

  private auditEvent(context: PlatformAccessContext, action: string, resourceId: string,
    reason: string, details: Record<string, unknown>) {
    return { ...platformAuditActor(context), action, resourceType: 'commercial-pricing', resourceId,
      outcome: 'success' as const, purposeOfUse: context.purposeOfUse, reason, details };
  }

  private commandError(error: unknown): Error {
    if (error instanceof DomainProblem) return error;
    const message = typeof error === 'object' && error && 'message' in error ? String(error.message) : '';
    if (message.includes('ADMIN_PERMISSION_DENIED')) return new DomainProblem(403, 'PERMISSION_DENIED', 'Pricing administration is not permitted');
    if (message.includes('ADMIN_VERSION_CONFLICT')) return new DomainProblem(409, 'VERSION_CONFLICT', 'Pricing changed; reload before retrying');
    if (message.includes('ADMIN_IDEMPOTENCY_CONFLICT')) return new DomainProblem(409, 'IDEMPOTENCY_CONFLICT', 'Idempotency key was used for another command');
    if (message.includes('ADMIN_PRODUCT_NOT_FOUND') || message.includes('ADMIN_PRICE_NOT_FOUND')) {
      return new DomainProblem(404, 'PRICING_NOT_FOUND', 'Product pricing was not found');
    }
    if (message.includes('ADMIN_NO_STATE_CHANGE')) return new DomainProblem(409, 'PRICING_UNCHANGED', 'Pricing already has the requested state');
    if (message.includes('ADMIN_INVALID')) return new DomainProblem(400, 'PRICING_INVALID', 'Product pricing is invalid');
    return new DomainProblem(503, 'PRICING_UNAVAILABLE', 'Product pricing is unavailable');
  }
}
