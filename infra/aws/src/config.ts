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
    interfaceEndpoints: ['secrets-manager', 'eventbridge', 'sqs', 'textract'],
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
      'ocr.development', 'outreach.development', 'admin.development'],
    originAuthorizationSecretParameter: 'DevelopmentCloudflareOriginSecret', vpcCidr: '10.20.0.0/16',
  },
  staging: {
    name: 'staging', publicApiSubdomain: 'api.staging',
    browserSubdomains: ['staging', 'ehr.staging', 'lab.staging', 'pharmacy.staging',
      'ocr.staging', 'outreach.staging', 'admin.staging'],
    originAuthorizationSecretParameter: 'StagingCloudflareOriginSecret', vpcCidr: '10.30.0.0/16',
  },
  production: {
    name: 'production', publicApiSubdomain: 'api',
    browserSubdomains: ['www', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin'],
    originAuthorizationSecretParameter: 'ProductionCloudflareOriginSecret', vpcCidr: '10.40.0.0/16',
  },
};

export function environmentConfig(
  value: string | undefined,
  stagingModeValue?: string,
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
  return { ...environmentIdentity[name], ...profiles[profile], ...(stagingMode ? { stagingMode } : {}) };
}

export function externalAwsEnvironment(account: string | undefined, region: string | undefined) {
  if (Boolean(account) !== Boolean(region)) {
    throw new Error('HID_AWS_ACCOUNT and HID_AWS_REGION must be supplied together or both omitted');
  }
  return account && region ? { account, region } : undefined;
}
