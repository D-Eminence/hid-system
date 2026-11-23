import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export const environmentNames = ['development', 'staging', 'production'] as const;
export type EnvironmentName = typeof environmentNames[number];

export const stagingModes = ['sleep', 'economy', 'fidelity'] as const;
export type StagingMode = typeof stagingModes[number];
export type DeploymentProfile = 'development' | StagingMode | 'production';

/** identity-api's STAFF_FACILITY_SELECTION_MODE (0129): off, keep or ask. */
export const staffFacilitySelectionModes = ['off', 'keep', 'ask'] as const;
export type StaffFacilitySelectionMode = typeof staffFacilitySelectionModes[number];

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
  // Off unless HID_OWN_WORK_PATIENT_CARD_ENABLED=true at synth time: lab-api and
  // pharmacy-api then add the patient's details to this facility's own work (0124).
  readonly ownWorkPatientCardEnabled: boolean;
  // Off unless HID_PRESCRIPTION_DISPENSING_DETAILS_ENABLED=true at synth time:
  // ehr-api then takes a prescription's dispensing details and pharmacy-api adds
  // them to own work (0125). Switch it on only after 0125 is applied.
  readonly prescriptionDispensingDetailsEnabled: boolean;
  // Off unless HID_STAFF_FACILITY_SELECTION_MODE is keep or ask at synth time:
  // identity-api then keeps a staff member's chosen facility per sign-in
  // (0129). Synthesize keep or ask only once 0129 is applied: identity-api
  // refuses to start while its table or grants are missing, and the deploy
  // rolls back. To roll back the feature, synthesize off again.
  readonly staffFacilitySelectionMode: StaffFacilitySelectionMode;
  // Off unless HID_STAFF_OPEN_PATIENT_ENABLED=true at synth time: identity-api
  // then keeps the patient a staff sign-in has open across a reload (SX-8,
  // 0140). Synthesize true only once 0140 is applied: identity-api refuses to
  // start while its table or grants are missing, and the deploy rolls back. To
  // roll back the feature, synthesize false again.
  readonly staffOpenPatientEnabled: boolean;
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
 * The settings a configuration is chosen with, besides HID_INFRA_ENV, each
 * by name. They were positional arguments, so two settings of the same type
 * could be passed in each other's place, and each Release B setting would
 * have added a position (Ola's decision 8 on #258). Each value is the raw
 * string from the environment, checked below exactly as before; leaving one
 * out gives its default.
 */
export interface EnvironmentSettings {
  /** HID_STAGING_MODE: sleep, economy or fidelity. Required for staging, refused elsewhere. */
  stagingMode?: string | undefined;
  /** HID_QOREID_ENABLED: true or false (default false). */
  qoreIdEnabled?: string | undefined;
  /** HID_OWN_WORK_PATIENT_CARD_ENABLED: true or false (default false). */
  ownWorkPatientCardEnabled?: string | undefined;
  /** HID_PRESCRIPTION_DISPENSING_DETAILS_ENABLED: true or false (default false). */
  prescriptionDispensingDetailsEnabled?: string | undefined;
  /** HID_STAFF_FACILITY_SELECTION_MODE: off, keep or ask (default off). */
  staffFacilitySelectionMode?: string | undefined;
  /** HID_STAFF_OPEN_PATIENT_ENABLED: true or false (default false). SX-8, Release B. */
  staffOpenPatientEnabled?: string | undefined;
}

/**
 * Each setting's environment variable: the one place a name is tied to a
 * setting. `satisfies` makes a setting without a variable a type error.
 */
export const environmentSettingVariables = {
  stagingMode: 'HID_STAGING_MODE',
  qoreIdEnabled: 'HID_QOREID_ENABLED',
  ownWorkPatientCardEnabled: 'HID_OWN_WORK_PATIENT_CARD_ENABLED',
  prescriptionDispensingDetailsEnabled: 'HID_PRESCRIPTION_DISPENSING_DETAILS_ENABLED',
  staffFacilitySelectionMode: 'HID_STAFF_FACILITY_SELECTION_MODE',
  staffOpenPatientEnabled: 'HID_STAFF_OPEN_PATIENT_ENABLED',
} as const satisfies Record<keyof EnvironmentSettings, string>;

type EnvironmentSettingName = keyof typeof environmentSettingVariables;
const environmentSettingNames = Object.keys(environmentSettingVariables) as EnvironmentSettingName[];

/** The settings read from an environment (process.env at synth time), by each setting's variable. */
export function environmentSettingsFrom(variables: Readonly<Record<string, string | undefined>>): EnvironmentSettings {
  const settings: EnvironmentSettings = {};
  for (const name of environmentSettingNames) {
    const value = variables[environmentSettingVariables[name]];
    if (value !== undefined) settings[name] = value;
  }
  return settings;
}

export function environmentConfig(
  value: string | undefined,
  settings: EnvironmentSettings = {},
): HidEnvironmentConfig {
  // A positional value from an unchecked JavaScript caller, or an unknown name
  // (a misspelt setting built outside an object literal, which TypeScript would
  // not catch), is refused rather than read as something else or ignored.
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('environmentConfig takes its settings by name, for example { stagingMode: \'economy\' }; '
      + `received ${Array.isArray(settings) ? 'an array' : typeof settings}`);
  }
  for (const name of Object.keys(settings)) {
    if (!(environmentSettingNames as string[]).includes(name)) {
      throw new Error(`Unknown environment setting ${name}; expected one of ${environmentSettingNames.join(', ')}`);
    }
  }
  const {
    stagingMode: stagingModeValue,
    qoreIdEnabled: qoreIdEnabledValue,
    ownWorkPatientCardEnabled: ownWorkPatientCardEnabledValue,
    prescriptionDispensingDetailsEnabled: prescriptionDispensingDetailsEnabledValue,
    staffFacilitySelectionMode: staffFacilitySelectionModeValue,
    staffOpenPatientEnabled: staffOpenPatientEnabledValue,
  } = settings;
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
  const qoreIdEnabledInput = qoreIdEnabledValue ?? 'false';
  if (!['true', 'false'].includes(qoreIdEnabledInput)) {
    throw new Error('HID_QOREID_ENABLED must be true or false when supplied');
  }
  const ownWorkPatientCardEnabledInput = ownWorkPatientCardEnabledValue ?? 'false';
  if (!['true', 'false'].includes(ownWorkPatientCardEnabledInput)) {
    throw new Error('HID_OWN_WORK_PATIENT_CARD_ENABLED must be true or false when supplied');
  }
  const prescriptionDispensingDetailsEnabledInput = prescriptionDispensingDetailsEnabledValue ?? 'false';
  if (!['true', 'false'].includes(prescriptionDispensingDetailsEnabledInput)) {
    throw new Error('HID_PRESCRIPTION_DISPENSING_DETAILS_ENABLED must be true or false when supplied');
  }
  const staffFacilitySelectionMode = staffFacilitySelectionModeValue ?? 'off';
  if (!(staffFacilitySelectionModes as readonly string[]).includes(staffFacilitySelectionMode)) {
    throw new Error('HID_STAFF_FACILITY_SELECTION_MODE must be off, keep or ask when supplied');
  }
  const staffOpenPatientEnabledInput = staffOpenPatientEnabledValue ?? 'false';
  if (!['true', 'false'].includes(staffOpenPatientEnabledInput)) {
    throw new Error('HID_STAFF_OPEN_PATIENT_ENABLED must be true or false when supplied');
  }
  return {
    ...environmentIdentity[name], ...profiles[profile],
    ...(stagingMode ? { stagingMode } : {}),
    qoreIdEnabled: qoreIdEnabledInput === 'true',
    ownWorkPatientCardEnabled: ownWorkPatientCardEnabledInput === 'true',
    prescriptionDispensingDetailsEnabled: prescriptionDispensingDetailsEnabledInput === 'true',
    staffFacilitySelectionMode: staffFacilitySelectionMode as StaffFacilitySelectionMode,
    staffOpenPatientEnabled: staffOpenPatientEnabledInput === 'true',
  };
}

export function externalAwsEnvironment(account: string | undefined, region: string | undefined) {
  if (Boolean(account) !== Boolean(region)) {
    throw new Error('HID_AWS_ACCOUNT and HID_AWS_REGION must be supplied together or both omitted');
  }
  return account && region ? { account, region } : undefined;
}
