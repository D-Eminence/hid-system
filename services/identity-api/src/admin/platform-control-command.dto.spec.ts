import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { PlatformControlCommandDto } from './dto/admin-command.dto';

// POST /admin/controls validates the key before platform.admin_set_control
// does; facility self sign-up's control must pass, or nobody can switch it.
async function keyErrors(controlKey: unknown) {
  const errors = await validate(plainToInstance(PlatformControlCommandDto,
    { controlKey, enabled: true, reason: 'Synthetic platform control change' }));
  return errors.map((error) => error.property);
}

describe('PlatformControlCommandDto', () => {
  it.each(['patient_portal_enabled', 'provider_portal_enabled', 'outreach_portal_enabled', 'maintenance_mode',
    'uploads_enabled', 'break_glass_enabled', 'provider_self_service_enabled'])('accepts %s', async (key) => {
    expect(await keyErrors(key)).toEqual([]);
  });

  it.each(['provider_self_service', 'provider_self_service_enabled_x', 'PROVIDER_SELF_SERVICE_ENABLED',
    'staff_mfa_required', '', 7])('refuses %p', async (key) => {
    expect(await keyErrors(key)).toEqual(['controlKey']);
  });
});
