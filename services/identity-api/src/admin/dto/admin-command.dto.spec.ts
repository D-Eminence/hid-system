import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PlatformControlCommandDto } from './admin-command.dto';

const migrations = join(__dirname, '../../../../ehr-api/database/migrations');

/** The control keys of the newest control_settings key check in the migration chain. */
function databaseControlKeys(): string[] {
  const definitions = readdirSync(migrations).filter((file) => file.endsWith('.sql')).sort()
    .flatMap((file) => [...readFileSync(join(migrations, file), 'utf8')
      .matchAll(/check \(control_key in \(([^)]*)\)\)/g)].map((match) => match[1] as string));
  const latest = definitions.at(-1) ?? '';
  return [...latest.matchAll(/'([a-z_]+)'/g)].map((match) => match[1] as string).sort();
}

async function accepts(controlKey: unknown): Promise<boolean> {
  const command = plainToInstance(PlatformControlCommandDto, { controlKey, enabled: false,
    reason: 'Synthetic platform control test reason' });
  return (await validate(command, { forbidUnknownValues: true })).length === 0;
}

describe('PlatformControlCommandDto', () => {
  it('accepts exactly the control keys the database accepts, clinician self sign-up and record chat included',
    async () => {
      const keys = databaseControlKeys();
      // The record chat migration keeps clinician self sign-up's key (0098)
      // and adds its own: both stay manageable through POST /admin/controls.
      expect(keys).toEqual(['break_glass_enabled', 'clinician_signup_enabled', 'maintenance_mode',
        'outreach_portal_enabled', 'patient_portal_enabled', 'provider_portal_enabled', 'record_chat_enabled',
        'uploads_enabled']);
      for (const key of keys) expect({ key, accepted: await accepts(key) }).toEqual({ key, accepted: true });
    });

  it.each(['record_chat', 'RECORD_CHAT_ENABLED', 'record_chat_enabled ', 'staff_record_chat_enabled',
    'clinician_signup', 'CLINICIAN_SIGNUP_ENABLED', 'clinician_signup_enabled ', '', undefined])(
    'refuses %p', async (controlKey) => {
      expect(await accepts(controlKey)).toBe(false);
    });
});
