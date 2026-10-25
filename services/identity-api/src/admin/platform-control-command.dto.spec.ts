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
    'uploads_enabled', 'break_glass_enabled', 'provider_self_service_enabled',
    // Facility staff invitations (P4b): the owner switches them on here.
    'staff_invitations_enabled',
    // Orders between facilities (P4c): sending and accepting, and work on accepted orders.
    'cross_facility_orders_enabled', 'cross_facility_route_access_enabled'])('accepts %s', async (key) => {
    expect(await keyErrors(key)).toEqual([]);
  });

  it.each(['provider_self_service', 'provider_self_service_enabled_x', 'PROVIDER_SELF_SERVICE_ENABLED',
    'staff_mfa_required', 'staff_invitations', 'staff_invitations_enabled_x', 'cross_facility_orders',
    'cross_facility_route_access', 'cross_facility_orders_enabled_x', 'CROSS_FACILITY_ORDERS_ENABLED', '', 7])('refuses %p', async (key) => {
    expect(await keyErrors(key)).toEqual(['controlKey']);
  });
});
