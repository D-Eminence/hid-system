import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export const environmentNames = ['development', 'staging', 'production'] as const;
export type EnvironmentName = typeof environmentNames[number];

export interface HidEnvironmentConfig {
  readonly name: EnvironmentName;
  readonly publicApiSubdomain: string;
  readonly browserSubdomains: readonly string[];
  readonly originAuthorizationSecretParameter: string;
  readonly vpcCidr: string;
  readonly availabilityZones: number;
  readonly natGateways: number;
  readonly apiDesiredCount: number;
  readonly workerDesiredCount: number;
  readonly gatewayDesiredCount: number;
  readonly maxApiTasks: number;
  readonly databaseInstanceType: InstanceType;
  readonly databaseAllocatedStorageGiB: number;
  readonly databaseMaxStorageGiB: number;
  readonly databaseMultiAz: boolean;
  readonly databaseDeletionProtection: boolean;
  readonly databaseBackupRetention: Duration;
  readonly logRetention: RetentionDays;
  readonly removalPolicy: RemovalPolicy;
  readonly repositoryImageCount: number;
}

const configurations: Record<EnvironmentName, HidEnvironmentConfig> = {
  development: {
    name: 'development',
    publicApiSubdomain: 'api.development',
    browserSubdomains: ['development', 'ehr.development', 'lab.development', 'pharmacy.development', 'ocr.development', 'outreach.development', 'admin.development'],
    originAuthorizationSecretParameter: 'DevelopmentCloudflareOriginSecret',
    vpcCidr: '10.20.0.0/16',
    availabilityZones: 2,
    natGateways: 1,
    apiDesiredCount: 1,
    workerDesiredCount: 1,
    gatewayDesiredCount: 1,
    maxApiTasks: 2,
    databaseInstanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.SMALL),
    databaseAllocatedStorageGiB: 50,
    databaseMaxStorageGiB: 100,
    databaseMultiAz: false,
    databaseDeletionProtection: false,
    databaseBackupRetention: Duration.days(7),
    logRetention: RetentionDays.ONE_MONTH,
    removalPolicy: RemovalPolicy.DESTROY,
    repositoryImageCount: 25,
  },
  staging: {
    name: 'staging',
    publicApiSubdomain: 'api.staging',
    browserSubdomains: ['staging', 'ehr.staging', 'lab.staging', 'pharmacy.staging', 'ocr.staging', 'outreach.staging', 'admin.staging'],
    originAuthorizationSecretParameter: 'StagingCloudflareOriginSecret',
    vpcCidr: '10.30.0.0/16',
    availabilityZones: 2,
    natGateways: 2,
    apiDesiredCount: 2,
    workerDesiredCount: 1,
    gatewayDesiredCount: 2,
    maxApiTasks: 4,
    databaseInstanceType: InstanceType.of(InstanceClass.T4G, InstanceSize.MEDIUM),
    databaseAllocatedStorageGiB: 100,
    databaseMaxStorageGiB: 300,
    databaseMultiAz: true,
    databaseDeletionProtection: false,
    databaseBackupRetention: Duration.days(14),
    logRetention: RetentionDays.THREE_MONTHS,
    removalPolicy: RemovalPolicy.RETAIN,
    repositoryImageCount: 50,
  },
  production: {
    name: 'production',
    publicApiSubdomain: 'api',
    browserSubdomains: ['www', 'ehr', 'lab', 'pharmacy', 'ocr', 'outreach', 'admin'],
    originAuthorizationSecretParameter: 'ProductionCloudflareOriginSecret',
    vpcCidr: '10.40.0.0/16',
    availabilityZones: 3,
    natGateways: 2,
    apiDesiredCount: 2,
    workerDesiredCount: 2,
    gatewayDesiredCount: 2,
    maxApiTasks: 8,
    databaseInstanceType: InstanceType.of(InstanceClass.R6G, InstanceSize.LARGE),
    databaseAllocatedStorageGiB: 200,
    databaseMaxStorageGiB: 1_000,
    databaseMultiAz: true,
    databaseDeletionProtection: true,
    databaseBackupRetention: Duration.days(35),
    logRetention: RetentionDays.ONE_YEAR,
    removalPolicy: RemovalPolicy.RETAIN,
    repositoryImageCount: 100,
  },
};

export function environmentConfig(value: string | undefined): HidEnvironmentConfig {
  const selected = value ?? 'development';
  if (!environmentNames.includes(selected as EnvironmentName)) {
    throw new Error(`HID_INFRA_ENV must be one of ${environmentNames.join(', ')}; received ${selected}`);
  }
  return configurations[selected as EnvironmentName];
}

export function externalAwsEnvironment(account: string | undefined, region: string | undefined) {
  if (Boolean(account) !== Boolean(region)) {
    throw new Error('HID_AWS_ACCOUNT and HID_AWS_REGION must be supplied together or both omitted');
  }
  return account && region ? { account, region } : undefined;
}
