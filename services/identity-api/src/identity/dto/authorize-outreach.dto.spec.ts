import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { AuthorizeOutreachDto } from './authorize-outreach.dto';

const migrations = join(__dirname, '../../../../ehr-api/database/migrations');
// Every Outreach permission the database defines and grants to a role.
const outreachPermissions = [...new Set(readdirSync(migrations).filter((file) => file.endsWith('.sql'))
  .flatMap((file) => [...readFileSync(join(migrations, file), 'utf8').matchAll(/'(outreach\.[a-z_]+\.[a-z_]+)'/g)]
    .map((match) => match[1] as string)))].sort();

async function accepts(permission: unknown): Promise<boolean> {
  return (await validate(plainToInstance(AuthorizeOutreachDto, { permission }), { forbidUnknownValues: true })).length === 0;
}

describe('AuthorizeOutreachDto', () => {
  it('accepts every Outreach permission the database defines, campaign writes included since 0122', async () => {
    expect(outreachPermissions).toEqual(['outreach.campaign.read', 'outreach.campaign.write',
      'outreach.registration.read', 'outreach.registration.write']);
    for (const permission of outreachPermissions) expect({ permission, accepted: await accepts(permission) })
      .toEqual({ permission, accepted: true });
  });

  it('accepts campaign writes only alongside 0122, which makes them admin-only', () => {
    const governance = readdirSync(migrations).filter((file) => file.endsWith('.sql'))
      .map((file) => readFileSync(join(migrations, file), 'utf8'))
      .find((source) => source.includes('create function outreach.campaign_staff(requested_campaign_id uuid)'));
    expect(governance).toBeDefined();
    expect(governance).toContain("message='Outreach campaign admin is required'");
    expect(governance).toContain('create policy outreach_campaign_members_admin_create on outreach.campaign_members');
  });

  it.each(['outreach.campaign.admin', 'identity.patient.read', 'outreach.registration', '',
    undefined])(
    'refuses %p', async (permission) => {
      expect(await accepts(permission)).toBe(false);
    });
});
