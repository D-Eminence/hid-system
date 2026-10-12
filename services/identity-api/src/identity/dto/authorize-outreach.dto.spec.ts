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
  it('accepts every Outreach permission the database defines except campaign writes', async () => {
    expect(outreachPermissions).toEqual(['outreach.campaign.read', 'outreach.campaign.write',
      'outreach.registration.read', 'outreach.registration.write']);
    for (const permission of outreachPermissions) expect({ permission, accepted: await accepts(permission) })
      .toEqual({ permission, accepted: permission !== 'outreach.campaign.write' });
  });

  it.each(['outreach.campaign.write', 'outreach.campaign.admin', 'identity.patient.read', 'outreach.registration', '',
    undefined])(
    'refuses %p', async (permission) => {
      expect(await accepts(permission)).toBe(false);
    });
});
