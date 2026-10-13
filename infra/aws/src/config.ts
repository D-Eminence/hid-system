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
  const qoreIdEnabledInput = qoreIdEnabledValue ?? 'false';
  if (!['true', 'false'].includes(qoreIdEnabledInput)) {
    throw new Error('HID_QOREID_ENABLED must be true or false when supplied');
  }
  return {
    ...environmentIdentity[name], ...profiles[profile],
    ...(stagingMode ? { stagingMode } : {}),
    qoreIdEnabled: qoreIdEnabledInput === 'true',
    enabledApiRoutes: enabledApiRoutes(name, enabledApiRoutesValue),
  };
}

export function externalAwsEnvironment(account: string | undefined, region: string | undefined) {
  if (Boolean(account) !== Boolean(region)) {
    throw new Error('HID_AWS_ACCOUNT and HID_AWS_REGION must be supplied together or both omitted');
  }
  return account && region ? { account, region } : undefined;
}
