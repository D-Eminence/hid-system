import { ValidationPipe } from '@nestjs/common';
import { DomainProblem } from '../common/problem';
import {
  AcceptStaffInvitationDto, AdministratorLicenceDto, ChangeFacilityStaffRoleDto, CreateStaffInvitationDto,
  EndFacilityStaffDto, ExpectedVersionDto, OpenStaffInvitationDto, SignedInInvitationDto,
} from './dto/staff-invitation.dto';
import {
  licenceNumberAcceptable, normalizeLicenceNumber, selfServiceAdministratorRole, selfServiceReviewableRoles,
  STAFF_ROLE_LABELS, staffInvitableRoles, staffRoleLicenceBody,
} from './staff-licence';
import {
  acceptableStaffPersonName, DOMAIN_LIKE, EMAIL_FACILITY_NAME, emailFacilityName, hasReservedWord, shownInviterName,
} from './staff-names';

// The production ValidationPipe options (main.ts).
const pipe = new ValidationPipe({
  whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true, transform: true,
  transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
  exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
    errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))),
});
const validate = <T>(metatype: new () => T, value: unknown) =>
  pipe.transform(value, { type: 'body', metatype }) as Promise<T>;
const refused = async (metatype: new () => unknown, value: unknown) => {
  const error = await validate(metatype, value).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(DomainProblem);
  expect(error).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
};

const token = 'Ab3_-Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LzXcVbNm';
const invitationId = '3f2a9c1b-7d4e-4a5b-8c6d-0e1f2a3b4c5d';

describe('staff vocabulary (SPEC 3.6, 4.2)', () => {
  it('invitable roles by organization type and product', () => {
    for (const type of ['hospital', 'clinic']) {
      for (const product of ['ehr', 'migrate', 'laboratory', 'pharmacy']) {
        expect(staffInvitableRoles(type, product)).toEqual(['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist']);
      }
    }
    for (const product of ['ehr', 'migrate', 'laboratory', 'pharmacy']) {
      expect(staffInvitableRoles('laboratory', product)).toEqual(['lab', 'receptionist']);
      expect(staffInvitableRoles('pharmacy', product)).toEqual(['pharmacist', 'receptionist']);
    }
    expect(staffInvitableRoles('other', 'ehr')).toEqual(['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist']);
    expect(staffInvitableRoles('other', 'migrate')).toEqual(['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist']);
    expect(staffInvitableRoles('other', 'laboratory')).toEqual(['lab', 'receptionist']);
    expect(staffInvitableRoles('other', 'pharmacy')).toEqual(['pharmacist', 'receptionist']);
    expect(staffInvitableRoles('dental', 'ehr')).toEqual([]);
  });

  it('reviewable and preselected administrator roles; none preselected for other (Q3)', () => {
    expect([selfServiceReviewableRoles('hospital', 'pharmacy'), selfServiceAdministratorRole('hospital', 'pharmacy')])
      .toEqual([['doctor', 'nurse'], 'doctor']);
    expect([selfServiceReviewableRoles('clinic', 'ehr'), selfServiceAdministratorRole('clinic', 'ehr')])
      .toEqual([['doctor', 'nurse'], 'doctor']);
    expect([selfServiceReviewableRoles('laboratory', 'ehr'), selfServiceAdministratorRole('laboratory', 'ehr')])
      .toEqual([['lab'], 'lab']);
    expect([selfServiceReviewableRoles('pharmacy', 'ehr'), selfServiceAdministratorRole('pharmacy', 'ehr')])
      .toEqual([['pharmacist'], 'pharmacist']);
    expect([selfServiceReviewableRoles('other', 'ehr'), selfServiceAdministratorRole('other', 'ehr')])
      .toEqual([['doctor', 'nurse'], null]);
    expect([selfServiceReviewableRoles('other', 'laboratory'), selfServiceAdministratorRole('other', 'laboratory')])
      .toEqual([['lab'], null]);
    expect([selfServiceReviewableRoles('other', 'pharmacy'), selfServiceAdministratorRole('other', 'pharmacy')])
      .toEqual([['pharmacist'], null]);
  });

  it('licence body and labels by role; no clinician, admin or platform role', () => {
    expect(['doctor', 'nurse', 'lab', 'pharmacist', 'receptionist', 'clinician', 'org_admin'].map(staffRoleLicenceBody))
      .toEqual(['MDCN', 'NMCN', 'MLSCN', 'PCN', null, null, null]);
    expect(Object.fromEntries(Object.entries(STAFF_ROLE_LABELS).map(([role, label]) => [role, label.lower]))).toEqual({
      doctor: 'doctor', nurse: 'nurse', lab: 'laboratory scientist', pharmacist: 'pharmacist', receptionist: 'receptionist' });
  });

  it('normalizes a licence number and checks the database\'s pattern', () => {
    expect(normalizeLicenceNumber('  mdcn/12\t 345 ')).toBe('MDCN/12 345');
    expect(normalizeLicenceNumber('rn-0042.a')).toBe('RN-0042.A');
    for (const number of ['MDCN/12345', 'RN 0042', 'A12', '12/34.5-6']) expect(licenceNumberAcceptable(normalizeLicenceNumber(number))).toBe(true);
    for (const number of ['A', 'A1', '/123', '123/', 'AB  12', 'MDCN#1', `A${'1'.repeat(100)}`]) expect(licenceNumberAcceptable(number)).toBe(false);
  });
});

describe('staff names (S3, SPEC 6.1)', () => {
  it('accepts a person\'s name of letters and marks with single separators', () => {
    for (const name of ['Ada Obi', 'Ọlá Adébáyọ̀', "Chidi O'Neil", 'Mary-Jane Okafor', 'Ụ́chè Ada Obi Eze Nwosu Ike']) {
      expect(acceptableStaffPersonName(name)).toBe(true);
    }
  });

  it.each(['Ada', 'Ada  Obi', 'Ada Obi1', 'Dr. Ada Obi', 'ada@obi.com', 'hid-payroll.com Ada', 'Ada <b>', 'Ada/Obi',
    ' Ada Obi', 'Ada Obi ', 'A B C D E F G', `${'A'.repeat(40)} ${'B'.repeat(40)}`, 'Health ID Support',
    'HealthID Ada', 'Ada Hid', 'Support Team', 'Ada Admin', 'Facility Administrator', 'Ministry Health',
    'Health-Id Obi'])('refuses %p', (name) => {
    expect(acceptableStaffPersonName(name)).toBe(false);
  });

  it('finds reserved words only as whole words', () => {
    expect(hasReservedWord('Hidayat Adminu')).toBe(false);
    expect(hasReservedWord('Supporta Health')).toBe(false);
    expect(hasReservedWord('Ada health id')).toBe(true);
  });

  it('shows the inviter only by a person\'s name, else null', () => {
    expect(shownInviterName('  Dr Ada Obi ')).toBe('Dr Ada Obi');
    for (const name of ['hid-payroll.com', 'Health ID Support', 'Ada', null, undefined, 'Ada Obi 2']) {
      expect(shownInviterName(name)).toBeNull();
    }
  });

  it('sends a facility name only when notification-api accepts it and nothing in it can become a link', () => {
    expect(emailFacilityName('Ọlá Adébáyọ̀ Specialist Hospital Ltd')).toBe('Ọlá Adébáyọ̀ Specialist Hospital Ltd');
    expect(emailFacilityName('St. Mary\'s Hospital (Ikeja) & Maternity')).toBe('St. Mary\'s Hospital (Ikeja) & Maternity');
    for (const name of ['hid-payroll.com', 'Clinic.Com Ltd', 'https://x.test', 'Clinic <b>', 'Clinic\nBcc', '',
      'A'.repeat(201), null, undefined, 'Clinic​']) {
      expect(emailFacilityName(name)).toBeUndefined();
    }
    expect(DOMAIN_LIKE.test('Clinic No. 5')).toBe(false);
    // The same pattern as notification-api's DeliverStaffInvitationDto.
    expect(EMAIL_FACILITY_NAME.source).toBe('^(?!.*:\\/\\/)(?!.*[\\p{L}\\p{N}]\\.[\\p{L}]{2})[^\\p{Cc}\\p{Cf}<>]{1,200}$');
  });
});

describe('staff invitation DTOs (SPEC 6.1)', () => {
  const create = { name: '  Ada Obi ', email: ' Ada.Obi@Example.TEST ', role: 'doctor', licenceBody: 'MDCN',
    licenceNumber: ' mdcn/12345 ', attested: true, currentPassword: ' a password with spaces ' };

  it('accepts an invitation, trimming the name and lower-casing the email, and keeps the password as typed', async () => {
    const value = await validate(CreateStaffInvitationDto, create);
    expect(value).toMatchObject({ name: 'Ada Obi', email: 'ada.obi@example.test', role: 'doctor', licenceBody: 'MDCN',
      licenceNumber: 'mdcn/12345', attested: true, currentPassword: ' a password with spaces ' });
    const receptionist = await validate(CreateStaffInvitationDto, { ...create, role: 'receptionist', licenceBody: undefined,
      licenceNumber: undefined });
    expect(receptionist.role).toBe('receptionist');
    await expect(validate(CreateStaffInvitationDto, { ...create, role: 'receptionist', licenceBody: null,
      licenceNumber: null })).resolves.toBeDefined();
    for (const [role, licenceBody] of [['nurse', 'NMCN'], ['lab', 'MLSCN'], ['pharmacist', 'PCN']]) {
      await expect(validate(CreateStaffInvitationDto, { ...create, role, licenceBody })).resolves.toBeDefined();
    }
  });

  it.each([
    ['a doctor without a licence', { licenceBody: undefined, licenceNumber: undefined }],
    ['a doctor without a number', { licenceNumber: undefined }],
    ['a doctor with a nurse\'s licence', { licenceBody: 'NMCN' }],
    ['a receptionist with a licence', { role: 'receptionist' }],
    ['a receptionist with a number only', { role: 'receptionist', licenceBody: undefined }],
    ['clinician', { role: 'clinician' }], ['org_admin', { role: 'org_admin' }], ['admin', { role: 'admin' }],
    ['org_admin_awaiting_review', { role: 'org_admin_awaiting_review' }],
    ['a short number', { licenceNumber: '12' }], ['a long number', { licenceNumber: '1'.repeat(101) }],
    ['an unknown body', { licenceBody: 'GMC' }], ['no attestation', { attested: undefined }],
    ['attested false', { attested: false }], ['attested "true"', { attested: 'true' }],
    ['no password', { currentPassword: undefined }], ['an empty password', { currentPassword: '' }],
    ['a long password', { currentPassword: 'x'.repeat(257) }], ['a bad email', { email: 'ada' }],
    ['a domain-like name', { name: 'hid-payroll.com' }], ['a one-word name', { name: 'Ada' }],
    ['a reserved word', { name: 'Health ID Support' }], ['an extra field', { attestationVersion: 'v2' }],
    ['an inviter name', { inviterName: 'Dr Ada Obi' }],
  ])('refuses %s', async (_case, change) => {
    await refused(CreateStaffInvitationDto, { ...create, ...change });
  });

  it('takes a positive safe-integer version', async () => {
    await expect(validate(ExpectedVersionDto, { expectedVersion: 3 })).resolves.toEqual({ expectedVersion: 3 });
    for (const expectedVersion of [0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1]) {
      await refused(ExpectedVersionDto, { expectedVersion });
    }
  });

  it('removes with a trimmed reason of 8-500 characters and the password', async () => {
    await expect(validate(EndFacilityStaffDto, { expectedVersion: 2, reason: '  Left the hospital  ',
      currentPassword: 'p' })).resolves.toMatchObject({ reason: 'Left the hospital' });
    await refused(EndFacilityStaffDto, { expectedVersion: 2, reason: 'short', currentPassword: 'p' });
    await refused(EndFacilityStaffDto, { expectedVersion: 2, reason: 'Left the hospital' });
  });

  it('changes a role with the licence pairing, the attestation, a reason and the password', async () => {
    const change = { expectedVersion: 4, role: 'nurse', licenceBody: 'NMCN', licenceNumber: 'RN 0042', attested: true,
      reason: 'Moved to the wards', currentPassword: 'p' };
    await expect(validate(ChangeFacilityStaffRoleDto, change)).resolves.toBeDefined();
    await refused(ChangeFacilityStaffRoleDto, { ...change, licenceBody: 'MDCN' });
    await refused(ChangeFacilityStaffRoleDto, { ...change, role: 'receptionist' });
    await refused(ChangeFacilityStaffRoleDto, { ...change, attested: undefined });
    await refused(ChangeFacilityStaffRoleDto, { ...change, reason: 'short' });
  });

  it('records the administrator\'s own licence: one of the four bodies and a trimmed number', async () => {
    await expect(validate(AdministratorLicenceDto, { licenceBody: 'PCN', licenceNumber: ' 012345 ' }))
      .resolves.toEqual({ licenceBody: 'PCN', licenceNumber: '012345' });
    await refused(AdministratorLicenceDto, { licenceBody: 'GMC', licenceNumber: '012345' });
    await refused(AdministratorLicenceDto, { licenceBody: 'PCN' });
  });

  it('opens in exactly one mode', async () => {
    const turnstile = { turnstileAction: 'staff-invitation', turnstileToken: 'proof' };
    await expect(validate(OpenStaffInvitationDto, { invitationId, token, ...turnstile })).resolves.toBeDefined();
    await expect(validate(OpenStaffInvitationDto, { email: ' Ada@Example.test ', code: '048213', ...turnstile }))
      .resolves.toMatchObject({ email: 'ada@example.test', code: '048213' });
    for (const body of [
      turnstile, { invitationId, ...turnstile }, { token, ...turnstile }, { email: 'ada@example.test', ...turnstile },
      { code: '048213', ...turnstile }, { invitationId, token, email: 'ada@example.test', code: '048213', ...turnstile },
      { invitationId, token, code: '048213', ...turnstile }, { invitationId: 'not-a-uuid', token, ...turnstile },
      { invitationId, token: token.slice(1), ...turnstile }, { invitationId, token: `${token.slice(1)}=`, ...turnstile },
      { email: 'ada@example.test', code: '48213', ...turnstile }, { invitationId, token, turnstileAction: 'provider-enrollment' },
      { invitationId, token, ...turnstile, turnstileToken: 'x'.repeat(2049) }, { invitationId, token, ...turnstile, name: 'x' },
    ]) {
      await refused(OpenStaffInvitationDto, body);
    }
  });

  it('accepts with a password of 12-256 characters', async () => {
    await expect(validate(AcceptStaffInvitationDto, { password: 'twelve chars' })).resolves.toBeDefined();
    await refused(AcceptStaffInvitationDto, { password: 'eleven char' });
    await refused(AcceptStaffInvitationDto, { password: 'x'.repeat(257) });
  });

  it('previews or accepts signed in, by link or by code, never both', async () => {
    await expect(validate(SignedInInvitationDto, { invitationId, token })).resolves.toBeDefined();
    await expect(validate(SignedInInvitationDto, { code: '048213' })).resolves.toBeDefined();
    for (const body of [{}, { invitationId }, { token }, { invitationId, code: '048213' }, { token, code: '048213' },
      { invitationId, token, code: '048213' }, { code: '48213' }, { invitationId, token: 'short' },
      { code: '048213', email: 'ada@example.test' }]) {
      await refused(SignedInInvitationDto, body);
    }
  });
});
