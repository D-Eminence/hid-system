jest.mock('jose', () => ({ createRemoteJWKSet: jest.fn(), jwtVerify: jest.fn() }));

import { randomUUID } from 'node:crypto';
import { type INestApplication, ValidationPipe } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { NextFunction, Response } from 'express';
import request from 'supertest';
import type { AuditService } from '../audit/audit.service';
import { SecurityGuard } from '../auth/security.guard';
import type { TokenService } from '../auth/token.service';
import { AUDIT_ACTION, AUDIT_FAILURES_ONLY, FACILITY_OPTIONAL, PUBLIC_ROUTE,
  REQUIRED_PERMISSIONS } from '../common/decorators';
import { DomainProblem, ProblemDetailsFilter } from '../common/problem';
import type { ActorContext, HidRequest } from '../common/request-context';
import { resetEnvironmentForTests } from '../config/environment';
import { DatabaseService } from '../database/database.service';
import { AdminOrganizationApplicationsController } from './organization-applications.controller';
import { AdminSelfServiceApplicationsController,
  AdminSelfServiceFacilitiesController } from './self-service-facilities.controller';
import { SelfServiceFacilitiesService } from './self-service-facilities.service';

const applicationId = 'a0000000-0000-4000-8000-000000000086';
const row = {
  application_id: applicationId, row_version: '5', organization_id: 'b0000000-0000-4000-8000-000000000086',
  organization_name: 'Synthetic Clinic Ltd', facility_id: 'c0000000-0000-4000-8000-000000000086',
  facility_name: 'Synthetic Clinic Ltd', facility_lifecycle_status: 'verified', product_code: 'ehr',
  organization_type: 'hospital', cac_hint: 'RC…4567', administrator_name: 'Synthetic Provider Admin',
  administrator_email: 'provider@example.invalid', administrator_account_id: 'd0000000-0000-4000-8000-000000000086',
  administrator_account_status: 'active', activated_at: new Date('2026-10-24T09:15:00.000Z'),
  reviewed_at: null, reviewed_by_account_id: null, review_note: null,
  released_at: null, released_by_account_id: null, release_reason: null,
};
const item = {
  applicationId, version: 5, organizationId: row.organization_id, organizationName: 'Synthetic Clinic Ltd',
  facilityId: row.facility_id, facilityName: 'Synthetic Clinic Ltd', facilityLifecycleStatus: 'verified',
  productCode: 'ehr', organizationType: 'hospital', cacHint: 'RC…4567', administratorName: 'Synthetic Provider Admin',
  administratorEmail: 'provider@example.invalid', administratorAccountId: row.administrator_account_id,
  administratorAccountStatus: 'active', activatedAt: '2026-10-24T09:15:00.000Z', reviewedAt: null,
  reviewedByAccountId: null, reviewNote: null, releasedAt: null, releasedByAccountId: null, releaseReason: null,
  // P4b's columns, absent from a P4 row: empty, not missing.
  reviewGrantsRole: null, reviewableRoles: [], grantedRole: null, verificationMethod: null,
  administratorLicenceBody: null, administratorLicenceNumber: null, administratorLicenceRecordedAt: null,
  memberCount: null, pendingInvitationCount: null, probationEndsAt: null, breakGlassLast7d: null,
  deliveryFailuresLastDay: null,
};
// What review grants and records (P4b, SPEC 3.5).
const doctorAccess = { grantedRole: 'doctor', verificationMethod: 'regulator_register',
  administratorLicence: { body: 'MDCN', number: ' mdcn/12  345 ' } };
const openRow = {
  application_id: applicationId, row_version: '3', product_code: 'ehr', organization_type: 'hospital',
  cac_hint: 'RC…4567', organization_name: 'Synthetic Clinic Ltd', administrator_name: 'Squatter',
  administrator_email: 'squatter@example.invalid', application_status: 'ready_for_review',
  verification_result: 'verified', email_verified: true,
  submitted_at: new Date('2026-10-24T08:00:00.000Z'), lapses_at: new Date('2026-10-25T08:00:00.000Z'),
  holds_cac: true, total_count: '1',
};
const openItem = {
  applicationId, version: 3, productCode: 'ehr', organizationType: 'hospital', cacHint: 'RC…4567',
  organizationName: 'Synthetic Clinic Ltd', administratorName: 'Squatter', administratorEmail: 'squatter@example.invalid',
  status: 'ready_for_review', verificationResult: 'verified', emailVerified: true,
  submittedAt: '2026-10-24T08:00:00.000Z', lapsesAt: '2026-10-25T08:00:00.000Z', holdsCac: true,
};

// A standalone platform administrator: platform authority, no facility membership.
const standaloneAdmin = (platformPermissions: string[]): ActorContext => ({
  kind: 'staff', id: 'standalone:administrator', subject: 'standalone:administrator',
  accountId: 'e0000000-0000-4000-8000-000000000086', roles: [], permissions: [],
  platformRoles: ['platform_super_admin'], platformPermissions, facilityIds: [], facilities: [],
  authenticationMethod: 'local',
});
const allPermissions = ['platform.admin.access', 'platform.identity-review.read', 'platform.facility.manage',
  'platform.facility.unlock'];

function serviceWith(query: jest.Mock) {
  const database = { withPlatformTransaction: jest.fn(async (_context, work) => work({ query })) };
  return { database, service: new SelfServiceFacilitiesService(database as unknown as DatabaseService) };
}
const context = { actor: standaloneAdmin(allPermissions), correlationId: 'review-test',
  purposeOfUse: 'healthcare-operations' as const };

describe('self-signed-up facility review: service', () => {
  it('lists through the read-only platform command and answers camelCase', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [row, { ...row, application_id: 'other', row_version: 9,
      reviewed_at: '2026-10-24T12:00:00Z', reviewed_by_account_id: 'reviewer', review_note: 'Checked the email domain' }] });
    const { service, database } = serviceWith(query);
    const answer = await service.list(context, 'all');
    expect(database.withPlatformTransaction).toHaveBeenCalledWith(context, expect.any(Function), { readOnly: true });
    expect(query).toHaveBeenCalledWith('select * from identity.admin_list_self_service_facilities($1)', ['all']);
    expect(answer.items[0]).toEqual(item);
    expect(answer.items[1]).toMatchObject({ applicationId: 'other', version: 9, reviewedAt: '2026-10-24T12:00:00.000Z',
      reviewedByAccountId: 'reviewer', reviewNote: 'Checked the email domain' });
  });

  it('lists a released sign-up with its release (R2)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ ...row, released_at: new Date('2026-10-25T10:00:00.000Z'),
      released_by_account_id: 'releaser', release_reason: 'Impostor confirmed' }] });
    const answer = await serviceWith(query).service.list(context, 'reviewed');
    expect(answer.items[0]).toEqual({ ...item, releasedAt: '2026-10-25T10:00:00.000Z',
      releasedByAccountId: 'releaser', releaseReason: 'Impostor confirmed' });
  });

  it('releases a sign-up with the expected version and answers the new version (R2)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ application_id: applicationId,
      released_at: new Date('2026-10-25T10:00:00.000Z'), row_version: '7' }] });
    const { service, database } = serviceWith(query);
    await expect(service.release(context, applicationId, 6, 'Impostor confirmed by support'))
      .resolves.toEqual({ applicationId, releasedAt: '2026-10-25T10:00:00.000Z', version: 7 });
    expect(database.withPlatformTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    expect(query).toHaveBeenCalledWith('select * from identity.admin_release_self_service_facility($1,$2,$3,$4)',
      [applicationId, 6, 'Impostor confirmed by support', false]);
    await service.release(context, applicationId, 6, 'Right company, wrong email', true);
    expect(query).toHaveBeenLastCalledWith('select * from identity.admin_release_self_service_facility($1,$2,$3,$4)',
      [applicationId, 6, 'Right company, wrong email', true]);
  });

  it.each([
    ['P0002', 'x', 404, 'SELF_SERVICE_FACILITY_NOT_FOUND'],
    ['40001', 'x', 409, 'VERSION_CONFLICT'],
    ['23505', 'SELF_SERVICE_FACILITY_ALREADY_RELEASED', 409, 'SELF_SERVICE_FACILITY_ALREADY_RELEASED'],
    ['23514', 'SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION', 409, 'SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION'],
    ['23514', 'new row violates check constraint', 503, 'SELF_SERVICE_FACILITY_UNAVAILABLE'],
    ['22023', 'x', 400, 'SELF_SERVICE_FACILITY_REQUEST_INVALID'],
    ['42501', 'x', 403, 'PERMISSION_DENIED'],
  ])('maps the release command\'s %s (%s) to %i %s', async (code, message, status, answer) => {
    const { service } = serviceWith(jest.fn().mockRejectedValue(Object.assign(new Error(message), { code })));
    await expect(service.release(context, applicationId, 6, 'Impostor confirmed by support'))
      .rejects.toMatchObject({ status, code: answer });
  });

  it('lists open self-service applications and rejects one at its version (R3)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [openRow] }).mockResolvedValueOnce({ rows: [{
      application_id: applicationId, rejected_at: new Date('2026-10-24T09:00:00.000Z'), row_version: '4' }] });
    const { service, database } = serviceWith(query);
    await expect(service.listOpenApplications(context)).resolves.toEqual({ total: 1, items: [openItem] });
    expect(database.withPlatformTransaction).toHaveBeenNthCalledWith(1, context, expect.any(Function), { readOnly: true });
    expect(query).toHaveBeenNthCalledWith(1, 'select * from identity.admin_list_open_self_service_applications($1)',
      [null]);
    await expect(service.rejectOpenApplication(context, applicationId, 3, 'Squat on a real company'))
      .resolves.toEqual({ applicationId, rejectedAt: '2026-10-24T09:00:00.000Z', version: 4 });
    expect(query).toHaveBeenNthCalledWith(2, 'select * from identity.admin_reject_self_service_application($1,$2,$3,$4)',
      [applicationId, 3, 'Squat on a real company', false]);
  });

  it('searches one CAC number, counts beyond the 200 shown, and answers an empty list with total 0 (R16)', async () => {
    const query = jest.fn().mockResolvedValueOnce({ rows: [{ ...openRow, holds_cac: false, total_count: 340 }] })
      .mockResolvedValueOnce({ rows: [] });
    const { service } = serviceWith(query);
    await expect(service.listOpenApplications(context, 'RC1234567')).resolves.toEqual({ total: 340,
      items: [{ ...openItem, holdsCac: false }] });
    expect(query).toHaveBeenNthCalledWith(1, 'select * from identity.admin_list_open_self_service_applications($1)',
      ['RC1234567']);
    await expect(service.listOpenApplications(context)).resolves.toEqual({ total: 0, items: [] });
  });

  it('rejects letting the applicant retry (R15)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ application_id: applicationId,
      rejected_at: new Date('2026-10-24T09:00:00.000Z'), row_version: '4' }] });
    await serviceWith(query).service.rejectOpenApplication(context, applicationId, 3, 'Mistyped the email', true);
    expect(query).toHaveBeenCalledWith('select * from identity.admin_reject_self_service_application($1,$2,$3,$4)',
      [applicationId, 3, 'Mistyped the email', true]);
  });

  it('waives the refusals of a CAC number and product and answers each one (R15)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [
      { application_id: applicationId, waived_at: new Date('2026-10-25T11:00:00.000Z'), row_version: '8' },
      { application_id: 'other', waived_at: '2026-10-25T11:00:00Z', row_version: 3 }] });
    const { service, database } = serviceWith(query);
    await expect(service.waiveRefusals(context, 'RC1234567', 'ehr', 'The company confirmed its office'))
      .resolves.toEqual({ waived: [
        { applicationId, waivedAt: '2026-10-25T11:00:00.000Z', version: 8 },
        { applicationId: 'other', waivedAt: '2026-10-25T11:00:00.000Z', version: 3 }] });
    expect(database.withPlatformTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    expect(query).toHaveBeenCalledWith('select * from identity.admin_waive_self_service_refusals($1,$2,$3)',
      ['RC1234567', 'ehr', 'The company confirmed its office']);
  });

  it.each([
    ['P0002', 404, 'SELF_SERVICE_REFUSAL_NOT_FOUND'],
    ['22023', 400, 'SELF_SERVICE_FACILITY_REQUEST_INVALID'],
    ['42501', 403, 'PERMISSION_DENIED'],
    ['23514', 503, 'SELF_SERVICE_FACILITY_UNAVAILABLE'],
  ])('maps the waiver\'s %s to %i %s (R15)', async (code, status, answer) => {
    const { service } = serviceWith(jest.fn().mockRejectedValue(Object.assign(new Error('private'), { code })));
    await expect(service.waiveRefusals(context, 'RC1234567', 'ehr', 'The company confirmed its office'))
      .rejects.toMatchObject({ status, code: answer });
  });

  it('answers a waiver that returns no row 503', async () => {
    await expect(serviceWith(jest.fn().mockResolvedValue({ rows: [] })).service
      .waiveRefusals(context, 'RC1234567', 'ehr', 'The company confirmed its office'))
      .rejects.toMatchObject({ status: 503, code: 'SELF_SERVICE_FACILITY_UNAVAILABLE' });
  });

  it.each([
    ['P0002', 404, 'SELF_SERVICE_APPLICATION_NOT_FOUND'],
    ['40001', 409, 'VERSION_CONFLICT'],
    ['22023', 400, 'SELF_SERVICE_FACILITY_REQUEST_INVALID'],
    ['42501', 403, 'PERMISSION_DENIED'],
    ['23514', 503, 'SELF_SERVICE_FACILITY_UNAVAILABLE'],
  ])('maps the reject command\'s %s to %i %s', async (code, status, answer) => {
    const { service } = serviceWith(jest.fn().mockRejectedValue(Object.assign(new Error('private'), { code })));
    await expect(service.rejectOpenApplication(context, applicationId, 3, 'Squat on a real company'))
      .rejects.toMatchObject({ status, code: answer });
  });

  it('records a review with the expected version, the role, the evidence and the normalized licence (P4b)', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ application_id: applicationId,
      reviewed_at: new Date('2026-10-24T13:00:00.000Z'), row_version: '6', granted_role: 'doctor', sessions_revoked: '2' }] });
    const { service, database } = serviceWith(query);
    await expect(service.review(context, applicationId, 5, 'Email domain matches the company', doctorAccess))
      .resolves.toEqual({ applicationId, reviewedAt: '2026-10-24T13:00:00.000Z', version: 6, grantedRole: 'doctor',
        sessionsRevoked: 2 });
    expect(database.withPlatformTransaction).toHaveBeenCalledWith(context, expect.any(Function));
    expect(query).toHaveBeenCalledWith(
      'select * from identity.admin_review_self_service_facility($1,$2,$3,$4,$5,$6,$7)',
      [applicationId, 5, 'Email domain matches the company', 'doctor', 'regulator_register', 'MDCN', 'MDCN/12 345']);
    // 'none', or a clinical role without a licence (the database answers that), passes nulls.
    await service.review(context, applicationId, 5, 'Email domain matches the company',
      { grantedRole: 'none', verificationMethod: 'officer_match' });
    expect(query).toHaveBeenLastCalledWith(expect.any(String),
      [applicationId, 5, 'Email domain matches the company', 'none', 'officer_match', null, null]);
  });

  it('lists P4b\'s review columns in camelCase, counts as numbers', async () => {
    const query = jest.fn().mockResolvedValue({ rows: [{ ...row, review_grants_role: 'doctor',
      reviewable_roles: ['doctor', 'nurse'], granted_role: null, verification_method: null,
      administrator_licence_body: 'MDCN', administrator_licence_number: 'MDCN/12345',
      administrator_licence_recorded_at: new Date('2026-10-24T10:00:00.000Z'), member_count: '1',
      pending_invitation_count: 0, probation_ends_at: null, break_glass_last_7d: '0', delivery_failures_last_day: 0 }] });
    const answer = await serviceWith(query).service.list(context, 'unreviewed');
    expect(answer.items[0]).toEqual({ ...item, reviewGrantsRole: 'doctor', reviewableRoles: ['doctor', 'nurse'],
      administratorLicenceBody: 'MDCN', administratorLicenceNumber: 'MDCN/12345',
      administratorLicenceRecordedAt: '2026-10-24T10:00:00.000Z', memberCount: 1, pendingInvitationCount: 0,
      breakGlassLast7d: 0, deliveryFailuresLastDay: 0 });
    const reviewed = await serviceWith(jest.fn().mockResolvedValue({ rows: [{ ...row, granted_role: 'none',
      verification_method: 'in_person', probation_ends_at: '2026-11-23T13:00:00Z', member_count: 4,
      pending_invitation_count: 2, break_glass_last_7d: 3, delivery_failures_last_day: 1 }] })).service.list(context, 'reviewed');
    expect(reviewed.items[0]).toMatchObject({ grantedRole: 'none', verificationMethod: 'in_person',
      probationEndsAt: '2026-11-23T13:00:00.000Z', memberCount: 4, pendingInvitationCount: 2, breakGlassLast7d: 3,
      deliveryFailuresLastDay: 1 });
  });

  it('changes a reviewed administrator\'s role and ends the first 30 days (P4b, SPEC 3.7, 3.8)', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce({ rows: [{ application_id: applicationId, row_version: '8', granted_role: 'doctor',
        sessions_revoked: 1 }] })
      .mockResolvedValueOnce({ rows: [{ application_id: applicationId, row_version: '9',
        probation_ended_at: new Date('2026-10-30T09:00:00.000Z') }] });
    const { service, database } = serviceWith(query);
    await expect(service.setAdministratorRole(context, applicationId, 7, doctorAccess, 'Licence found on the register'))
      .resolves.toEqual({ applicationId, version: 8, grantedRole: 'doctor', sessionsRevoked: 1 });
    expect(query).toHaveBeenNthCalledWith(1,
      'select * from identity.admin_set_self_service_administrator_role($1,$2,$3,$4,$5,$6,$7)',
      [applicationId, 7, 'doctor', 'MDCN', 'MDCN/12 345', 'regulator_register', 'Licence found on the register']);
    await expect(service.endProbation(context, applicationId, 8, 'Known hospital, limits lifted'))
      .resolves.toEqual({ applicationId, version: 9, probationEndedAt: '2026-10-30T09:00:00.000Z' });
    expect(query).toHaveBeenNthCalledWith(2, 'select * from identity.admin_end_self_service_probation($1,$2,$3)',
      [applicationId, 8, 'Known hospital, limits lifted']);
    expect(database.withPlatformTransaction).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['22023', 'SELF_SERVICE_REVIEW_ROLE_INVALID', 400, 'SELF_SERVICE_REVIEW_ROLE_INVALID'],
    ['22023', 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED', 400, 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED'],
    ['22023', 'SELF_SERVICE_REVIEW_LICENCE_INVALID', 400, 'SELF_SERVICE_REVIEW_LICENCE_INVALID'],
    ['22023', 'SELF_SERVICE_REVIEW_INVALID', 400, 'SELF_SERVICE_REVIEW_INVALID'],
    ['22023', 'invalid input syntax', 400, 'SELF_SERVICE_FACILITY_REQUEST_INVALID'],
    ['23514', 'SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE', 409, 'SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE'],
    ['23514', 'new row violates check constraint', 503, 'SELF_SERVICE_FACILITY_UNAVAILABLE'],
    ['23505', 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED', 409, 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED'],
    ['P0002', 'x', 404, 'SELF_SERVICE_FACILITY_NOT_FOUND'],
  ])('maps the review\'s %s %s to %i %s (P4b)', async (code, message, status, answer) => {
    const { service } = serviceWith(jest.fn().mockRejectedValue(Object.assign(new Error(message), { code })));
    await expect(service.review(context, applicationId, 5, 'Email domain matches the company', doctorAccess))
      .rejects.toMatchObject({ status, code: answer });
  });

  it.each([
    ['23505', 'SELF_SERVICE_ADMINISTRATOR_ROLE_UNCHANGED', 409, 'SELF_SERVICE_ADMINISTRATOR_ROLE_UNCHANGED'],
    ['23505', 'duplicate key value', 503, 'SELF_SERVICE_FACILITY_UNAVAILABLE'],
    ['23514', 'SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE', 409, 'SELF_SERVICE_FACILITY_REVIEW_REQUIRES_ACTIVE'],
    ['22023', 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED', 400, 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED'],
    ['P0002', 'x', 404, 'SELF_SERVICE_FACILITY_NOT_FOUND'],
    ['40001', 'x', 409, 'VERSION_CONFLICT'],
    ['42501', 'x', 403, 'PERMISSION_DENIED'],
  ])('maps the administrator-role command\'s %s %s to %i %s', async (code, message, status, answer) => {
    const { service } = serviceWith(jest.fn().mockRejectedValue(Object.assign(new Error(message), { code })));
    await expect(service.setAdministratorRole(context, applicationId, 7, doctorAccess, 'Licence found on the register'))
      .rejects.toMatchObject({ status, code: answer });
  });

  it.each([
    ['23505', 'SELF_SERVICE_PROBATION_ALREADY_ENDED', 409, 'SELF_SERVICE_PROBATION_ALREADY_ENDED'],
    ['23505', 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED', 503, 'SELF_SERVICE_FACILITY_UNAVAILABLE'],
    ['P0002', 'x', 404, 'SELF_SERVICE_FACILITY_NOT_FOUND'],
    ['40001', 'x', 409, 'VERSION_CONFLICT'],
    ['22023', 'x', 400, 'SELF_SERVICE_FACILITY_REQUEST_INVALID'],
  ])('maps the end-probation command\'s %s %s to %i %s', async (code, message, status, answer) => {
    const { service } = serviceWith(jest.fn().mockRejectedValue(Object.assign(new Error(message), { code })));
    await expect(service.endProbation(context, applicationId, 8, 'Known hospital, limits lifted'))
      .rejects.toMatchObject({ status, code: answer });
  });

  it.each([
    ['P0002', 404, 'SELF_SERVICE_FACILITY_NOT_FOUND'],
    ['40001', 409, 'VERSION_CONFLICT'],
    ['23505', 409, 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED'],
    ['23514', 503, 'SELF_SERVICE_FACILITY_UNAVAILABLE'],
    ['22023', 400, 'SELF_SERVICE_FACILITY_REQUEST_INVALID'],
    ['42501', 403, 'PERMISSION_DENIED'],
    ['XX000', 503, 'SELF_SERVICE_FACILITY_UNAVAILABLE'],
  ])('maps the review command\'s %s to %i %s without its diagnostics', async (code, status, answer) => {
    const { service } = serviceWith(jest.fn().mockRejectedValue(
      Object.assign(new Error('private SQL diagnostics'), { code })));
    const failure = await service.review(context, applicationId, 5, 'Email domain matches the company', doctorAccess)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(DomainProblem);
    expect(failure).toMatchObject({ status, code: answer });
    expect((failure as DomainProblem).message).not.toContain('private');
  });

  it('answers a review that returns no row 503, and list faults as list faults', async () => {
    await expect(serviceWith(jest.fn().mockResolvedValue({ rows: [] })).service
      .review(context, applicationId, 5, 'Email domain matches the company', doctorAccess))
      .rejects.toMatchObject({ status: 503, code: 'SELF_SERVICE_FACILITY_REVIEW_UNAVAILABLE' });
    await expect(serviceWith(jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '22023' }))).service
      .list(context, 'unreviewed')).rejects.toMatchObject({ status: 400, code: 'SELF_SERVICE_FACILITY_REQUEST_INVALID' });
    await expect(serviceWith(jest.fn().mockRejectedValue(Object.assign(new Error('x'), { code: '42501' }))).service
      .list(context, 'unreviewed')).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
  });
});

describe('self-signed-up facility review: route metadata', () => {
  const meta = (key: symbol, target: object) => Reflect.getMetadata(key, target) as unknown;
  const review = AdminSelfServiceFacilitiesController.prototype;
  const applications = AdminOrganizationApplicationsController.prototype;

  it('uses the admin organization-application guards and audit', () => {
    for (const key of [FACILITY_OPTIONAL, AUDIT_FAILURES_ONLY]) {
      expect(meta(key, AdminSelfServiceFacilitiesController)).toBe(true);
      expect(meta(key, AdminOrganizationApplicationsController)).toBe(true);
    }
    expect(meta(PUBLIC_ROUTE, AdminSelfServiceFacilitiesController)).toBeUndefined();
    expect(meta(REQUIRED_PERMISSIONS, review.list)).toEqual(meta(REQUIRED_PERMISSIONS, applications.list));
    expect(meta(REQUIRED_PERMISSIONS, review.list)).toEqual(['platform.identity-review.read']);
    // P4b (S13): review unlocks clinical access, so it also needs platform.facility.unlock.
    expect(meta(REQUIRED_PERMISSIONS, applications.reject)).toEqual(['platform.facility.manage']);
    expect(meta(REQUIRED_PERMISSIONS, review.review)).toEqual(['platform.facility.manage', 'platform.facility.unlock']);
    // A standalone administrator's audit row is a platform row only for admin.* actions.
    expect(meta(AUDIT_ACTION, review.list)).toBe('admin.self-service-facilities.list');
    expect(meta(AUDIT_ACTION, review.review)).toBe('admin.self-service-facility.review');
  });

  it('guards the release and the open applications like the list and review (R2, R3)', () => {
    const open = AdminSelfServiceApplicationsController.prototype;
    for (const key of [FACILITY_OPTIONAL, AUDIT_FAILURES_ONLY]) {
      expect(meta(key, AdminSelfServiceApplicationsController)).toBe(true);
    }
    expect(meta(PUBLIC_ROUTE, AdminSelfServiceApplicationsController)).toBeUndefined();
    expect(meta(REQUIRED_PERMISSIONS, review.release)).toEqual(['platform.facility.manage']);
    expect(meta(REQUIRED_PERMISSIONS, open.list)).toEqual(['platform.identity-review.read']);
    expect(meta(REQUIRED_PERMISSIONS, open.reject)).toEqual(['platform.facility.manage']);
    expect(meta(AUDIT_ACTION, review.release)).toBe('admin.self-service-facility.release');
    expect(meta(AUDIT_ACTION, open.list)).toBe('admin.self-service-applications.list');
    expect(meta(AUDIT_ACTION, open.reject)).toBe('admin.self-service-application.reject');
  });

  it('guards the administrator-role and end-probation commands as the review (P4b)', () => {
    expect(meta(REQUIRED_PERMISSIONS, review.administratorRole)).toEqual(['platform.facility.manage', 'platform.facility.unlock']);
    expect(meta(REQUIRED_PERMISSIONS, review.endProbation)).toEqual(['platform.facility.manage', 'platform.facility.unlock']);
    expect(meta(AUDIT_ACTION, review.administratorRole)).toBe('admin.self-service-facility.administrator-role');
    expect(meta(AUDIT_ACTION, review.endProbation)).toBe('admin.self-service-facility.probation-end');
  });

  it('guards the search like the list and the waiver like the rejection (R15, R16)', () => {
    const open = AdminSelfServiceApplicationsController.prototype;
    expect(meta(REQUIRED_PERMISSIONS, open.search)).toEqual(meta(REQUIRED_PERMISSIONS, open.list));
    expect(meta(AUDIT_ACTION, open.search)).toBe(meta(AUDIT_ACTION, open.list));
    expect(meta(REQUIRED_PERMISSIONS, open.waiveRefusal)).toEqual(['platform.facility.manage']);
    expect(meta(AUDIT_ACTION, open.waiveRefusal)).toBe('admin.self-service-application.refusal-waive');
  });
});

describe('self-signed-up facility review over HTTP, as a standalone platform administrator', () => {
  const originalEnvironment = { ...process.env };
  let app: INestApplication;
  const query = jest.fn();
  const database = { withPlatformTransaction: jest.fn(), query: jest.fn() };
  const tokens = { verify: jest.fn() };
  const audit = { record: jest.fn() };
  const base = '/api/v1/admin/self-service-facilities';

  beforeEach(async () => {
    Object.assign(process.env, {
      NODE_ENV: 'test', DATABASE_URL: 'postgresql://test:test@localhost/hid',
      CORS_ORIGINS: 'https://admin.healthidentitydirectory.com', AUTH_MODE: 'local',
      AUTH_SIGNING_SECRET: '01234567890123456789012345678901',
      AUTH_LOGIN_PEPPER: 'abcdefghijklmnopqrstuvwxyz123456',
    });
    resetEnvironmentForTests();
    jest.resetAllMocks();
    database.withPlatformTransaction.mockImplementation(async (_context, work) => work({ query }));
    tokens.verify.mockResolvedValue({ actor: standaloneAdmin(allPermissions), claims: {} });
    audit.record.mockResolvedValue(undefined);
    const moduleRef = await Test.createTestingModule({
      controllers: [AdminSelfServiceFacilitiesController, AdminSelfServiceApplicationsController],
      providers: [SelfServiceFacilitiesService, { provide: DatabaseService, useValue: database }],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.setGlobalPrefix('api/v1');
    app.use((incoming: HidRequest, _response: Response, next: NextFunction) => {
      incoming.correlationId = randomUUID();
      next();
    });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
      transform: true, transformOptions: { enableImplicitConversion: false },
      exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
        errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
    app.useGlobalFilters(new ProblemDetailsFilter());
    app.useGlobalGuards(new SecurityGuard(new Reflector(), tokens as unknown as TokenService,
      audit as unknown as AuditService, database as unknown as DatabaseService));
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    for (const key of Object.keys(process.env)) if (!(key in originalEnvironment)) delete process.env[key];
    Object.assign(process.env, originalEnvironment);
    resetEnvironmentForTests();
  });

  it('lists unreviewed sign-ups by default, with no facility in the platform context', async () => {
    query.mockResolvedValue({ rows: [row] });
    const answer = await request(app.getHttpServer()).get(base).set('Authorization', 'Bearer synthetic');
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ items: [item] });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('admin_list_self_service_facilities'), ['unreviewed']);
    const platformContext = database.withPlatformTransaction.mock.calls[0]?.[0];
    expect(platformContext).toMatchObject({ purposeOfUse: 'healthcare-operations',
      actor: expect.objectContaining({ subject: 'standalone:administrator' }) });
    expect(platformContext.facilityId).toBeUndefined();
    expect(platformContext.membershipId).toBeUndefined();
    for (const state of ['reviewed', 'all']) {
      await request(app.getHttpServer()).get(`${base}?state=${state}`).set('Authorization', 'Bearer synthetic')
        .expect(200);
      expect(query).toHaveBeenLastCalledWith(expect.any(String), [state]);
    }
  });

  it('refuses an unknown state 400 before the database', async () => {
    const answer = await request(app.getHttpServer()).get(`${base}?state=pending`).set('Authorization', 'Bearer synthetic');
    expect([answer.status, answer.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });

  it('marks a sign-up reviewed with If-Match, a trimmed note, the role, the evidence and the licence', async () => {
    query.mockResolvedValue({ rows: [{ application_id: applicationId,
      reviewed_at: new Date('2026-10-24T13:00:00.000Z'), row_version: '6', granted_role: 'doctor', sessions_revoked: 1 }] });
    const answer = await request(app.getHttpServer()).post(`${base}/${applicationId}/review`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"5"')
      .send({ note: '  Email domain matches the company  ', ...doctorAccess });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ applicationId, reviewedAt: '2026-10-24T13:00:00.000Z', version: 6,
      grantedRole: 'doctor', sessionsRevoked: 1 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('admin_review_self_service_facility($1,$2,$3,$4,$5,$6,$7)'),
      [applicationId, 5, 'Email domain matches the company', 'doctor', 'regulator_register', 'MDCN', 'MDCN/12 345']);
    // A clinical role with no licence reaches the database, which answers 400 LICENCE_REQUIRED (verifier step 2).
    query.mockRejectedValueOnce(Object.assign(new Error('SELF_SERVICE_REVIEW_LICENCE_REQUIRED'), { code: '22023' }));
    const noLicence = await request(app.getHttpServer()).post(`${base}/${applicationId}/review`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"5"')
      .send({ note: 'Email domain matches the company', grantedRole: 'doctor', verificationMethod: 'officer_match' });
    expect([noLicence.status, noLicence.body.code]).toEqual([400, 'SELF_SERVICE_REVIEW_LICENCE_REQUIRED']);
  });

  it('refuses a review body with an unknown role, method or licence shape 400 before the database', async () => {
    const note = 'Email domain matches the company';
    for (const body of [
      { note }, { note, grantedRole: 'doctor' }, { note, verificationMethod: 'officer_match' },
      { note, grantedRole: 'clinician', verificationMethod: 'officer_match' },
      { note, grantedRole: 'org_admin', verificationMethod: 'officer_match' },
      { note, grantedRole: 'doctor', verificationMethod: 'phoned' },
      { note, ...doctorAccess, administratorLicence: { body: 'GMC', number: '12345' } },
      { note, ...doctorAccess, administratorLicence: { body: 'MDCN', number: '12' } },
      { note, ...doctorAccess, administratorLicence: { body: 'MDCN', number: '12345', expires: '2030' } },
      { note, ...doctorAccess, administratorLicence: null },
      { note, ...doctorAccess, administratorLicence: 'MDCN 12345' },
    ]) {
      const invalid = await request(app.getHttpServer()).post(`${base}/${applicationId}/review`)
        .set('Authorization', 'Bearer synthetic').set('If-Match', '"5"').send(body);
      expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });

  it('changes the administrator\'s access and ends the first 30 days with If-Match (P4b)', async () => {
    query.mockResolvedValueOnce({ rows: [{ application_id: applicationId, row_version: '8', granted_role: 'nurse',
      sessions_revoked: '1' }] });
    const changed = await request(app.getHttpServer()).post(`${base}/${applicationId}/administrator-role`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"7"')
      .send({ grantedRole: 'nurse', verificationMethod: 'regulator_register',
        administratorLicence: { body: 'NMCN', number: 'rn 0042' }, reason: '  Nursing licence found  ' });
    expect([changed.status, changed.body]).toEqual([200, { applicationId, version: 8, grantedRole: 'nurse',
      sessionsRevoked: 1 }]);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('admin_set_self_service_administrator_role'),
      [applicationId, 7, 'nurse', 'NMCN', 'RN 0042', 'regulator_register', 'Nursing licence found']);
    query.mockRejectedValueOnce(Object.assign(new Error('SELF_SERVICE_ADMINISTRATOR_ROLE_UNCHANGED'), { code: '23505' }));
    const unchanged = await request(app.getHttpServer()).post(`${base}/${applicationId}/administrator-role`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"8"')
      .send({ grantedRole: 'none', verificationMethod: 'other', reason: 'No clinical access needed' });
    expect([unchanged.status, unchanged.body.code]).toEqual([409, 'SELF_SERVICE_ADMINISTRATOR_ROLE_UNCHANGED']);
    query.mockResolvedValueOnce({ rows: [{ application_id: applicationId, row_version: '9',
      probation_ended_at: '2026-10-30T09:00:00Z' }] });
    const ended = await request(app.getHttpServer()).post(`${base}/${applicationId}/end-probation`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '9').send({ reason: 'Known hospital, limits lifted' });
    expect([ended.status, ended.body]).toEqual([200, { applicationId, version: 9,
      probationEndedAt: '2026-10-30T09:00:00.000Z' }]);
    const noVersion = await request(app.getHttpServer()).post(`${base}/${applicationId}/end-probation`)
      .set('Authorization', 'Bearer synthetic').send({ reason: 'Known hospital, limits lifted' });
    expect([noVersion.status, noVersion.body.code]).toEqual([428, 'IF_MATCH_REQUIRED']);
    const shortReason = await request(app.getHttpServer()).post(`${base}/${applicationId}/end-probation`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '9').send({ reason: 'short' });
    expect([shortReason.status, shortReason.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    // Without platform.facility.unlock, none of the three reaches the database (S13).
    tokens.verify.mockResolvedValue({ actor: standaloneAdmin(['platform.admin.access', 'platform.identity-review.read',
      'platform.facility.manage']), claims: {} });
    query.mockClear();
    for (const [path, body] of [['review', { note: 'Email domain matches', ...doctorAccess }],
      ['administrator-role', { ...doctorAccess, reason: 'Licence found on register' }],
      ['end-probation', { reason: 'Known hospital, limits lifted' }]] as const) {
      const refused = await request(app.getHttpServer()).post(`${base}/${applicationId}/${path}`)
        .set('Authorization', 'Bearer synthetic').set('If-Match', '9').send(body);
      expect([refused.status, refused.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    }
    expect(query).not.toHaveBeenCalled();
  });

  it('refuses a review without a version 428, a short or long note 400 and a malformed id 400', async () => {
    const post = (path: string, body: object, ifMatch?: string) => {
      const call = request(app.getHttpServer()).post(path).set('Authorization', 'Bearer synthetic');
      return (ifMatch ? call.set('If-Match', ifMatch) : call).send(body);
    };
    const noVersion = await post(`${base}/${applicationId}/review`, { note: 'Email domain matches', ...doctorAccess });
    expect([noVersion.status, noVersion.body.code]).toEqual([428, 'IF_MATCH_REQUIRED']);
    for (const note of ['  short  ', 'x'.repeat(501), 42]) {
      const invalid = await post(`${base}/${applicationId}/review`, { note, ...doctorAccess }, '"5"');
      expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    const extra = await post(`${base}/${applicationId}/review`, { note: 'Email domain matches', ...doctorAccess,
      suspend: true }, '"5"');
    expect(extra.status).toBe(400);
    const badId = await post(`${base}/not-a-uuid/review`, { note: 'Email domain matches', ...doctorAccess }, '"5"');
    expect(badId.status).toBe(400);
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });

  it('answers the database\'s conflicts with their codes', async () => {
    for (const [code, status, answer] of [['P0002', 404, 'SELF_SERVICE_FACILITY_NOT_FOUND'],
      ['40001', 409, 'VERSION_CONFLICT'], ['23505', 409, 'SELF_SERVICE_FACILITY_ALREADY_REVIEWED']] as const) {
      query.mockRejectedValueOnce(Object.assign(new Error('private'), { code }));
      const refused = await request(app.getHttpServer()).post(`${base}/${applicationId}/review`)
        .set('Authorization', 'Bearer synthetic').set('If-Match', '5').send({ note: 'Email domain matches', ...doctorAccess });
      expect([refused.status, refused.body.code]).toEqual([status, answer]);
    }
  });

  it('releases a sign-up with If-Match and a trimmed reason (R2)', async () => {
    query.mockResolvedValue({ rows: [{ application_id: applicationId,
      released_at: new Date('2026-10-25T10:00:00.000Z'), row_version: '7' }] });
    const answer = await request(app.getHttpServer()).post(`${base}/${applicationId}/release`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"6"')
      .send({ reason: '  Impostor confirmed by support  ' });
    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ applicationId, releasedAt: '2026-10-25T10:00:00.000Z', version: 7 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('admin_release_self_service_facility($1,$2,$3,$4)'),
      [applicationId, 6, 'Impostor confirmed by support', false]);
    const retry = await request(app.getHttpServer()).post(`${base}/${applicationId}/release`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"6"')
      .send({ reason: 'Right company, wrong email', allowRetry: true });
    expect(retry.status).toBe(200);
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [applicationId, 6, 'Right company, wrong email', true]);
    for (const allowRetry of [null, 'yes', 1]) {
      const invalid = await request(app.getHttpServer()).post(`${base}/${applicationId}/release`)
        .set('Authorization', 'Bearer synthetic').set('If-Match', '"6"')
        .send({ reason: 'Impostor confirmed by support', allowRetry });
      expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    const noVersion = await request(app.getHttpServer()).post(`${base}/${applicationId}/release`)
      .set('Authorization', 'Bearer synthetic').send({ reason: 'Impostor confirmed by support' });
    expect([noVersion.status, noVersion.body.code]).toEqual([428, 'IF_MATCH_REQUIRED']);
    const shortReason = await request(app.getHttpServer()).post(`${base}/${applicationId}/release`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"6"').send({ reason: 'short' });
    expect([shortReason.status, shortReason.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    query.mockRejectedValueOnce(Object.assign(new Error('SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION'),
      { code: '23514' }));
    const active = await request(app.getHttpServer()).post(`${base}/${applicationId}/release`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"6"').send({ reason: 'Impostor confirmed by support' });
    expect([active.status, active.body.code]).toEqual([409, 'SELF_SERVICE_FACILITY_RELEASE_REQUIRES_SUSPENSION']);
  });

  it('lists open self-service applications and rejects one with If-Match (R3)', async () => {
    const applications = '/api/v1/admin/self-service-applications';
    query.mockResolvedValueOnce({ rows: [openRow] });
    const listed = await request(app.getHttpServer()).get(applications).set('Authorization', 'Bearer synthetic');
    expect([listed.status, listed.body]).toEqual([200, { total: 1, items: [openItem] }]);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('admin_list_open_self_service_applications($1)'),
      [null]);
    query.mockResolvedValueOnce({ rows: [{ application_id: applicationId,
      rejected_at: new Date('2026-10-24T09:00:00.000Z'), row_version: '4' }] });
    const rejected = await request(app.getHttpServer()).post(`${applications}/${applicationId}/reject`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"3"').send({ reason: ' Squat on a real company ' });
    expect([rejected.status, rejected.body]).toEqual([200,
      { applicationId, rejectedAt: '2026-10-24T09:00:00.000Z', version: 4 }]);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('admin_reject_self_service_application($1,$2,$3,$4)'),
      [applicationId, 3, 'Squat on a real company', false]);
    query.mockResolvedValueOnce({ rows: [{ application_id: applicationId,
      rejected_at: new Date('2026-10-24T09:00:00.000Z'), row_version: '4' }] });
    const retry = await request(app.getHttpServer()).post(`${applications}/${applicationId}/reject`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"3"')
      .send({ reason: 'Mistyped the email', allowRetry: true });
    expect(retry.status).toBe(200);
    expect(query).toHaveBeenLastCalledWith(expect.any(String), [applicationId, 3, 'Mistyped the email', true]);
    const nullRetry = await request(app.getHttpServer()).post(`${applications}/${applicationId}/reject`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"3"')
      .send({ reason: 'Mistyped the email', allowRetry: null });
    expect([nullRetry.status, nullRetry.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    query.mockRejectedValueOnce(Object.assign(new Error('private'), { code: 'P0002' }));
    const gone = await request(app.getHttpServer()).post(`${applications}/${applicationId}/reject`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"3"').send({ reason: 'Squat on a real company' });
    expect([gone.status, gone.body.code]).toEqual([404, 'SELF_SERVICE_APPLICATION_NOT_FOUND']);
    tokens.verify.mockResolvedValue({ actor: standaloneAdmin(['platform.admin.access', 'platform.identity-review.read']),
      claims: {} });
    const withoutManage = await request(app.getHttpServer()).post(`${applications}/${applicationId}/reject`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '"3"').send({ reason: 'Squat on a real company' });
    expect([withoutManage.status, withoutManage.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('searches open applications by CAC number in the body (R16)', async () => {
    const applications = '/api/v1/admin/self-service-applications';
    query.mockResolvedValueOnce({ rows: [openRow] });
    const found = await request(app.getHttpServer()).post(`${applications}/search`)
      .set('Authorization', 'Bearer synthetic').send({ cacRegistrationNumber: ' rc 1234 567 ' });
    expect([found.status, found.body]).toEqual([200, { total: 1, items: [openItem] }]);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('admin_list_open_self_service_applications($1)'),
      ['RC1234567']);
    for (const body of [{}, { cacRegistrationNumber: 'RC12' }, { cacRegistrationNumber: 1234567 },
      { cacRegistrationNumber: 'RC1234567', status: 'open' }]) {
      const invalid = await request(app.getHttpServer()).post(`${applications}/search`)
        .set('Authorization', 'Bearer synthetic').send(body);
      expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(query).toHaveBeenCalledTimes(1);
    tokens.verify.mockResolvedValue({ actor: standaloneAdmin(['platform.admin.access', 'platform.facility.manage']),
      claims: {} });
    const withoutRead = await request(app.getHttpServer()).post(`${applications}/search`)
      .set('Authorization', 'Bearer synthetic').send({ cacRegistrationNumber: 'RC1234567' });
    expect([withoutRead.status, withoutRead.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('waives the refusals of a CAC number and product (R15)', async () => {
    const waive = '/api/v1/admin/self-service-applications/waive-refusal';
    query.mockResolvedValueOnce({ rows: [{ application_id: applicationId,
      waived_at: new Date('2026-10-25T11:00:00.000Z'), row_version: '8' }] });
    const waived = await request(app.getHttpServer()).post(waive).set('Authorization', 'Bearer synthetic')
      .send({ cacRegistrationNumber: 'rc1234567', productCode: 'ehr', reason: '  The company confirmed its office  ' });
    expect([waived.status, waived.body]).toEqual([200,
      { waived: [{ applicationId, waivedAt: '2026-10-25T11:00:00.000Z', version: 8 }] }]);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('admin_waive_self_service_refusals($1,$2,$3)'),
      ['RC1234567', 'ehr', 'The company confirmed its office']);
    query.mockRejectedValueOnce(Object.assign(new Error('private'), { code: 'P0002' }));
    const none = await request(app.getHttpServer()).post(waive).set('Authorization', 'Bearer synthetic')
      .send({ cacRegistrationNumber: 'RC1234567', productCode: 'ehr', reason: 'The company confirmed its office' });
    expect([none.status, none.body.code]).toEqual([404, 'SELF_SERVICE_REFUSAL_NOT_FOUND']);
    for (const body of [{ cacRegistrationNumber: 'RC1234567', productCode: 'dental', reason: 'The company confirmed' },
      { cacRegistrationNumber: 'RC12', productCode: 'ehr', reason: 'The company confirmed' },
      { cacRegistrationNumber: 'RC1234567', productCode: 'ehr', reason: 'short' },
      { cacRegistrationNumber: 'RC1234567', productCode: 'ehr', reason: 'The company confirmed', extra: true }]) {
      const invalid = await request(app.getHttpServer()).post(waive).set('Authorization', 'Bearer synthetic').send(body);
      expect([invalid.status, invalid.body.code]).toEqual([400, 'VALIDATION_FAILED']);
    }
    expect(query).toHaveBeenCalledTimes(2);
    tokens.verify.mockResolvedValue({ actor: standaloneAdmin(['platform.admin.access', 'platform.identity-review.read']),
      claims: {} });
    const withoutManage = await request(app.getHttpServer()).post(waive).set('Authorization', 'Bearer synthetic')
      .send({ cacRegistrationNumber: 'RC1234567', productCode: 'ehr', reason: 'The company confirmed its office' });
    expect([withoutManage.status, withoutManage.body.code]).toEqual([403, 'PERMISSION_DENIED']);
  });

  it('refuses an administrator without the list or review permission 403 before the database', async () => {
    tokens.verify.mockResolvedValue({ actor: standaloneAdmin(['platform.admin.access']), claims: {} });
    const list = await request(app.getHttpServer()).get(base).set('Authorization', 'Bearer synthetic');
    const review = await request(app.getHttpServer()).post(`${base}/${applicationId}/review`)
      .set('Authorization', 'Bearer synthetic').set('If-Match', '5').send({ note: 'Email domain matches' });
    for (const answer of [list, review]) expect([answer.status, answer.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });

  it('refuses a facility user who holds the permissions but no platform administration', async () => {
    const facility = { id: 'f0000000-0000-4000-8000-000000000086', membershipId: randomUUID(), organizationId: randomUUID(),
      name: 'Synthetic', roles: ['org_admin'], permissions: ['platform.identity-review.read'], isPrimary: true };
    tokens.verify.mockResolvedValue({ actor: { ...standaloneAdmin([]), facilityIds: [facility.id],
      facilities: [facility] }, claims: {} });
    database.query.mockResolvedValue({ rows: [{ enabled: true }] });
    database.query.mockResolvedValueOnce({ rows: [{ enabled: false }] });
    const answer = await request(app.getHttpServer()).get(base).set('Authorization', 'Bearer synthetic')
      .set('X-Facility-ID', facility.id);
    expect([answer.status, answer.body.code]).toEqual([403, 'PERMISSION_DENIED']);
    expect(database.withPlatformTransaction).not.toHaveBeenCalled();
  });
});
