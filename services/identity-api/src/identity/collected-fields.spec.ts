import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import * as environment from '../config/environment';
import type { DataAccessContext } from '../common/request-context';
import { CollectedFieldProtector, registrationCaseContactLabel } from './collected-field-protector';
import { deskCollectedFields, facilityProfileInput, signupCollectedFields,
  TEST_FIELD_KEY_B64 } from '../../test/collected-fields.fixtures';
import { FacilityProfileDto, facilityProfileForDatabase } from './dto/facility-profile.dto';
import { StartProviderEnrollmentDto } from './dto/provider-enrollment.dto';
import { ResolveNinDto } from './dto/resolve-nin.dto';
import { FacilityProfileService, facilityProfileProblem, facilityProfileVersion } from './facility-profile.service';
import { ninResolutionRequestDigest, NinRegistrationService } from './nin-registration.service';

/**
 * 0114: the sign-up, setup wizard and registration desk fields Health ID now
 * collects. Owner: "all fields required" (the three document uploads and the
 * logo wait for the document scanner).
 */

const signupBase = {
  productCode: 'ehr', organizationType: 'hospital', cacRegistrationNumber: 'RC1234567',
  administratorName: 'Synthetic Admin', administratorEmail: 'admin@clinic.invalid',
  turnstileAction: 'provider-enrollment', turnstileToken: 'opaque-proof',
};
const ninBase = {
  nin: '12345678901', firstName: 'Amina', lastName: 'Okafor', dateOfBirth: '1990-01-02',
  purpose: 'healthcare-operations',
};

async function errorsOf<T extends object>(dto: new () => T, value: Record<string, unknown>) {
  const instance = plainToInstance(dto, value);
  const errors = await validate(instance, { whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true });
  const flatten = (list: typeof errors, prefix = ''): string[] => list.flatMap((error) => [
    ...(error.constraints ? [`${prefix}${error.property}`] : []),
    ...flatten(error.children ?? [], `${prefix}${error.property}.`),
  ]);
  return { fields: flatten(errors), instance };
}

describe('facility sign-up fields (0114)', () => {
  it('accepts a complete sign-up and normalizes the phones, email and MDCN number', async () => {
    const { fields, instance } = await errorsOf(StartProviderEnrollmentDto, {
      ...signupBase, ...signupCollectedFields(), administratorPhone: '0809 876 5432',
      facilityProfile: { ...facilityProfileInput(), phone: '0801-234-5678', email: ' Front.Desk@Clinic.INVALID ',
        medicalDirectorMdcn: ' mdcn/12345 ' },
    });
    expect(fields).toEqual([]);
    expect(instance.administratorPhone).toBe('+2348098765432');
    expect(instance.facilityProfile!.phone).toBe('+2348012345678');
    expect(instance.facilityProfile!.email).toBe('front.desk@clinic.invalid');
    expect(instance.facilityProfile!.medicalDirectorMdcn).toBe('MDCN/12345');
  });

  it('still accepts the live website\'s sign-up with none of the new fields (release step, contract 43.0)', async () => {
    expect((await errorsOf(StartProviderEnrollmentDto, signupBase)).fields).toEqual([]);
    expect((await errorsOf(StartProviderEnrollmentDto, { ...signupBase, administratorRole: null,
      administratorPhone: null, facilityProfile: null })).fields).toEqual([]);
  });

  it('refuses a sign-up with only some of the new fields (all or none)', async () => {
    for (const field of ['administratorRole', 'administratorPhone', 'facilityProfile']) {
      const value: Record<string, unknown> = { ...signupBase, ...signupCollectedFields() };
      delete value[field];
      expect((await errorsOf(StartProviderEnrollmentDto, value)).fields).toContain(field);
    }
    for (const field of Object.keys(facilityProfileInput()).filter((key) =>
      !['registryId', 'nhiaAccreditationNumber'].includes(key))) {
      const profile: Record<string, unknown> = facilityProfileInput();
      delete profile[field];
      const { fields } = await errorsOf(StartProviderEnrollmentDto, { ...signupBase, ...signupCollectedFields(),
        facilityProfile: profile });
      expect(fields).toContain(`facilityProfile.${field}`);
    }
  });

  it('refuses the uploads and the logo, which are not collected yet, and other unknown fields', async () => {
    for (const extra of ['logo', 'operatingLicence', 'cacCertificate', 'proofOfAddress']) {
      const { fields } = await errorsOf(FacilityProfileDto, { ...facilityProfileInput(), [extra]: 'file' });
      expect(fields).toContain(extra);
    }
  });

  it.each([
    ['an unknown state', { stateCode: 'XX' }, 'stateCode'],
    ['no department', { departments: [] }, 'departments'],
    ['a repeated department', { departments: ['icu', 'icu'] }, 'departments'],
    ['an unknown department', { departments: ['morgue'] }, 'departments'],
    ['a short phone', { phone: '+23480' }, 'phone'],
    ['a pin outside Nigeria', { gpsLatitude: 51.5 }, 'gpsLatitude'],
    ['a bed count in words', { bedCount: 'many' }, 'bedCount'],
    ['a fractional staff count', { expectedStaff: 2.5 }, 'expectedStaff'],
    ['a registry ID said but missing', { hasRegistryId: true, registryId: null }, 'registryId'],
    ['a registry ID given though said absent', { hasRegistryId: false, registryId: 'FR-1' }, 'registryId'],
    ['an NHIA number said but missing', { hasNhiaAccreditation: true, nhiaAccreditationNumber: null },
      'nhiaAccreditationNumber'],
    ['an invalid MDCN number', { medicalDirectorMdcn: 'x' }, 'medicalDirectorMdcn'],
    ['an unknown ownership', { ownership: 'family' }, 'ownership'],
    ['an emergency answer that is not yes or no', { emergency24h: 'yes' }, 'emergency24h'],
  ])('refuses %s', async (_label, change, field) => {
    expect((await errorsOf(FacilityProfileDto, { ...facilityProfileInput(), ...change })).fields).toContain(field);
  });

  it('refuses an unknown applicant role', async () => {
    expect((await errorsOf(StartProviderEnrollmentDto, { ...signupBase, ...signupCollectedFields(),
      administratorRole: 'janitor' })).fields).toContain('administratorRole');
  });

  it('writes the profile with 0114\'s column names, and the numbers only when said', () => {
    const json = facilityProfileForDatabase({ ...facilityProfileInput(), hasRegistryId: true, registryId: 'FR-1',
      hasNhiaAccreditation: false, nhiaAccreditationNumber: 'ignored' } as unknown as FacilityProfileDto);
    expect(Object.keys(json).sort()).toEqual(['address_line', 'bed_count', 'care_level', 'city', 'departments',
      'email', 'emergency_24h', 'expected_staff', 'gps_latitude', 'gps_longitude', 'has_nhia_accreditation',
      'has_registry_id', 'lga', 'medical_director_mdcn', 'medical_director_name', 'migrating_records',
      'needs_interoperability', 'nhia_accreditation_number', 'operating_hours', 'ownership', 'phone_e164',
      'registry_id', 'services_offered', 'smoh_licence_number', 'state_code', 'trading_name']);
    expect(json.registry_id).toBe('FR-1');
    expect(json.nhia_accreditation_number).toBeNull();
  });
});

describe('the facility administrator\'s profile read and save (0114)', () => {
  const context = { actor: { subject: 'synthetic:admin', accountId: 'account' }, facilityId: 'facility',
    membershipId: 'membership', correlationId: 'correlation', purposeOfUse: 'healthcare-operations',
  } as unknown as DataAccessContext;

  function service(rows: unknown[], error?: unknown) {
    const query = jest.fn(async () => {
      if (error) throw error;
      return { rows };
    });
    const database = { withTransaction: jest.fn(async (_context: unknown, work: (client: unknown) => unknown) =>
      work({ query })) };
    return { profiles: new FacilityProfileService(database as never), query, database };
  }

  it('reads the facility with no profile yet as version 0', async () => {
    const { profiles } = service([{ facility_id: 'facility', facility_name: 'Ada Hospital Ltd',
      review_state: 'pending', profile_data: null }]);
    await expect(profiles.read(context)).resolves.toEqual({
      facility: { id: 'facility', name: 'Ada Hospital Ltd', reviewState: 'pending' }, version: 0, profile: null });
  });

  it('reads a profile with the API\'s field names and no applicant phone', async () => {
    const stored = { ...facilityProfileForDatabase(facilityProfileInput() as unknown as FacilityProfileDto),
      gps_latitude: '6.524400', source: 'self_service_signup', submitter_role: 'owner',
      submitter_phone_on_record: true, row_version: 3, updated_at: '2026-11-11T10:00:00Z' };
    const { profiles } = service([{ facility_id: 'facility', facility_name: 'Ada Hospital Ltd',
      review_state: 'reviewed', profile_data: stored }]);
    const answer = await profiles.read(context);
    expect(answer.version).toBe(3);
    expect(answer.profile).toMatchObject({ ...facilityProfileInput(), source: 'self_service_signup',
      submitterRole: 'owner', submitterPhoneOnRecord: true, version: 3 });
    expect(JSON.stringify(answer)).not.toMatch(/ciphertext|submitter_phone_ref/);
  });

  it('saves with If-Match and Idempotency-Key, and answers the changed fields by name only', async () => {
    const { profiles, query } = service([{ facility_id: 'facility', row_version: '4',
      changed_fields: ['phone_e164', 'trading_name'], replayed: false }]);
    const answer = await profiles.save(context, 3, facilityProfileInput() as unknown as FacilityProfileDto,
      'profile-save-key-000001');
    expect(answer).toEqual({ facilityId: 'facility', version: 4, changedFields: ['phone', 'tradingName'],
      replayed: false });
    const [sql, values] = query.mock.calls[0] as unknown as [string, unknown[]];
    expect(sql).toContain('identity.set_facility_profile($1::bigint, $2::jsonb, $3, $4::char(64))');
    expect(values[0]).toBe(3);
    expect(JSON.parse(values[1] as string)).toEqual(
      facilityProfileForDatabase(facilityProfileInput() as unknown as FacilityProfileDto));
    expect(values[2]).toBe('profile-save-key-000001');
    expect(values[3]).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    [{ code: '42501', message: 'STAFF_MANAGEMENT_NOT_AVAILABLE' }, 403, 'STAFF_MANAGEMENT_NOT_AVAILABLE'],
    [{ code: '42501', message: 'STAFF_MANAGEMENT_PERMISSION_DENIED' }, 403, 'PERMISSION_DENIED'],
    [{ code: 'P0001', message: 'FACILITY_PROFILE_SEALED' }, 409, 'FACILITY_PROFILE_SEALED'],
    [{ code: '22023', message: 'FACILITY_PROFILE_INVALID' }, 400, 'FACILITY_PROFILE_INVALID'],
    [{ code: '40001', message: 'FACILITY_PROFILE_VERSION_CONFLICT' }, 412, 'VERSION_CONFLICT'],
    [{ code: '23505', message: 'FACILITY_PROFILE_IDEMPOTENCY_CONFLICT' }, 409, 'IDEMPOTENCY_KEY_REUSED'],
    [{ code: '23505', message: 'duplicate key' }, 412, 'VERSION_CONFLICT'],
    [{ code: 'XX000', message: 'boom' }, 503, 'FACILITY_PROFILE_UNAVAILABLE'],
  ])('answers the database refusal %j as %i %s', async (error, status, code) => {
    const { profiles } = service([], Object.assign(new Error(error.message), error));
    await expect(profiles.save(context, 1, facilityProfileInput() as unknown as FacilityProfileDto,
      'profile-save-key-000001')).rejects.toMatchObject({ status, code });
    expect(facilityProfileProblem(Object.assign(new Error(error.message), error))).toMatchObject({ status, code });
  });

  it('reads If-Match as the loaded version, 0 for a first save', () => {
    expect(facilityProfileVersion('"0"')).toBe(0);
    expect(facilityProfileVersion('W/"7"')).toBe(7);
    for (const bad of [undefined, '', 'abc', '-1', '1.5']) {
      expect(() => facilityProfileVersion(bad)).toThrow(expect.objectContaining({ code: 'IF_MATCH_REQUIRED' }));
    }
  });
});

describe('the registration desk fields (0114)', () => {
  it('still accepts the live website\'s body with none of the desk fields (release step, contract 43.0)', async () => {
    expect((await errorsOf(ResolveNinDto, ninBase)).fields).toEqual([]);
    expect((await errorsOf(ResolveNinDto, { ...ninBase, existingHealthId: 'HID-ABC234' })).fields)
      .toContain('existingHealthId');
  });

  it('requires the phone, the address and the Health ID question together; the Health ID only when said', async () => {
    expect((await errorsOf(ResolveNinDto, { ...ninBase, ...deskCollectedFields() })).fields).toEqual([]);
    for (const field of ['phone', 'addressLine', 'city', 'stateCode', 'lga', 'hasExistingHealthId']) {
      const value: Record<string, unknown> = { ...ninBase, ...deskCollectedFields() };
      delete value[field];
      expect((await errorsOf(ResolveNinDto, value)).fields).toContain(field);
    }
    expect((await errorsOf(ResolveNinDto, { ...ninBase, ...deskCollectedFields(), hasExistingHealthId: true }))
      .fields).toContain('existingHealthId');
    expect((await errorsOf(ResolveNinDto, { ...ninBase, ...deskCollectedFields(), existingHealthId: 'HID-ABC234' }))
      .fields).toContain('existingHealthId');
    const stated = await errorsOf(ResolveNinDto, { ...ninBase, ...deskCollectedFields(), hasExistingHealthId: true,
      existingHealthId: ' hid-abc234 ' });
    expect(stated.fields).toEqual([]);
    expect(stated.instance.existingHealthId).toBe('HID-ABC234');
    expect((await errorsOf(ResolveNinDto, { ...ninBase, ...deskCollectedFields(), allergies: 'penicillin' }))
      .fields).toContain('allergies');
  });

  it('keeps the old body\'s digest, so a retry across the release replays', () => {
    const old = ninBase as unknown as ResolveNinDto;
    expect(ninResolutionRequestDigest({ ...old, phone: undefined } as ResolveNinDto, 'a'.repeat(64)))
      .toBe(ninResolutionRequestDigest(old, 'a'.repeat(64)));
    expect(ninResolutionRequestDigest({ ...old, ...deskCollectedFields() } as unknown as ResolveNinDto, 'a'.repeat(64)))
      .not.toBe(ninResolutionRequestDigest(old, 'a'.repeat(64)));
  });

  it('makes a retry with another phone, address or stated Health ID a different request', () => {
    const request = { ...ninBase, ...deskCollectedFields() } as unknown as ResolveNinDto;
    const digest = ninResolutionRequestDigest(request, 'a'.repeat(64));
    for (const change of [{ phone: '+2348000000000' }, { addressLine: '5 Other Street' }, { lga: 'Ikeja' },
      { hasExistingHealthId: true, existingHealthId: 'HID-ABC234' }]) {
      expect(ninResolutionRequestDigest({ ...request, ...change } as ResolveNinDto, 'a'.repeat(64))).not.toBe(digest);
    }
  });

  describe('resolve', () => {
    const caseIdPattern = /^[0-9a-f-]{36}$/;
    const context = { actor: { subject: 'synthetic:registrar', accountId: 'account', facility: { organizationId: 'org' } },
      facilityId: 'facility', membershipId: 'membership', correlationId: 'correlation',
      purposeOfUse: 'healthcare-operations' } as unknown as DataAccessContext;
    const statedPatient = 'f0000000-0000-4000-8000-000000000001';
    const ninPatient = 'f0000000-0000-4000-8000-000000000002';

    beforeEach(() => {
      jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NODE_ENV: 'test',
        NIN_ENCRYPTION_KEY_B64: TEST_FIELD_KEY_B64, NIN_KEY_VERSION: 'test-v1' } as environment.Environment);
    });
    afterEach(() => jest.restoreAllMocks());

    function setup(options: { ninMatch?: boolean; statedFound?: boolean; statedIsDemographicMatch?: boolean } = {}) {
      const statements: Array<{ sql: string; values: unknown[] }> = [];
      const client = {
        query: jest.fn(async (sql: string, values: unknown[] = []) => {
          statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
          if (sql.includes('registration.idempotency_key = $3')) return { rows: [] };
          if (sql.includes('identifier.lookup_hmac = $1')) {
            return { rows: options.ninMatch ? [{ patient_id: ninPatient, hid_code: 'HID-NINPAT' }] : [] };
          }
          if (sql.includes('upper(hid_code) = $1')) return { rows: options.statedFound ? [{ id: statedPatient }] : [] };
          if (sql.includes('from identity.patients') && sql.includes('lower(first_name)')) {
            // The stated patient is a candidate only when name and date of birth match the NIN.
            return { rows: options.statedIsDemographicMatch ? [{ id: statedPatient, first_name: 'Amina',
              last_name: 'Okafor', full_name: 'Amina Okafor', dob: '1990-01-02' }] : [] };
          }
          if (sql.includes('insert into identity.registration_cases')) return { rows: [{ id: values[0] }] };
          if (sql.includes('where registration.id = $1 and registration.facility_id')) {
            return { rows: [{ id: 'case', status: options.ninMatch ? 'resolved_existing_identity' : 'review_required',
              row_version: '1', resolved_patient_id: options.ninMatch ? ninPatient : null,
              resolved_hid_code: options.ninMatch ? 'HID-NINPAT' : null, candidate_count: '1',
              contact_recorded: true }] };
          }
          return { rows: [], rowCount: 1 };
        }),
      };
      const database = { withTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) => work(client)) };
      const audit = { recordWithClient: jest.fn(async () => undefined), record: jest.fn(async () => undefined) };
      const protector = { lookup: jest.fn(() => 'h'.repeat(64)),
        protect: jest.fn(() => ({ ciphertext: Buffer.alloc(40, 1), lookupHmac: 'h'.repeat(64), last4: '8901',
          keyVersion: 'test-v1' })) };
      const provider = { name: 'synthetic', verify: jest.fn(async () => ({ verified: true, provider: 'synthetic',
        reference: 'ref-1', verifiedAt: new Date().toISOString(),
        demographics: { firstName: 'Amina', lastName: 'Okafor', dateOfBirth: '1990-01-02' } })) };
      const registrations = new NinRegistrationService(database as never, audit as never, protector as never,
        {} as never, provider as never);
      return { registrations, statements, audit };
    }

    const desk = (change: Record<string, unknown> = {}) => ({ ...ninBase, ...deskCollectedFields(), ...change,
    }) as unknown as ResolveNinDto;

    it('stores the phone and address encrypted for this case, and no value in events or the audit', async () => {
      const { registrations, statements, audit } = setup();
      const answer = await registrations.resolve(desk(), 'resolve-key-000000001', context);
      expect(answer.contactRecorded).toBe(true);
      const insert = statements.find(({ sql }) => sql.startsWith('insert into identity.registration_cases'))!;
      const caseId = insert.values[0] as string;
      expect(caseId).toMatch(caseIdPattern);
      expect(insert.values).toHaveLength(20);
      const contactRow = statements.find(({ sql }) => sql.startsWith('insert into identity.registration_case_contacts'))!;
      expect(contactRow.values[0]).toBe(caseId);
      expect(contactRow.values.slice(6)).toEqual(['account', 'membership']);
      const [phone, address, keyVersion, statedHid] = contactRow.values.slice(2, 6) as [Buffer, Buffer, string, null];
      expect(keyVersion).toBe('test-v1');
      expect(statedHid).toBeNull();
      const protector = new CollectedFieldProtector();
      expect(protector.decrypt(registrationCaseContactLabel(caseId, 'phone'), 'test-v1', phone)).toBe('+2348011112222');
      expect(JSON.parse(protector.decrypt(registrationCaseContactLabel(caseId, 'address'), 'test-v1', address)))
        .toEqual({ addressLine: '4 Example Close, Surulere', city: 'Lagos', stateCode: 'LA', lga: 'Surulere' });
      const written = JSON.stringify([statements.filter(({ sql }) => !sql.startsWith('insert into identity.registration_case_contacts'))
        .map(({ values }) => values.map((value) => Buffer.isBuffer(value) ? 'bytes' : value)),
      audit.recordWithClient.mock.calls]);
      for (const value of ['8011112222', 'Example Close', 'Surulere']) expect(written).not.toContain(value);
    });

    it.each([
      ['belongs to a patient whose name and date of birth do not match the NIN', true],
      ['belongs to no patient', false],
    ])('never adds a review candidate for a stated Health ID that %s, and records the same outcome', async (_label,
      statedFound) => {
      const { registrations, statements, audit } = setup({ statedFound });
      await registrations.resolve(desk({ hasExistingHealthId: true, existingHealthId: 'HID-ABC234' }),
        'resolve-key-000000002', context);
      const insert = statements.find(({ sql }) => sql.startsWith('insert into identity.registration_cases'))!;
      expect(insert.values[4]).toBe('pending_new_identity_approval');
      const contactRow = statements.find(({ sql }) => sql.startsWith('insert into identity.registration_case_contacts'))!;
      expect(contactRow.values[5]).toBe('HID-ABC234');
      expect(statements.some(({ sql }) => sql.startsWith('insert into identity.registration_case_candidates'))).toBe(false);
      const event = statements.find(({ sql }) => sql.startsWith('insert into identity.registration_case_events'))!;
      // The same answer whether or not the Health ID exists: nothing tells staff.
      expect(JSON.parse(event.values[6] as string)).toMatchObject({ statedHealthId: 'no_match', contactRecorded: true });
      expect(JSON.stringify(audit.recordWithClient.mock.calls)).toContain('"statedHealthId":"no_match"');
      expect(JSON.stringify(statements)).not.toContain(statedPatient.slice(0, 8) + '","score');
    });

    it('marks a candidate already matched by name and date of birth with stated_hid, and adds no other', async () => {
      const { registrations, statements } = setup({ statedFound: true, statedIsDemographicMatch: true });
      await registrations.resolve(desk({ hasExistingHealthId: true, existingHealthId: 'HID-ABC234' }),
        'resolve-key-000000005', context);
      const insert = statements.find(({ sql }) => sql.startsWith('insert into identity.registration_cases'))!;
      expect(insert.values[4]).toBe('review_required');
      const candidates = statements.filter(({ sql }) => sql.startsWith('insert into identity.registration_case_candidates'));
      expect(candidates).toHaveLength(1);
      expect(candidates[0]!.values[1]).toBe(statedPatient);
      expect(candidates[0]!.values[2]).not.toBe(65);
      expect(JSON.parse(candidates[0]!.values[3] as string)).toContain('stated_hid');
      expect(JSON.parse(candidates[0]!.values[3] as string).length).toBeGreaterThan(1);
      const event = statements.find(({ sql }) => sql.startsWith('insert into identity.registration_case_events'))!;
      expect(JSON.parse(event.values[6] as string)).toMatchObject({ statedHealthId: 'matches' });
    });

    it('accepts the old body: no key needed, no contact stored or copied, contactRecorded false', async () => {
      jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NODE_ENV: 'test' } as environment.Environment);
      const { registrations, statements } = setup({ ninMatch: true });
      const old = { ...ninBase } as unknown as ResolveNinDto;
      await registrations.resolve(old, 'resolve-key-000000006', context);
      expect(statements.some(({ sql }) => sql.startsWith('insert into identity.registration_cases'))).toBe(true);
      expect(statements.some(({ sql }) => sql.includes('registration_case_contacts ('))).toBe(false);
      expect(statements.some(({ sql }) => sql.startsWith('insert into identity.patient_facility_contacts'))).toBe(false);
      const event = statements.find(({ sql }) => sql.startsWith('insert into identity.registration_case_events'))!;
      expect(JSON.parse(event.values[6] as string)).toMatchObject({ contactRecorded: false, statedHealthId: 'none' });
    });

    it('lets a verified NIN match win over a different stated Health ID, and copies the contact to that patient', async () => {
      const { registrations, statements } = setup({ ninMatch: true, statedFound: true });
      await registrations.resolve(desk({ hasExistingHealthId: true, existingHealthId: 'HID-ABC234' }),
        'resolve-key-000000003', context);
      const insert = statements.find(({ sql }) => sql.startsWith('insert into identity.registration_cases'))!;
      expect(insert.values[4]).toBe('resolved_existing_identity');
      expect(statements.some(({ sql }) => sql.startsWith('insert into identity.registration_case_candidates'))).toBe(false);
      const event = statements.find(({ sql }) => sql.startsWith('insert into identity.registration_case_events'))!;
      expect(JSON.parse(event.values[6] as string)).toMatchObject({ statedHealthId: 'no_match' });
      const copy = statements.find(({ sql }) => sql.startsWith('insert into identity.patient_facility_contacts'))!;
      expect(copy.values).toEqual([ninPatient, insert.values[0], 'account', 'membership']);
    });

    it('refuses before verifying when the encryption key is missing', async () => {
      jest.spyOn(environment, 'getEnvironment').mockReturnValue({ NODE_ENV: 'test' } as environment.Environment);
      const { registrations, statements } = setup();
      await expect(registrations.resolve(desk(), 'resolve-key-000000004', context))
        .rejects.toMatchObject({ status: 503, code: 'COLLECTED_FIELDS_UNAVAILABLE' });
      expect(statements).toHaveLength(0);
    });
  });

  describe('approve and link copy the contact once the case has a patient', () => {
    const caseId = '7d3b6a52-6f1e-4a8e-9b0c-1d2e3f4a5b6c';
    const patientId = '0f9e8d7c-6b5a-4c3d-8e2f-1a0b9c8d7e6f';
    const context = { actor: { subject: 'synthetic:registrar', accountId: 'account' }, facilityId: 'facility',
      membershipId: 'membership', correlationId: 'correlation', purposeOfUse: 'healthcare-operations',
    } as unknown as DataAccessContext;

    it('links an existing patient and copies the case\'s contact after the case points to that patient', async () => {
      const statements: Array<{ sql: string; values: unknown[] }> = [];
      const client = { query: jest.fn(async (sql: string, values: unknown[] = []) => {
        statements.push({ sql: sql.replace(/\s+/g, ' ').trim(), values });
        if (/for update/i.test(sql)) return { rows: [{ id: caseId }] };
        if (sql.includes('has_contact')) {
          return { rows: [{ id: caseId, status: 'review_required', row_version: '1', resolved_patient_id: null,
            resolved_hid_code: null, candidate_count: '1', has_contact: true, nin_lookup_hmac: 'h'.repeat(64),
            nin_ciphertext: Buffer.alloc(40), nin_last4: '8901', nin_key_version: 'v1', verified_at: new Date(),
            verification_provider: 'synthetic', verification_reference: 'ref' }] };
        }
        if (/registration_case_candidates\s+where case_id/.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 };
        if (sql.includes("identifier_type = 'nin'")) return { rows: [], rowCount: 0 };
        if (sql.includes('where registration.id = $1 and registration.facility_id')) {
          return { rows: [{ id: caseId, status: 'linked_existing', row_version: '2', resolved_patient_id: patientId,
            resolved_hid_code: 'HID-ABC234', candidate_count: '1', contact_recorded: true }] };
        }
        return { rows: [], rowCount: 1 };
      }) };
      const database = { withTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) => work(client)) };
      const audit = { recordWithClient: jest.fn(async () => undefined) };
      const registrations = new NinRegistrationService(database as never, audit as never, {} as never, {} as never,
        {} as never);
      await expect(registrations.linkExisting(caseId, { patientId, expectedVersion: 1,
        reason: 'Same person on review', purpose: 'healthcare-operations' } as never, 'link-key-0000000000001', context))
        .resolves.toMatchObject({ status: 'linked_existing', contactRecorded: true });
      const update = statements.findIndex(({ sql }) => sql.startsWith('update identity.registration_cases'));
      const copy = statements.findIndex(({ sql }) => sql.startsWith('insert into identity.patient_facility_contacts'));
      expect(update).toBeGreaterThan(-1);
      expect(copy).toBeGreaterThan(update);
      expect(statements[copy]!.values).toEqual([patientId, caseId, 'account', 'membership']);
    });

    it('refuses to link a candidate whose only reason is the stated Health ID (D13)', async () => {
      const statements: string[] = [];
      const client = { query: jest.fn(async (sql: string) => {
        statements.push(sql.replace(/\s+/g, ' ').trim());
        if (/for update/i.test(sql)) return { rows: [{ id: caseId }] };
        if (sql.includes('has_contact')) {
          return { rows: [{ id: caseId, status: 'review_required', row_version: '1', resolved_patient_id: null,
            resolved_hid_code: null, candidate_count: '1', has_contact: true, nin_lookup_hmac: 'h'.repeat(64) }] };
        }
        return { rows: [], rowCount: 0 };
      }) };
      const database = { withTransaction: jest.fn(async (_c: unknown, work: (c: unknown) => unknown) => work(client)) };
      const registrations = new NinRegistrationService(database as never, { recordWithClient: jest.fn() } as never,
        {} as never, {} as never, {} as never);
      await expect(registrations.linkExisting(caseId, { patientId, expectedVersion: 1,
        reason: 'Same person on review', purpose: 'healthcare-operations' } as never, 'link-key-0000000000002', context))
        .rejects.toMatchObject({ status: 409, code: 'PATIENT_NOT_A_REVIEW_CANDIDATE' });
      expect(statements.find((sql) => sql.startsWith('select 1 from identity.registration_case_candidates')))
        .toContain(`match_reasons <> '["stated_hid"]'::jsonb`);
      expect(statements.some((sql) => sql.startsWith('insert into identity.patient_identifiers'))).toBe(false);
    });
  });
});
