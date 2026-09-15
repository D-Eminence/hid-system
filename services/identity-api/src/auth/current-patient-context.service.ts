import { Injectable, UnauthorizedException } from '@nestjs/common';
import type { ActorContext } from '../common/request-context';
import { DatabaseService } from '../database/database.service';

interface PatientAccount {
  account_id: string; subject: string; email: string; display_name: string; patient_id: string;
}

@Injectable()
export class CurrentPatientContextService {
  constructor(private readonly database: DatabaseService) {}

  async resolve(subject: string, sessionId?: string): Promise<ActorContext> {
    const result = await this.database.query<PatientAccount>(
      'select * from identity.current_patient_account($1)', [subject],
    );
    const row = result.rows[0];
    if (!row || result.rows.length !== 1) throw new UnauthorizedException('Patient account is unavailable');
    return {
      kind: 'patient', id: row.subject, subject: row.subject, accountId: row.account_id,
      patientId: row.patient_id, sessionId, email: row.email, displayName: row.display_name,
      authenticationMethod: 'local', roles: [], permissions: [], platformRoles: [],
      platformPermissions: [], facilityIds: [], facilities: [],
    };
  }
}
