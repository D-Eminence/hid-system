-- Phase 0/1 authorization vocabulary. These are governed policy identifiers,
-- not user assignments or demonstration data.

insert into auth.roles (code, description) values
  ('doctor', 'Facility-scoped physician'),
  ('clinician', 'Facility-scoped general clinician'),
  ('nurse', 'Facility-scoped nurse'),
  ('lab', 'Facility-scoped laboratory professional'),
  ('pharmacist', 'Facility-scoped pharmacist'),
  ('receptionist', 'Facility-scoped registration and encounter coordinator'),
  ('admin', 'Facility-scoped operational administrator'),
  ('org_admin', 'Facility-scoped organization administrator during Phase 1'),
  ('platform_admin', 'Explicitly assigned platform administrator; never inferred during migration'),
  ('document_scanner', 'Workload identity permitted to append document scan results');

insert into auth.permissions (code, description) values
  ('identity.patient.read', 'Resolve a consent-authorized patient identity'),
  ('identity.consent.read', 'Read consent and access evidence'),
  ('identity.consent.write', 'Create governed consent/access transitions'),
  ('identity.authorization.check', 'Evaluate patient access for the selected membership, facility, action, and purpose'),
  ('organization.manage', 'Manage facility configuration within an authorized organizational scope'),
  ('workforce.manage', 'Manage workforce memberships within an authorized organizational scope'),
  ('platform.manage', 'Perform separately controlled platform administration'),
  ('ehr.encounter.read', 'Read encounters'),
  ('ehr.encounter.write', 'Create and transition encounters'),
  ('ehr.note.read', 'Read clinical notes'),
  ('ehr.note.write', 'Create, sign, and amend clinical notes'),
  ('ehr.vital.read', 'Read vital observations'),
  ('ehr.vital.write', 'Record and correct vital observations'),
  ('ehr.diagnosis.read', 'Read diagnoses'),
  ('ehr.diagnosis.write', 'Record and correct diagnoses'),
  ('ehr.prescription.read', 'Read medication requests'),
  ('ehr.prescription.write', 'Create and transition medication requests'),
  ('ehr.lab-request.read', 'Read laboratory service requests'),
  ('ehr.lab-request.write', 'Create and transition laboratory service requests'),
  ('ehr.document.read', 'Read authorized document metadata and request downloads'),
  ('ehr.document.write', 'Initiate and classify document uploads'),
  ('ehr.document.scan', 'Append malware/content scan results'),
  ('audit.read', 'Read authorized facility audit evidence');

insert into auth.role_permissions (role_code, permission_code)
select mapping.role_code, mapping.permission_code
from (values
  ('doctor', 'identity.patient.read'), ('doctor', 'identity.consent.read'), ('doctor', 'identity.authorization.check'),
  ('doctor', 'ehr.encounter.read'), ('doctor', 'ehr.encounter.write'),
  ('doctor', 'ehr.note.read'), ('doctor', 'ehr.note.write'),
  ('doctor', 'ehr.vital.read'), ('doctor', 'ehr.vital.write'),
  ('doctor', 'ehr.diagnosis.read'), ('doctor', 'ehr.diagnosis.write'),
  ('doctor', 'ehr.prescription.read'), ('doctor', 'ehr.prescription.write'),
  ('doctor', 'ehr.lab-request.read'), ('doctor', 'ehr.lab-request.write'),
  ('doctor', 'ehr.document.read'), ('doctor', 'ehr.document.write'),

  ('clinician', 'identity.patient.read'), ('clinician', 'identity.consent.read'), ('clinician', 'identity.authorization.check'),
  ('clinician', 'ehr.encounter.read'), ('clinician', 'ehr.encounter.write'),
  ('clinician', 'ehr.note.read'), ('clinician', 'ehr.note.write'),
  ('clinician', 'ehr.vital.read'), ('clinician', 'ehr.vital.write'),
  ('clinician', 'ehr.diagnosis.read'), ('clinician', 'ehr.diagnosis.write'),
  ('clinician', 'ehr.prescription.read'), ('clinician', 'ehr.prescription.write'),
  ('clinician', 'ehr.lab-request.read'), ('clinician', 'ehr.lab-request.write'),
  ('clinician', 'ehr.document.read'), ('clinician', 'ehr.document.write'),

  ('nurse', 'identity.patient.read'), ('nurse', 'identity.consent.read'), ('nurse', 'identity.authorization.check'),
  ('nurse', 'ehr.encounter.read'), ('nurse', 'ehr.encounter.write'),
  ('nurse', 'ehr.note.read'), ('nurse', 'ehr.note.write'),
  ('nurse', 'ehr.vital.read'), ('nurse', 'ehr.vital.write'),
  ('nurse', 'ehr.diagnosis.read'), ('nurse', 'ehr.prescription.read'),
  ('nurse', 'ehr.lab-request.read'), ('nurse', 'ehr.document.read'), ('nurse', 'ehr.document.write'),

  ('lab', 'identity.patient.read'), ('lab', 'identity.consent.read'), ('lab', 'identity.authorization.check'),
  ('lab', 'ehr.encounter.read'), ('lab', 'ehr.lab-request.read'), ('lab', 'ehr.lab-request.write'),
  ('lab', 'ehr.document.read'), ('lab', 'ehr.document.write'),

  ('pharmacist', 'identity.patient.read'), ('pharmacist', 'identity.consent.read'), ('pharmacist', 'identity.authorization.check'),
  ('pharmacist', 'ehr.encounter.read'), ('pharmacist', 'ehr.prescription.read'),

  ('receptionist', 'identity.patient.read'), ('receptionist', 'identity.consent.read'), ('receptionist', 'identity.authorization.check'),
  ('receptionist', 'ehr.encounter.read'), ('receptionist', 'ehr.encounter.write'),

  ('admin', 'organization.manage'), ('admin', 'workforce.manage'), ('admin', 'audit.read'),
  ('org_admin', 'organization.manage'), ('org_admin', 'workforce.manage'), ('org_admin', 'audit.read'),
  ('platform_admin', 'platform.manage'),

  ('document_scanner', 'ehr.document.scan')
) as mapping(role_code, permission_code);

comment on table auth.account_roles is
  'Assignments are scoped to an exact facility membership or explicitly platform-wide; callers must never union facility roles across memberships.';
