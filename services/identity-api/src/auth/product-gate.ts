import { DomainProblem } from '../common/problem';
import type { FacilityAssignment, OrganizationProduct } from '../common/request-context';

/**
 * Each staff product is its own site (owner decision of 17 November 2026,
 * Q88): a staff sign-in, a session refresh and a facility choice keep only
 * the facility memberships whose permissions fit the product of the site the
 * request came from. The site is the request's Origin host, matched exactly
 * against the production and staging hosts turnstile.service.ts names. Any
 * other host (app., www., the apex, admin. and every local or development
 * host) has no product here, and keeps today's behaviour.
 */
export type StaffProduct = 'ehr' | 'lab' | 'pharmacy' | 'migrate' | 'outreach';

export const STAFF_PRODUCTS: readonly StaffProduct[] = Object.freeze(['ehr', 'lab', 'pharmacy', 'migrate', 'outreach']);

export const PRODUCT_HOSTS: Readonly<Record<string, StaffProduct>> = Object.freeze({
  'ehr.healthidentitydirectory.com': 'ehr',
  'lab.healthidentitydirectory.com': 'lab',
  'pharmacy.healthidentitydirectory.com': 'pharmacy',
  'migrate.healthidentitydirectory.com': 'migrate',
  'outreach.healthidentitydirectory.com': 'outreach',
  'ehr.staging.healthidentitydirectory.com': 'ehr',
  'lab.staging.healthidentitydirectory.com': 'lab',
  'pharmacy.staging.healthidentitydirectory.com': 'pharmacy',
  'migrate.staging.healthidentitydirectory.com': 'migrate',
  'outreach.staging.healthidentitydirectory.com': 'outreach',
});

/** The product of an Origin, or undefined: an exact https host from PRODUCT_HOSTS, with no port, path or credentials. */
export function productForOrigin(origin: string | undefined): StaffProduct | undefined {
  if (!origin) return undefined;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.origin !== origin) return undefined;
  return Object.prototype.hasOwnProperty.call(PRODUCT_HOSTS, url.hostname) ? PRODUCT_HOSTS[url.hostname] : undefined;
}

export function isStaffProduct(value: unknown): value is StaffProduct {
  return typeof value === 'string' && (STAFF_PRODUCTS as readonly string[]).includes(value);
}

/**
 * The permission codes each rule reads, exactly as the database seeds grant
 * them (auth.role_permissions):
 * - hospital roles: ehr.encounter.write (doctor, clinician, nurse and
 *   receptionist, 0006) or organization.manage (admin and org_admin, 0006);
 *   an administrator (organization.manage) counts as a hospital role only at
 *   a hospital organisation (Q90, Q91: administratorProducts below);
 * - lab roles: lab.work-item.read or lab.work-item.accept (lab, 0018);
 * - pharmacy roles: pharmacy.work-item.read or pharmacy.dispensing.read
 *   (pharmacist, 0023);
 * - outreach roles: outreach.registration.read or outreach.campaign.read
 *   (outreach_organiser and outreach_volunteer at outreach groups, 0115; the
 *   community health worker at hospitals and clinics, 0209; hospital outreach
 *   staff, 0024 and 0038).
 *
 * Each staff site is for its own job (owner decision Q97): lab., pharmacy.
 * and outreach. admit their own roles' codes and a hospital administrator
 * (organization.manage), not the hospital roles' ehr.encounter.write. The
 * seeds also grant clinician and nurse the lab, pharmacy and outreach
 * reading codes, and the receptionist the outreach codes, for their own
 * hospital work (0018, 0023, 0024, 0038; doctors lost theirs in 0136, owner
 * decision Q103 A), so a membership that holds ehr.encounter.write without
 * organization.manage is a hospital clinical membership and is admitted on
 * ehr. and migrate. only (see facilityAdmittedOnProduct).
 */
export const HOSPITAL_PERMISSIONS = Object.freeze(['ehr.encounter.write', 'organization.manage'] as const);
export const LAB_PERMISSIONS = Object.freeze(['lab.work-item.read', 'lab.work-item.accept'] as const);
export const PHARMACY_PERMISSIONS = Object.freeze(['pharmacy.work-item.read', 'pharmacy.dispensing.read'] as const);
export const OUTREACH_PERMISSIONS = Object.freeze(['outreach.registration.read', 'outreach.campaign.read'] as const);
/** A hospital administrator (admin, org_admin): admitted on every site of its own organisation (Q97). */
export const ADMINISTRATOR_PERMISSIONS = Object.freeze(['organization.manage'] as const);
/** The hospital clinical code (doctor, clinician, nurse, receptionist): ehr. and migrate. only (Q97). */
const HOSPITAL_CLINICAL_PERMISSION = 'ehr.encounter.write';
/**
 * The codes only a site's own job holds (the seeds give them to lab and
 * pharmacist, never to doctor, clinician, nurse or receptionist): a
 * membership that holds one is that site's staff too, for example a nurse
 * also given the lab role at a small clinic, so Q97 does not refuse it there.
 * Outreach has none: its own roles hold only outreach codes that the
 * hospital clinical roles hold too (outreach_organiser and outreach_volunteer
 * at outreach groups, 0115; community_health_worker at hospitals and clinics,
 * 0209). A membership holding one of them beside a clinical role is still a
 * hospital clinical membership and is refused on outreach. (the design note's
 * default for CHW-1: no gate change); one holding only them is admitted there
 * by OUTREACH_PERMISSIONS.
 */
const OWN_JOB_PERMISSIONS: Readonly<Record<StaffProduct, readonly string[]>> = Object.freeze({
  ehr: [],
  lab: ['lab.result.enter', 'lab.specimen.receive', 'lab.order-route.receive'],
  pharmacy: ['pharmacy.dispensing.create', 'pharmacy.work-item.accept', 'pharmacy.order-route.receive'],
  migrate: [],
  outreach: [],
});

const PRODUCT_PERMISSIONS: Readonly<Record<StaffProduct, readonly string[]>> = Object.freeze({
  ehr: HOSPITAL_PERMISSIONS,
  lab: [...LAB_PERMISSIONS, ...ADMINISTRATOR_PERMISSIONS],
  pharmacy: [...PHARMACY_PERMISSIONS, ...ADMINISTRATOR_PERMISSIONS],
  // Hospital roles only (since 0136 lab staff hold no ocr.job.* code either; the front desk does).
  migrate: HOSPITAL_PERMISSIONS,
  outreach: [...OUTREACH_PERMISSIONS, ...ADMINISTRATOR_PERMISSIONS],
});

/** Every permission code a product admits a membership by (for the contract and the tests). */
export function productPermissions(product: StaffProduct): readonly string[] {
  return PRODUCT_PERMISSIONS[product];
}

/**
 * The administrator of a facility that signed itself up and waits for Health
 * ID support's review (0086): its membership is org_admin by name, but until
 * the review its permissions are org_admin_awaiting_review's, which hold
 * workforce.manage and not organization.manage. It is that facility's
 * administrator, so it is admitted wherever org_admin would be; without this
 * it could not sign in again on the site it signed up on.
 */
function pendingReviewAdministrator(facility: FacilityAssignment): boolean {
  return facility.selfService?.review === 'pending' && facility.permissions.includes('workforce.manage');
}

/**
 * An administrator's membership: organization.manage (admin and org_admin,
 * 0006) or the administrator awaiting review above. A membership that also
 * holds ehr.encounter.write is a clinical hospital role and is not read as an
 * administrator.
 */
export function administratorMembership(facility: FacilityAssignment): boolean {
  return !facility.permissions.includes('ehr.encounter.write')
    && (facility.permissions.includes('organization.manage') || pendingReviewAdministrator(facility));
}

/**
 * Owner decisions Q90 and Q91 (17 November 2026): an organisation is a
 * hospital when no kind is recorded (Q91 A: the sealed QA and demo hospitals,
 * outreach groups) or any recorded kind is hospital or clinic. The kinds are
 * identity.organization_staff_kinds' (0126), which already reads 'other' as
 * staff_invitable_roles does (ehr or migrate hospital, laboratory laboratory,
 * pharmacy pharmacy) and answers hospital for an organisation promoted from
 * the legacy system, also once a governed approval reused it.
 */
export function organisationIsHospital(facility: FacilityAssignment): boolean {
  const kinds = facility.organizationKinds ?? [];
  return kinds.length === 0 || kinds.includes('hospital') || kinds.includes('clinic');
}

/** The site of each product an organisation can hold (identity.organization_products.product_code). */
const HELD_PRODUCT_SITES: Readonly<Record<OrganizationProduct, StaffProduct>> = Object.freeze({
  ehr: 'ehr', migrate: 'migrate', laboratory: 'lab', pharmacy: 'pharmacy',
});

/**
 * The sites an administrator's membership is admitted on (Q90 A, "each
 * product a separate environment"): at a hospital every product site, as a
 * hospital role; otherwise lab. where the organisation is recorded as a
 * laboratory, pharmacy. where it is recorded as a pharmacy (both at an
 * organisation recorded as both), and the site of each product the
 * organisation holds (a laboratory or pharmacy that bought ehr or migrate,
 * and whose administrator awaiting review signed up there, keeps that site).
 * The administrator's other codes (org_admin also reads outreach
 * registrations; admin also reads lab and pharmacy work) add no site.
 */
export function administratorProducts(facility: FacilityAssignment): readonly StaffProduct[] {
  if (organisationIsHospital(facility)) return STAFF_PRODUCTS;
  const kinds = facility.organizationKinds ?? [];
  const held = (facility.organizationProducts ?? []).map((product) => HELD_PRODUCT_SITES[product]);
  return STAFF_PRODUCTS.filter((product) => (product === 'lab' && kinds.includes('laboratory'))
    || (product === 'pharmacy' && kinds.includes('pharmacy')) || held.includes(product));
}

/** Whether a membership fits a product. */
export function facilityFitsProduct(facility: FacilityAssignment, product: StaffProduct): boolean {
  if (administratorMembership(facility)) return administratorProducts(facility).includes(product);
  const admitted = PRODUCT_PERMISSIONS[product];
  return facility.permissions.some((permission) => admitted.includes(permission));
}

/**
 * A doctor, clinician, nurse or receptionist membership (ehr.encounter.write
 * without organization.manage) on a site that does not admit
 * ehr.encounter.write: it holds that site's reading codes for its own
 * hospital work only, so it is not admitted there (Q97), unless it also
 * holds that site's own job (OWN_JOB_PERMISSIONS).
 */
function hospitalClinicalElsewhere(facility: FacilityAssignment, product: StaffProduct): boolean {
  return !PRODUCT_PERMISSIONS[product].includes(HOSPITAL_CLINICAL_PERMISSION)
    && facility.permissions.includes(HOSPITAL_CLINICAL_PERMISSION)
    && !facility.permissions.some((permission) => (ADMINISTRATOR_PERMISSIONS as readonly string[]).includes(permission))
    && !facility.permissions.some((permission) => OWN_JOB_PERMISSIONS[product].includes(permission));
}

/**
 * Whether a membership is admitted on a product site: the gate every
 * sign-in, refresh, request and facility choice applies. It is
 * facilityFitsProduct (the permission rule above) and then Q97's own rule,
 * kept apart from it on purpose: a hospital clinical membership is not
 * admitted on a site that does not admit ehr.encounter.write, whatever
 * reading codes it holds. Callers use this, never facilityFitsProduct alone.
 */
export function facilityAdmittedOnProduct(facility: FacilityAssignment, product: StaffProduct): boolean {
  return facilityFitsProduct(facility, product) && !hospitalClinicalElsewhere(facility, product);
}

/**
 * The staff product sites a login can open (Q97), in STAFF_PRODUCTS order:
 * every product at least one of its active memberships is admitted on, by the
 * same rule the sign-in applies. The website shows only these sites.
 */
export function productsForFacilities(facilities: readonly FacilityAssignment[]): StaffProduct[] {
  return STAFF_PRODUCTS.filter((product) => facilities.some((facility) => facilityAdmittedOnProduct(facility, product)));
}

export const PRODUCT_NOT_AUTHORISED = 'PRODUCT_NOT_AUTHORISED';
export const NO_ACTIVE_FACILITY_MEMBERSHIP = 'NO_ACTIVE_FACILITY_MEMBERSHIP';

/**
 * The right password, but none of the account's facilities fits this site's
 * product (named in the `product` member). Raised only after the password was
 * checked, never counted as a failed sign-in.
 */
export class ProductNotAuthorisedProblem extends DomainProblem {
  /** The account the refusal is about, for the audit row only; never sent. */
  constructor(public readonly product: StaffProduct, public readonly accountSubject?: string) {
    super(403, PRODUCT_NOT_AUTHORISED, "This account isn't set up for this Health ID product.", undefined,
      { extensions: { product } });
  }
}

/**
 * The right password for an active, verified staff account that belongs to
 * no facility and no outreach group yet. Raised only after the password was
 * checked, never counted as a failed sign-in.
 */
export class NoActiveFacilityMembershipProblem extends DomainProblem {
  /** The account the refusal is about, for the audit row only; never sent. */
  constructor(public readonly accountSubject?: string) {
    super(403, NO_ACTIVE_FACILITY_MEMBERSHIP, "You aren't part of a facility or outreach group yet.");
  }
}

/** Whether an error is one of the two sign-in refusals above (the password was right). */
export function isProductGateRefusal(error: unknown): error is ProductNotAuthorisedProblem | NoActiveFacilityMembershipProblem {
  return error instanceof ProductNotAuthorisedProblem || error instanceof NoActiveFacilityMembershipProblem;
}
