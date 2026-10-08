import type { PoolClient } from 'pg';
import { validate } from 'class-validator';
import type { AuditService } from '../audit/audit.service';
import { DomainProblem } from '../common/problem';
import type { PlatformAccessContext } from '../common/request-context';
import type { DatabaseService } from '../database/database.service';
import { PricePricingCommandDto } from './dto/pricing-command.dto';
import { PricingService } from './pricing.service';

const context: PlatformAccessContext = {
  scope: 'platform',
  correlationId: 'pricing-test-correlation-001',
  facilityId: null,
  membershipId: null,
  purposeOfUse: 'healthcare-operations',
  actor: {
    id: 'staff:pricing-admin', subject: 'staff:pricing-admin',
    accountId: '20000000-0000-4000-8000-000000000001',
    roles: [], permissions: [], platformRoles: ['platform_super_admin'],
    platformPermissions: ['platform.pricing.read', 'platform.pricing.manage'],
    facilityIds: ['10000000-0000-4000-8000-000000000002'], facilities: [],
    authenticationMethod: 'local',
  },
};

const fixedPrice = {
  product_slug: 'ehr', context: 'core', visibility: 'fixed', amount_minor: '1250000',
  currency: 'NGN', billing_period: 'month', unit: null, active: true,
  row_version: '2', replayed: false,
};

function harness(row: Readonly<Record<string, unknown>>) {
  const client = { query: jest.fn().mockResolvedValue({ rows: [row], rowCount: 1 }) };
  const database = {
    query: jest.fn().mockResolvedValue({ rows: [row], rowCount: 1 }),
    withTransaction: jest.fn(async (_context, operation) => operation(client as unknown as PoolClient)),
  };
  const audit = { recordWithClient: jest.fn().mockResolvedValue(undefined) };
  const service = new PricingService(database as unknown as DatabaseService, audit as unknown as AuditService);
  return { service, database, client, audit };
}

describe('PricingService', () => {
  it('returns only the database published price shape and preserves a null quote amount', async () => {
    const { service, database } = harness({ ...fixedPrice, visibility: 'contact_sales', amount_minor: null });
    await expect(service.publicPrices()).resolves.toEqual({ data: [{
      product_slug: 'ehr', context: 'core', visibility: 'contact_sales', amount_minor: null,
      currency: 'NGN', billing_period: 'month', unit: null,
    }] });
    expect(database.query).toHaveBeenCalledWith('select * from platform.public_list_commercial_prices()');
  });

  it('commits a reasoned semantic audit with a versioned price change', async () => {
    const { service, client, audit } = harness(fixedPrice);
    await expect(service.updatePrice(context, 'ehr', 'core', 1, {
      visibility: 'fixed', amountMinor: 1250000, currency: 'NGN',
      billingPeriod: 'month', unit: null, active: true, reason: 'Approved commercial rate',
    }, 'pricing-command-0001')).resolves.toEqual({
      product_slug: 'ehr', context: 'core', visibility: 'fixed', amount_minor: 1250000,
      currency: 'NGN', billing_period: 'month', unit: null, active: true,
      version: 2, replayed: false,
    });
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('admin_set_commercial_price'),
      expect.arrayContaining(['ehr', 'core', 1, 1250000, 'pricing-command-0001']));
    expect(audit.recordWithClient).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: 'admin.pricing.price.update', reason: 'Approved commercial rate', outcome: 'success',
    }));
  });

  it('does not create a second semantic audit event for an idempotent replay', async () => {
    const { service, audit } = harness({ ...fixedPrice, replayed: true });
    await service.updatePrice(context, 'ehr', 'core', 1, {
      visibility: 'fixed', amountMinor: 1250000, currency: 'NGN',
      billingPeriod: 'month', unit: null, active: true, reason: 'Approved commercial rate',
    }, 'pricing-command-0001');
    expect(audit.recordWithClient).not.toHaveBeenCalled();
  });

  it('rejects an amount for quote pricing before any database access', async () => {
    const { service, database } = harness(fixedPrice);
    const failure = await service.updatePrice(context, 'ehr', 'core', 1, {
      visibility: 'contact_sales', amountMinor: 1250000, currency: 'NGN',
      billingPeriod: null, unit: null, active: true, reason: 'Approved commercial rate',
    }, 'pricing-command-0001').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect((failure as DomainProblem).code).toBe('PRICING_AMOUNT_INVALID');
    expect(database.withTransaction).not.toHaveBeenCalled();
  });

  it('maps stale versions to a safe conflict response', async () => {
    const { service, client } = harness(fixedPrice);
    client.query.mockRejectedValue(new Error('ADMIN_VERSION_CONFLICT internal detail'));
    const failure = await service.updateProduct(context, 'ehr', 1,
      { name: 'HID EHR', status: 'coming_soon', reason: 'Temporarily unavailable' },
      'pricing-product-command-0001').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect((failure as DomainProblem).getStatus()).toBe(409);
    expect((failure as DomainProblem).code).toBe('VERSION_CONFLICT');
  });

  it('requires a numeric minor-unit amount and rejects unknown request fields', async () => {
    const input = Object.assign(new PricePricingCommandDto(), {
      visibility: 'fixed', amountMinor: '1250000', currency: 'NGN',
      billingPeriod: 'month', unit: null, active: true,
      reason: 'Approved commercial rate', unexpected: 'not allowed',
    });
    expect((await validate(input)).some((error) => error.property === 'amountMinor')).toBe(true);
  });
});
