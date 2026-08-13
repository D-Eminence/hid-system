import type { HidEnvironmentConfig } from './config.js';
import { workloadNames, workloads, workloadScale } from './workloads.js';

export interface CostInventory {
  readonly environment: string;
  readonly profile: string;
  readonly availabilityZones: number;
  readonly natGateways: number;
  readonly interfaceEndpointAzAttachments: number;
  readonly publicAlbs: number;
  readonly internalAlbs: number;
  readonly estimatedPublicIpv4Count: number;
  readonly ecsTasks: Readonly<Record<string, {
    readonly cloudFormationDefault: number;
    readonly minimumLive: number;
    readonly recommended: number;
    readonly normalMax: number;
    readonly reviewedEmergencyMax: number;
  }>>;
  readonly rds: Readonly<Record<string, string | number | boolean>>;
  readonly logRetentionDays: number;
  readonly ecrImagesPerRepository: number;
  readonly kmsKeys: number;
  readonly secretInterfaces: number;
  readonly wafs: number;
  readonly sqsQueuesAndDlqs: number;
  readonly s3Buckets: number;
}

export function costInventory(configuration: HidEnvironmentConfig): CostInventory {
  const ingress = configuration.runtimeIngressEnabled;
  return {
    environment: configuration.name,
    profile: configuration.profile,
    availabilityZones: configuration.availabilityZones,
    natGateways: configuration.natGateways,
    interfaceEndpointAzAttachments: configuration.interfaceEndpoints.length
      * configuration.interfaceEndpointAzCount,
    publicAlbs: ingress ? 1 : 0,
    internalAlbs: ingress ? 1 : 0,
    estimatedPublicIpv4Count: ingress
      ? configuration.natGateways + configuration.availabilityZones : 0,
    ecsTasks: Object.fromEntries(workloadNames.map((name) => {
      const scale = workloadScale(configuration.profile, name);
      return [name, { cloudFormationDefault: scale.recommendedTasks, minimumLive: scale.minimumLiveTasks,
        recommended: scale.recommendedTasks, normalMax: scale.normalMaxTasks,
        reviewedEmergencyMax: scale.reviewedEmergencyMaxTasks }];
    })),
    rds: {
      instanceClass: configuration.databaseInstanceClass,
      multiAz: configuration.databaseMultiAz,
      allocatedStorageGiB: configuration.databaseAllocatedStorageGiB,
      maxStorageGiB: configuration.databaseMaxStorageGiB,
      backupRetentionDays: configuration.databaseBackupRetention.toDays(),
      deletionProtection: configuration.databaseDeletionProtection,
      expectedComputeState: configuration.profile === 'sleep' ? 'stopped-by-operation' : 'available',
    },
    logRetentionDays: Number(configuration.logRetention),
    ecrImagesPerRepository: configuration.repositoryImageCount,
    kmsKeys: 3,
    secretInterfaces: workloadNames.filter((name) => workloads[name].hasDatabase).length + 5,
    wafs: ingress ? 1 : 0,
    sqsQueuesAndDlqs: 2,
    s3Buckets: 1,
  };
}
