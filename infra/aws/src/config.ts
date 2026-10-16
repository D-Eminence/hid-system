import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export const environmentNames = ['development', 'staging', 'production'] as const;
export type EnvironmentName = typeof environmentNames[number];

export const stagingModes = ['sleep', 'economy', 'fidelity'] as const;
export type StagingMode = typeof stagingModes[number];
export type DeploymentProfile = 'development' | StagingMode | 'production';

export type InterfaceEndpointName =
  | 'ecr-api'
  | 'ecr-docker'
  | 'logs'
  | 'secrets-manager'
  | 'kms'
  | 'eventbridge'
  | 'sqs'
  | 'textract';

const fullInterfaceEndpoints: readonly InterfaceEndpointName[] = [
  'ecr-api', 'ecr-docker', 'logs', 'secrets-manager', 'kms', 'eventbridge', 'sqs', 'textract',
];

/**
 * Browser API modules the gateway can route, in canonical order. Identity owns
 * /api/v1/auth, /identity, /audit, /admin and /commercial.
 */
export const apiRouteModules = ['identity', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach'] as const;
export type ApiRouteModule = typeof apiRouteModules[number];

/**
 * The launch module set (MOD-1): only Identity and EHR routes are proxied.
 * Lab, Pharmacy, OCR and Outreach answer 404 at the gateway until a recorded
 * decision, their own fixes and a staging acceptance run enable them.
 */
export const launchApiRoutes: readonly ApiRouteModule[] = ['identity', 'ehr'];

export interface HidEnvironmentConfig {
  readonly name: EnvironmentName;
  readonly profile: DeploymentProfile;
  readonly stagingMode?: StagingMode;
  readonly publicApiSubdomain: string;
  readonly browserSubdomains: readonly string[];
  readonly originAuthorizationSecretParameter: string;
  readonly vpcCidr: string;
  readonly availabilityZones: number;
  readonly natGateways: number;
  readonly interfaceEndpoints: readonly InterfaceEndpointName[];
  readonly interfaceEndpointAzCount: number;
  readonly runtimeIngressEnabled: boolean;
  readonly autoscalingEnabled: boolean;
  readonly databaseInstanceType: InstanceType;
  readonly databaseInstanceClass: string;
  readonly databaseAllocatedStorageGiB: number;
  readonly databaseMaxStorageGiB: number;
  readonly databaseMultiAz: boolean;
  readonly databaseDeletionProtection: boolean;
  readonly databaseBackupRetention: Duration;
  readonly databaseConnectionBudget: number;
  readonly reviewedEmergencyConnectionBudget: number;
  readonly logRetention: RetentionDays;
  readonly removalPolicy: RemovalPolicy;
  readonly repositoryImageCount: number;
  // Deliberately opt-in at synth time. The default task definition contains
  // no QoreID credential reference and application calls remain disabled.
  readonly qoreIdEnabled: boolean;
  // The gateway's HID_ENABLED_API_ROUTES (deny by default). Synth input
  // HID_ENABLED_API_ROUTES; production accepts only the launch set.
  readonly enabledApiRoutes: readonly ApiRouteModule[];
  // Identity's QOREID_NIN_ONLY_ENROLLMENT_ENABLED. Synth input
  // HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED, default false, refused unless
  // QoreID is enabled and a route to prove that a person holds the NIN is on
  // (ADR-062): the online route or the facility route below.
  readonly qoreIdNinOnlyEnrollmentEnabled: boolean;
  // Identity's NIN_HOLDER_SMS_ENABLED (ADR-062): a one-time code to the phone
  // a NIN record lists. Synth input HID_NIN_HOLDER_SMS_ENABLED, default false;
  // refused on staging (its notification-api sends email only) and, in
  // production, unless the facility route is on too (ADR-063).
  readonly ninHolderSmsEnabled: boolean;
  // Identity's ASSISTED_REGISTRATION_ENABLED: the facility route, an
  // in-person check at a participating facility (0094, ADR-063). Synth input
  // HID_ASSISTED_REGISTRATION_ENABLED, default false.
  readonly assistedRegistrationEnabled: boolean;
  // Identity's QOREID_PATIENT_SELF_NIN_BINDING_ENABLED: the signed-in NIN
  // binding on a name and date-of-birth match. Synth input
  // HID_QOREID_PATIENT_SELF_NIN_BINDING_ENABLED, default false, refused in
  // production until the owner decides whether N1 covers it.
  readonly qoreIdPatientSelfNinBindingEnabled: boolean;
  // Whether the Novu notification worker may run. Synth input
  // HID_NOTIFICATION_WORKER_ENABLED; production is fixed to false (D17)
  // until a Novu account and region are approved.
  readonly notificationWorkerEnabled: boolean;
  // Whether the notification worker gives Novu the patient's verified login
  // email (NOVU_SUBSCRIBER_SYNC=email, ADR-064). Synth input
  // HID_NOVU_SUBSCRIBER_SYNC_ENABLED, default false; staging only, with the
  // worker enabled, after the release checklist's approvals.
  readonly novuSubscriberSyncEnabled: boolean;
  // ehr-api's EHR_PATIENT_RELEASE_* flags (owner decision 4 of 2026-10-16,
  // D7): what a patient's own summary releases beyond encounters and notes.
  // Synth inputs HID_EHR_PATIENT_RELEASE_VITALS, _DIAGNOSES, _PRESCRIPTIONS,
  // _LAB_RESULTS and _DOCUMENTS, each default false and refused outside
  // staging: Lab results while Lab is off at launch (D17), the others until
  // the clinical owner signs them off (P36, ADR-065).
  readonly patientRecordRelease: PatientRecordRelease;
  // Imported legacy medical history (owner decision 3 of 2026-10-16,
  // ADR-067): ehr-api's EHR_PATIENT_RELEASE_IMPORTED_HISTORY (the patient's
  // own read) and EHR_STAFF_IMPORTED_HISTORY_ENABLED (the staff read), and
  // identity-api's IMPORTED_HISTORY_SHARING_ENABLED (the patient's sharing
  // choice). Synth inputs HID_EHR_PATIENT_RELEASE_IMPORTED_HISTORY,
  // HID_EHR_STAFF_IMPORTED_HISTORY_ENABLED and HID_IMPORTED_HISTORY_SHARING_ENABLED,
  // each default false and refused outside staging until the P38 sign-off.
  readonly importedHistory: ImportedHistory;
  // The exact ARN of the operator-created, KMS-encrypted SNS topic
  // hid-<env>-operational-alerts that every alarm notifies (D4, ADR-053).
  // Synth input HID_OPERATIONAL_ALARM_TOPIC_ARN; the regional stack requires
  // it in production and it is optional elsewhere.
  readonly operationalAlarmTopicArn?: string;
  // Identity's enrollment budgets and QoreID timeout that the operator set
  // (synth inputs HID_<VARIABLE>, identityBudgetInputs). Only these are
  // emitted; Identity keeps its own default for every other one.
  readonly identityBudgets: Readonly<Partial<Record<IdentityBudgetVariable, number>>>;
}

/**
 * Identity variables the operator may set at synth time as HID_<VARIABLE>,
 * each optional. The bounds and defaults are Identity's own
 * (services/identity-api/src/config/environment.ts); the three QoreID lookup
 * limits are also the bounds of 0085's platform.consume_public_patient_nin_quota.
 * A test holds both in step. An input left out is not emitted, so Identity
 * runs its default; QOREID_TIMEOUT_MS is always emitted, 5000 unless set.
 */
export const identityBudgetInputs = {
  // Public NIN lookups a day, platform-wide; the owner sets it from the QoreID contract.
  PATIENT_ENROLLMENT_QOREID_DAILY_CAP: { min: 1, max: 100_000, default: 200 },
  // Public NIN lookups per client network (an IPv4 address or an IPv6 /64).
  PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX: { min: 1, max: 100, default: 5 },
  PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX: { min: 1, max: 1_000, default: 15 },
  // Enrollment starts per client network within OTP_RATE_WINDOW_SECONDS.
  PATIENT_ENROLLMENT_START_RATE_MAX_REQUESTS: { min: 1, max: 100, default: 5 },
  // In-person checks of the facility route over 24 hours (ADR-063).
  ASSISTED_VERIFICATION_STAFF_DAILY_MAX: { min: 1, max: 200, default: 20 },
  ASSISTED_VERIFICATION_FACILITY_DAILY_MAX: { min: 1, max: 1_000, default: 100 },
  QOREID_TIMEOUT_MS: { min: 250, max: 10_000, default: 5_000 },
} as const;
export type IdentityBudgetVariable = keyof typeof identityBudgetInputs;
export const identityBudgetVariables = Object.keys(identityBudgetInputs) as IdentityBudgetVariable[];

/** The patient record release categories, one flag each. */
export interface PatientRecordRelease {
  readonly vitals: boolean;
  readonly diagnoses: boolean;
  readonly prescriptions: boolean;
  readonly labResults: boolean;
  readonly documents: boolean;
}

/** The imported legacy medical history switches (ADR-067). */
export interface ImportedHistory {
  readonly patientRead: boolean;
  readonly staffRead: boolean;
  readonly sharing: boolean;
}

/** Synth inputs beyond the environment, staging mode, QoreID and route switches. */
export interface SynthOptions {
  readonly importedHistoryPatientRead?: string;
  readonly importedHistoryStaffRead?: string;
  readonly importedHistorySharing?: string;
  readonly patientReleaseVitals?: string;
  readonly patientReleaseDiagnoses?: string;
  readonly patientReleasePrescriptions?: string;
  readonly patientReleaseLabResults?: string;
  readonly patientReleaseDocuments?: string;
  readonly qoreIdNinOnlyEnrollmentEnabled?: string;
  readonly ninHolderSmsEnabled?: string;
  readonly assistedRegistrationEnabled?: string;
  readonly qoreIdPatientSelfNinBindingEnabled?: string;
  readonly notificationWorkerEnabled?: string;
  readonly novuSubscriberSyncEnabled?: string;
  readonly operationalAlarmTopicArn?: string;
  // HID_<VARIABLE> for each identityBudgetInputs entry, as supplied.
  readonly identityBudgets?: Readonly<Record<string, string | undefined>>;
}

interface ProfileValues {
  readonly profile: DeploymentProfile;
  readonly availabilityZones: number;
  readonly natGateways: number;
  readonly interfaceEndpoints: readonly InterfaceEndpointName[];
  readonly interfaceEndpointAzCount: number;
  readonly runtimeIngressEnabled: boolean;
  readonly autoscalingEnabled: boolean;
  readonly databaseInstanceType: InstanceType;
  readonly databaseInstanceClass: string;
  readonly databaseAllocatedStorageGiB: number;
  readonly databaseMaxStorageGiB: number;
  readonly databaseMultiAz: boolean;
  readonly databaseDeletionProtection: boolean;
  readonly databaseBackupRetention: Duration;
  readonly databaseConnectionBudget: number;
  readonly reviewedEmergencyConnectionBudget: number;
  readonly logRetention: RetentionDays;
  readonly removalPolicy: RemovalPolicy;
  readonly repositoryImageCount: number;
}

const profiles: Record<DeploymentProfile, ProfileValues> = {
  development: {
    profile: 'development', availabilityZones: 2, natGateways: 1,
    interfaceEndpoints: fullInterfaceEndpoints, interfaceEndpointAzCount: 2,
    runtimeIngressEnabled: true, autoscalingEnabled: true,
    databaseInstanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.SMALL),
    databaseInstanceClass: 'db.t4g.small', databaseAllocatedStorageGiB: 50,
    databaseMaxStorageGiB: 100, databaseMultiAz: false, databaseDeletionProtection: false,
    databaseBackupRetention: Duration.days(7), databaseConnectionBudget: 120,
    reviewedEmergencyConnectionBudget: 180, logRetention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY, repositoryImageCount: 25,
  },
  sleep: {
    profile: 'sleep', availabilityZones: 2, natGateways: 0,
    interfaceEndpoints: [], interfaceEndpointAzCount: 0,
    runtimeIngressEnabled: false, autoscalingEnabled: false,
    databaseInstanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.SMALL),
    databaseInstanceClass: 'db.t4g.small', databaseAllocatedStorageGiB: 100,
    databaseMaxStorageGiB: 300, databaseMultiAz: false, databaseDeletionProtection: true,
    databaseBackupRetention: Duration.days(14), databaseConnectionBudget: 0,
    reviewedEmergencyConnectionBudget: 0, logRetention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.RETAIN, repositoryImageCount: 25,
  },
  economy: {
    profile: 'economy', availabilityZones: 2, natGateways: 1,
    interfaceEndpoints: ['ecr-api', 'ecr-docker', 'logs', 'secrets-manager', 'eventbridge', 'sqs', 'textract'],
    interfaceEndpointAzCount: 1, runtimeIngressEnabled: true, autoscalingEnabled: true,
    databaseInstanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.SMALL),
    databaseInstanceClass: 'db.t4g.small', databaseAllocatedStorageGiB: 100,
    databaseMaxStorageGiB: 300, databaseMultiAz: false, databaseDeletionProtection: true,
    databaseBackupRetention: Duration.days(14), databaseConnectionBudget: 120,
    reviewedEmergencyConnectionBudget: 180, logRetention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.RETAIN, repositoryImageCount: 25,
  },
  fidelity: {
    profile: 'fidelity', availabilityZones: 2, natGateways: 2,
    interfaceEndpoints: fullInterfaceEndpoints, interfaceEndpointAzCount: 2,
    runtimeIngressEnabled: true, autoscalingEnabled: true,
    databaseInstanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
    databaseInstanceClass: 'db.t4g.medium', databaseAllocatedStorageGiB: 100,
    databaseMaxStorageGiB: 300, databaseMultiAz: true, databaseDeletionProtection: true,
    databaseBackupRetention: Duration.days(14), databaseConnectionBudget: 200,
    reviewedEmergencyConnectionBudget: 400, logRetention: RetentionDays.THREE_MONTHS,
    removalPolicy: RemovalPolicy.RETAIN, repositoryImageCount: 50,
  },
  production: {
    profile: 'production', availabilityZones: 3, natGateways: 2,
    interfaceEndpoints: fullInterfaceEndpoints, interfaceEndpointAzCount: 3,
    runtimeIngressEnabled: true, autoscalingEnabled: true,
    databaseInstanceType: InstanceType.of(InstanceClass.R6G, InstanceSize.LARGE),
    databaseInstanceClass: 'db.r6g.large', databaseAllocatedStorageGiB: 200,
    databaseMaxStorageGiB: 1_000, databaseMultiAz: true, databaseDeletionProtection: true,
    databaseBackupRetention: Duration.days(35), databaseConnectionBudget: 400,
    reviewedEmergencyConnectionBudget: 650, logRetention: RetentionDays.ONE_YEAR,
    removalPolicy: RemovalPolicy.RETAIN, repositoryImageCount: 100,
  },
};

const environmentIdentity: Record<EnvironmentName, Pick<HidEnvironmentConfig,
  'name' | 'publicApiSubdomain' | 'browserSubdomains' | 'originAuthorizationSecretParameter' | 'vpcCidr'>> = {
  development: {
    name: 'development', publicApiSubdomain: 'api.development',
    browserSubdomains: ['development', 'ehr.development', 'lab.development', 'pharmacy.development',
      'migrate.development', 'outreach.development', 'admin.development'],
    originAuthorizationSecretParameter: 'DevelopmentCloudflareOriginSecret', vpcCidr: '10.20.0.0/16',
  },
  staging: {
    name: 'staging', publicApiSubdomain: 'api.staging',
    browserSubdomains: ['staging', 'ehr.staging', 'lab.staging', 'pharmacy.staging',
      'migrate.staging', 'outreach.staging', 'admin.staging'],
    originAuthorizationSecretParameter: 'StagingCloudflareOriginSecret', vpcCidr: '10.30.0.0/16',
  },
  production: {
    name: 'production', publicApiSubdomain: 'api',
    browserSubdomains: ['www', 'ehr', 'lab', 'pharmacy', 'migrate', 'outreach', 'admin'],
    originAuthorizationSecretParameter: 'ProductionCloudflareOriginSecret', vpcCidr: '10.40.0.0/16',
  },
};

/**
 * Parses the synth input HID_ENABLED_API_ROUTES: a comma-separated list of
 * exact module names that always includes identity and ehr. Production may
 * not route a module outside the launch set; enabling one there needs its own
 * decision and a change to this rule.
 */
export function enabledApiRoutes(name: EnvironmentName, value: string | undefined): readonly ApiRouteModule[] {
  if (value === undefined) return launchApiRoutes;
  const entries = value.split(',').map((entry) => entry.trim());
  const unknown = entries.filter((entry) => !(apiRouteModules as readonly string[]).includes(entry));
  if (unknown.length > 0) {
    throw new Error(`HID_ENABLED_API_ROUTES must name only ${apiRouteModules.join(', ')}; received ${JSON.stringify(value)}`);
  }
  if (new Set(entries).size !== entries.length) {
    throw new Error(`HID_ENABLED_API_ROUTES must name each module once; received ${JSON.stringify(value)}`);
  }
  for (const required of launchApiRoutes) {
    if (!entries.includes(required)) throw new Error(`HID_ENABLED_API_ROUTES must include ${required}`);
  }
  const selected = apiRouteModules.filter((module) => entries.includes(module));
  if (name === 'production' && selected.some((module) => !launchApiRoutes.includes(module))) {
    throw new Error(`HID_ENABLED_API_ROUTES in production is fixed to ${launchApiRoutes.join(',')} (the launch module set); `
      + 'enabling another module needs its own decision, its fixes and a staging acceptance run');
  }
  return selected;
}

/** The operator-created alarm topic of an environment (D4, ADR-053). */
export function operationalAlarmTopicName(name: EnvironmentName): string {
  return `hid-${name}-operational-alerts`;
}

const operationalAlarmTopicPattern = /^arn:(aws|aws-cn|aws-us-gov):sns:([a-z]{2}(?:-gov)?-[a-z]+-[0-9]):([0-9]{12}):([a-z-]+)$/;

export interface OperationalAlarmTopic {
  readonly arn: string;
  readonly partition: string;
  readonly region: string;
  readonly account: string;
}

/**
 * Parses the synth input HID_OPERATIONAL_ALARM_TOPIC_ARN: the exact ARN of
 * this environment's topic hid-<env>-operational-alerts, named literally (no
 * wildcard, token or surrounding text). Absent input returns undefined; the
 * regional stack decides whether that is allowed.
 */
export function operationalAlarmTopic(name: EnvironmentName, value: string | undefined): OperationalAlarmTopic | undefined {
  if (value === undefined) return undefined;
  const match = operationalAlarmTopicPattern.exec(value);
  if (!match || match[4] !== operationalAlarmTopicName(name)) {
    throw new Error(`HID_OPERATIONAL_ALARM_TOPIC_ARN must be the exact ARN of the operator-created SNS topic `
      + `${operationalAlarmTopicName(name)} in this environment's account and region; received ${JSON.stringify(value)}`);
  }
  return { arn: value, partition: match[1]!, region: match[2]!, account: match[3]! };
}

const routeGatedWorkloads: Readonly<Record<string, ApiRouteModule>> = {
  'lab-api': 'lab', 'pharmacy-api': 'pharmacy', 'ocr-api': 'ocr', 'ocr-worker': 'ocr', 'outreach-api': 'outreach',
};

/**
 * Whether a workload belongs to an enabled module. A disabled module's tasks
 * stay at zero, do not autoscale and raise no alarm (D17, MOD-1).
 */
export function workloadEnabled(configuration: Pick<HidEnvironmentConfig, 'enabledApiRoutes' | 'notificationWorkerEnabled'>,
  name: string): boolean {
  if (name === 'notification-worker') return configuration.notificationWorkerEnabled;
  const routeModule = routeGatedWorkloads[name];
  return routeModule === undefined || configuration.enabledApiRoutes.includes(routeModule);
}

/**
 * CFG-PROD, N1, ADR-062: a NIN lookup proves that a NIN exists, not that the
 * person holds it. NIN-only enrollment needs a route to prove that (the
 * activation command requires the proof); staging sends no SMS; production
 * runs the online route only with the facility route (0094, ADR-063), the
 * remedy when someone who knows a NIN closes its online route and the only
 * route for a person without a usable registry phone. The signed-in NIN
 * binding has no holder proof and stays off in production. The regional stack repeats this for a configuration
 * not built by environmentConfig.
 */
export function assertNinOwnershipRoutes(configuration: {
  readonly name: EnvironmentName; readonly qoreIdNinOnlyEnrollmentEnabled: boolean;
  readonly ninHolderSmsEnabled: boolean; readonly assistedRegistrationEnabled: boolean;
  readonly qoreIdPatientSelfNinBindingEnabled: boolean;
}): void {
  if (configuration.qoreIdNinOnlyEnrollmentEnabled
    && !configuration.ninHolderSmsEnabled && !configuration.assistedRegistrationEnabled) {
    throw new Error('HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED=true requires HID_NIN_HOLDER_SMS_ENABLED=true or '
      + 'HID_ASSISTED_REGISTRATION_ENABLED=true (ADR-062)');
  }
  if (configuration.name === 'staging' && configuration.ninHolderSmsEnabled) {
    throw new Error('HID_NIN_HOLDER_SMS_ENABLED=true is refused on staging: its notification-api sends email only');
  }
  if (configuration.name === 'production' && configuration.ninHolderSmsEnabled
    && !configuration.assistedRegistrationEnabled) {
    throw new Error('HID_NIN_HOLDER_SMS_ENABLED=true needs HID_ASSISTED_REGISTRATION_ENABLED=true in production '
      + '(ADR-062, ADR-063)');
  }
  if (configuration.name === 'production' && configuration.qoreIdPatientSelfNinBindingEnabled) {
    throw new Error('HID_QOREID_PATIENT_SELF_NIN_BINDING_ENABLED=true is refused in production until the owner '
      + 'decides whether N1 covers the signed-in NIN binding');
  }
}

/**
 * Refuses an Identity budget that Identity (or 0085's quota command) would
 * refuse at start: out of bounds, not a whole number, an hourly NIN lookup
 * limit above the daily one, or a facility in-person budget below the staff
 * one. A value left out counts as Identity's default. The regional stack
 * repeats this for a configuration not built by environmentConfig.
 */
export function assertIdentityBudgets(values: Readonly<Partial<Record<IdentityBudgetVariable, number>>>): void {
  for (const [name, value] of Object.entries(values) as Array<[string, number | undefined]>) {
    if (!(name in identityBudgetInputs)) throw new Error(`${name} is not an Identity budget synth input`);
    const { min, max } = identityBudgetInputs[name as IdentityBudgetVariable];
    if (value === undefined || !Number.isSafeInteger(value) || value < min || value > max) {
      throw new Error(`HID_${name} must be a whole number from ${min} to ${max}; received ${JSON.stringify(value)}`);
    }
  }
  const effective = (name: IdentityBudgetVariable) => values[name] ?? identityBudgetInputs[name].default;
  const described = (name: IdentityBudgetVariable) => values[name] === undefined
    ? `${effective(name)}, Identity's default` : String(effective(name));
  if (effective('PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX') > effective('PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX')) {
    throw new Error(`HID_PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX (${described('PATIENT_ENROLLMENT_QOREID_NETWORK_HOURLY_MAX')}) `
      + `cannot exceed HID_PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX (${described('PATIENT_ENROLLMENT_QOREID_NETWORK_DAILY_MAX')})`);
  }
  if (effective('ASSISTED_VERIFICATION_FACILITY_DAILY_MAX') < effective('ASSISTED_VERIFICATION_STAFF_DAILY_MAX')) {
    throw new Error(`HID_ASSISTED_VERIFICATION_FACILITY_DAILY_MAX (${described('ASSISTED_VERIFICATION_FACILITY_DAILY_MAX')}) `
      + `cannot be below HID_ASSISTED_VERIFICATION_STAFF_DAILY_MAX (${described('ASSISTED_VERIFICATION_STAFF_DAILY_MAX')})`);
  }
}

/**
 * Parses the optional synth inputs HID_<VARIABLE> of identityBudgetInputs:
 * plain decimal digits with no sign, space or leading zero. Returns only the
 * supplied ones.
 */
export function identityBudgets(values: Readonly<Record<string, string | undefined>> = {}):
  Readonly<Partial<Record<IdentityBudgetVariable, number>>> {
  const parsed: Partial<Record<IdentityBudgetVariable, number>> = {};
  for (const [name, value] of Object.entries(values)) {
    if (!(name in identityBudgetInputs)) throw new Error(`${name} is not an Identity budget synth input`);
    if (value === undefined) continue;
    const { min, max } = identityBudgetInputs[name as IdentityBudgetVariable];
    if (!/^[1-9][0-9]{0,8}$/.test(value)) {
      throw new Error(`HID_${name} must be a whole number from ${min} to ${max}; received ${JSON.stringify(value)}`);
    }
    parsed[name as IdentityBudgetVariable] = Number(value);
  }
  assertIdentityBudgets(parsed);
  return parsed;
}

const PATIENT_RELEASE_INPUTS: ReadonlyArray<readonly [keyof PatientRecordRelease, string, string]> = [
  ['vitals', 'HID_EHR_PATIENT_RELEASE_VITALS', 'the clinical owner has not signed off the category (P36, ADR-065)'],
  ['diagnoses', 'HID_EHR_PATIENT_RELEASE_DIAGNOSES', 'the clinical owner has not signed off the category (P36, ADR-065)'],
  ['prescriptions', 'HID_EHR_PATIENT_RELEASE_PRESCRIPTIONS',
    'the clinical owner has not signed off the category (P36, ADR-065)'],
  ['labResults', 'HID_EHR_PATIENT_RELEASE_LAB_RESULTS', 'Lab is off at launch (D17)'],
  ['documents', 'HID_EHR_PATIENT_RELEASE_DOCUMENTS', 'the clinical owner has not signed off the category (P36, ADR-065)'],
];

/**
 * Only staging may release a patient record category. Production refuses
 * Lab results while Lab is not routed and every Lab permission is withdrawn
 * (D17, 0091 section 2), and every other category until the clinical owner
 * signs it off (release checklist P36, ADR-065); a reviewed change that
 * records the sign-off lifts one refusal. The development stack runs ehr-api
 * in the production profile (HID_DEPLOYMENT_ENV=production), where ehr-api
 * refuses every flag at start, so it is refused here as well. The regional
 * stack repeats this for a configuration not built by environmentConfig.
 */
export function assertPatientRecordRelease(configuration: {
  readonly name: EnvironmentName; readonly patientRecordRelease: PatientRecordRelease;
}): void {
  if (configuration.name === 'staging') return;
  for (const [category, variable, reason] of PATIENT_RELEASE_INPUTS) {
    if (configuration.patientRecordRelease[category]) {
      throw new Error(`${variable}=true is refused outside staging (${configuration.name}): ${reason}`);
    }
  }
}

const IMPORTED_HISTORY_INPUTS: ReadonlyArray<readonly [keyof ImportedHistory, string]> = [
  ['patientRead', 'HID_EHR_PATIENT_RELEASE_IMPORTED_HISTORY'],
  ['staffRead', 'HID_EHR_STAFF_IMPORTED_HISTORY_ENABLED'],
  ['sharing', 'HID_IMPORTED_HISTORY_SHARING_ENABLED'],
];

/**
 * Only staging may show imported legacy medical history (ADR-067), and there
 * the staff read needs the sharing route and the sharing route the patient's
 * own read. Production
 * refuses each switch until the DPO and the owner sign off the legacy data's
 * provenance, scope and retention and Health-id renders it (release checklist
 * P38); the development stack runs its services in the production profile,
 * where ehr-api and identity-api refuse them at start, so it is refused here
 * as well. The regional stack repeats this for a configuration not built by
 * environmentConfig.
 */
export function assertImportedHistory(configuration: {
  readonly name: EnvironmentName; readonly importedHistory: ImportedHistory;
}): void {
  if (configuration.name !== 'staging') {
    for (const [flag, variable] of IMPORTED_HISTORY_INPUTS) {
      if (configuration.importedHistory[flag]) {
        throw new Error(`${variable}=true is refused outside staging (${configuration.name}): the DPO and the owner `
          + 'have not signed off the legacy data (P38, ADR-067)');
      }
    }
  }
  // A patient shares only what they can see themselves, and staff read only
  // while patients can choose and withdraw through the sharing route: the
  // switches go on patient read first and off staff read first (ADR-067).
  const { patientRead, staffRead, sharing } = configuration.importedHistory;
  if (sharing && !patientRead) {
    throw new Error('HID_IMPORTED_HISTORY_SHARING_ENABLED=true needs HID_EHR_PATIENT_RELEASE_IMPORTED_HISTORY=true: '
      + 'a patient may share only the imported history they can see (ADR-067)');
  }
  if (staffRead && !sharing) {
    throw new Error('HID_EHR_STAFF_IMPORTED_HISTORY_ENABLED=true needs HID_IMPORTED_HISTORY_SHARING_ENABLED=true: '
      + 'staff read imported history only while patients can choose and withdraw (ADR-067)');
  }
}

function booleanInput(variable: string, value: string | undefined, fallback: 'true' | 'false'): boolean {
  const input = value ?? fallback;
  if (!['true', 'false'].includes(input)) throw new Error(`${variable} must be true or false when supplied`);
  return input === 'true';
}

/** The Amazon-provided DNS server of an IPv4 VPC: the CIDR's base address plus two. */
export function vpcDnsResolver(vpcCidr: string): string {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(vpcCidr);
  if (!match) throw new Error(`VPC CIDR must be IPv4; received ${vpcCidr}`);
  const octets = match.slice(1, 5).map(Number);
  const prefix = Number(match[5]);
  if (octets.some((octet) => octet > 255) || prefix < 16 || prefix > 28) {
    throw new Error(`VPC CIDR is not a valid VPC range; received ${vpcCidr}`);
  }
  const address = octets.reduce((total, octet) => total * 256 + octet, 0);
  const base = address - (address % 2 ** (32 - prefix));
  const resolver = base + 2;
  return [24, 16, 8, 0].map((shift) => Math.floor(resolver / 2 ** shift) % 256).join('.');
}

export function environmentConfig(
  value: string | undefined,
  stagingModeValue?: string,
  qoreIdEnabledValue?: string,
  enabledApiRoutesValue?: string,
  options: SynthOptions = {},
): HidEnvironmentConfig {
  const selected = value ?? 'development';
  if (!environmentNames.includes(selected as EnvironmentName)) {
    throw new Error(`HID_INFRA_ENV must be one of ${environmentNames.join(', ')}; received ${selected}`);
  }
  const name = selected as EnvironmentName;
  let profile: DeploymentProfile = name === 'staging' ? 'sleep' : name;
  let stagingMode: StagingMode | undefined;
  if (name === 'staging') {
    if (!stagingModes.includes(stagingModeValue as StagingMode)) {
      throw new Error(`HID_STAGING_MODE must be one of ${stagingModes.join(', ')} for staging; received ${stagingModeValue ?? 'unset'}`);
    }
    stagingMode = stagingModeValue as StagingMode;
    profile = stagingMode;
  } else if (stagingModeValue) {
    throw new Error('HID_STAGING_MODE is valid only when HID_INFRA_ENV=staging');
  }
  const qoreIdEnabled = booleanInput('HID_QOREID_ENABLED', qoreIdEnabledValue, 'false');
  const qoreIdNinOnlyEnrollmentEnabled = booleanInput('HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED',
    options.qoreIdNinOnlyEnrollmentEnabled, 'false');
  if (qoreIdNinOnlyEnrollmentEnabled && !qoreIdEnabled) {
    throw new Error('HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED=true requires HID_QOREID_ENABLED=true');
  }
  const ninHolderSmsEnabled = booleanInput('HID_NIN_HOLDER_SMS_ENABLED', options.ninHolderSmsEnabled, 'false');
  const assistedRegistrationEnabled = booleanInput('HID_ASSISTED_REGISTRATION_ENABLED',
    options.assistedRegistrationEnabled, 'false');
  const qoreIdPatientSelfNinBindingEnabled = booleanInput('HID_QOREID_PATIENT_SELF_NIN_BINDING_ENABLED',
    options.qoreIdPatientSelfNinBindingEnabled, 'false');
  assertNinOwnershipRoutes({ name, qoreIdNinOnlyEnrollmentEnabled, ninHolderSmsEnabled,
    assistedRegistrationEnabled, qoreIdPatientSelfNinBindingEnabled });
  const notificationWorkerEnabled = booleanInput('HID_NOTIFICATION_WORKER_ENABLED', options.notificationWorkerEnabled,
    name === 'production' ? 'false' : 'true');
  if (name === 'production' && notificationWorkerEnabled) {
    throw new Error('HID_NOTIFICATION_WORKER_ENABLED is fixed to false in production (the launch module set, D17): '
      + 'the notification worker needs an approved Novu account and region and its own decision');
  }
  const novuSubscriberSyncEnabled = booleanInput('HID_NOVU_SUBSCRIBER_SYNC_ENABLED', options.novuSubscriberSyncEnabled,
    'false');
  if (novuSubscriberSyncEnabled && name !== 'staging') {
    throw new Error('HID_NOVU_SUBSCRIBER_SYNC_ENABLED may be true only in staging (ADR-064): production refuses Novu '
      + 'subscriber email sync until its approvals are recorded, and the worker refuses it outside staging');
  }
  if (novuSubscriberSyncEnabled && !notificationWorkerEnabled) {
    throw new Error('HID_NOVU_SUBSCRIBER_SYNC_ENABLED=true requires HID_NOTIFICATION_WORKER_ENABLED=true');
  }
  const patientRecordRelease: PatientRecordRelease = {
    vitals: booleanInput('HID_EHR_PATIENT_RELEASE_VITALS', options.patientReleaseVitals, 'false'),
    diagnoses: booleanInput('HID_EHR_PATIENT_RELEASE_DIAGNOSES', options.patientReleaseDiagnoses, 'false'),
    prescriptions: booleanInput('HID_EHR_PATIENT_RELEASE_PRESCRIPTIONS', options.patientReleasePrescriptions, 'false'),
    labResults: booleanInput('HID_EHR_PATIENT_RELEASE_LAB_RESULTS', options.patientReleaseLabResults, 'false'),
    documents: booleanInput('HID_EHR_PATIENT_RELEASE_DOCUMENTS', options.patientReleaseDocuments, 'false'),
  };
  assertPatientRecordRelease({ name, patientRecordRelease });
  const importedHistory: ImportedHistory = {
    patientRead: booleanInput('HID_EHR_PATIENT_RELEASE_IMPORTED_HISTORY', options.importedHistoryPatientRead, 'false'),
    staffRead: booleanInput('HID_EHR_STAFF_IMPORTED_HISTORY_ENABLED', options.importedHistoryStaffRead, 'false'),
    sharing: booleanInput('HID_IMPORTED_HISTORY_SHARING_ENABLED', options.importedHistorySharing, 'false'),
  };
  assertImportedHistory({ name, importedHistory });
  const topic = operationalAlarmTopic(name, options.operationalAlarmTopicArn);
  const budgets = identityBudgets(options.identityBudgets);
  return {
    ...environmentIdentity[name], ...profiles[profile],
    ...(stagingMode ? { stagingMode } : {}),
    qoreIdEnabled,
    enabledApiRoutes: enabledApiRoutes(name, enabledApiRoutesValue),
    qoreIdNinOnlyEnrollmentEnabled,
    ninHolderSmsEnabled,
    assistedRegistrationEnabled,
    qoreIdPatientSelfNinBindingEnabled,
    notificationWorkerEnabled,
    novuSubscriberSyncEnabled,
    patientRecordRelease,
    importedHistory,
    ...(topic ? { operationalAlarmTopicArn: topic.arn } : {}),
    identityBudgets: budgets,
  };
}

export function externalAwsEnvironment(account: string | undefined, region: string | undefined) {
  if (Boolean(account) !== Boolean(region)) {
    throw new Error('HID_AWS_ACCOUNT and HID_AWS_REGION must be supplied together or both omitted');
  }
  return account && region ? { account, region } : undefined;
}
