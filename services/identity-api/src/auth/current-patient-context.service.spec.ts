import { UnauthorizedException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import { CurrentPatientContextService } from './current-patient-context.service';

describe('Current patient identity', () => {
  it('preserves distinct account and canonical patient IDs without workforce authority', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ account_id: 'account', subject: 'subject',
      patient_id: 'canonical-patient', email: 'patient@example.invalid', display_name: 'Patient' }] });
    const service = new CurrentPatientContextService({ query } as unknown as DatabaseService);
    const actor = await service.resolve('subject', 'session');
    expect(actor).toMatchObject({ kind: 'patient', accountId: 'account', patientId: 'canonical-patient',
      sessionId: 'session', roles: [], permissions: [], platformPermissions: [], facilities: [], facilityIds: [] });
    expect(actor.facility).toBeUndefined();
    expect(query).toHaveBeenCalledWith('select * from identity.current_patient_account($1)', ['subject']);
  });

  it.each([{ rows: [] }, { rows: [{}, {}] }])('denies absent or ambiguous patient associations', async ({ rows }) => {
    const service = new CurrentPatientContextService({ query: jest.fn().mockResolvedValue({ rows }) } as unknown as DatabaseService);
    await expect(service.resolve('unknown')).rejects.toBeInstanceOf(UnauthorizedException);
  });
});
