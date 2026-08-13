import type { DeploymentProfile } from './config.js';

export const tokenRoot = '/var/run/hid/workload-tokens';

export const workloadNames = [
  'identity-api', 'ehr-api', 'lab-api', 'pharmacy-api', 'ocr-api', 'ocr-worker',
  'outreach-api', 'notification-api', 'notification-worker', 'event-dispatcher', 'gateway',
] as const;

export type WorkloadName = typeof workloadNames[number];
export type ScalingKind = 'request' | 'notification-queue' | 'ocr-backlog' | 'outbox-backlog';

export interface WorkloadScale {
  readonly minimumLiveTasks: number;
  readonly recommendedTasks: number;
  readonly normalMaxTasks: number;
  readonly reviewedEmergencyMaxTasks: number;
}

export interface WorkloadDefinition {
  readonly name: WorkloadName;
  readonly repository: string;
  readonly port?: number;
  readonly healthPath?: string;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly browserRouted: boolean;
  readonly hasDatabase: boolean;
  readonly databaseConnectionsPerTask: number;
  readonly scalingKind: ScalingKind;
  readonly cpuTargetPercent: number;
  readonly memoryTargetPercent: number;
  readonly requestTargetPerMinute?: number;
  readonly scaleInCooldownSeconds: number;
  readonly scaleOutCooldownSeconds: number;
  readonly tokenFiles: Readonly<Record<string, string>>;
}

const definitions: Record<WorkloadName, WorkloadDefinition> = {
  'identity-api': request('identity-api', 3001, 512, 1_024, 6,
    { NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE: `${tokenRoot}/notification.jwt` }, 600),
  'ehr-api': request('ehr-api', 3002, 1_024, 2_048, 11, {
    IDENTITY_EHR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/identity.jwt`,
    LAB_EHR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/lab.jwt`,
    PHARMACY_EHR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/pharmacy.jwt`,
  }, 400),
  'lab-api': request('lab-api', 3003, 512, 1_024, 5,
    { IDENTITY_LAB_WORKLOAD_TOKEN_FILE: `${tokenRoot}/identity.jwt` }, 300),
  'pharmacy-api': request('pharmacy-api', 3004, 512, 1_024, 5,
    { IDENTITY_PHARMACY_WORKLOAD_TOKEN_FILE: `${tokenRoot}/identity.jwt` }, 300),
  'ocr-api': request('ocr-api', 3005, 512, 1_024, 5, {
    IDENTITY_OCR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/identity.jwt`,
    EHR_OCR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/ehr.jwt`,
    LAB_OCR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/lab.jwt`,
    PHARMACY_OCR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/pharmacy.jwt`,
  }, 240),
  'ocr-worker': worker('ocr-worker', 1_024, 2_048, 4, 'ocr-backlog'),
  'outreach-api': request('outreach-api', 3006, 512, 1_024, 5,
    { OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE: `${tokenRoot}/identity.jwt` }, 300),
  'notification-api': request('notification-api', 3007, 512, 1_024, 0, {}, 300, false),
  'notification-worker': {
    ...worker('notification-worker', 512, 1_024, 4, 'notification-queue'),
    port: 3008, healthPath: '/api/v1/health/ready',
  },
  'event-dispatcher': {
    ...worker('event-dispatcher', 512, 1_024, 4, 'outbox-backlog'),
    port: 3010, healthPath: '/api/v1/health/ready',
  },
  gateway: request('gateway', 3000, 512, 1_024, 0, {}, 1_000),
};

export const workloads: Readonly<Record<WorkloadName, WorkloadDefinition>> = definitions;

const requestNormalMax: Record<WorkloadName, number> = {
  'identity-api': 8, 'ehr-api': 8, 'lab-api': 6, 'pharmacy-api': 6, 'ocr-api': 6,
  'ocr-worker': 4, 'outreach-api': 6, 'notification-api': 6, 'notification-worker': 4,
  'event-dispatcher': 6, gateway: 12,
};

export function workloadScale(profile: DeploymentProfile, name: WorkloadName): WorkloadScale {
  if (profile === 'sleep') {
    return { minimumLiveTasks: 0, recommendedTasks: 0, normalMaxTasks: 0, reviewedEmergencyMaxTasks: 0 };
  }
  const workerLike = definitions[name].scalingKind !== 'request';
  if (profile === 'economy' || profile === 'development') {
    const recommendedTasks = workerLike ? 0 : 1;
    return { minimumLiveTasks: workerLike ? 0 : 1, recommendedTasks,
      normalMaxTasks: 2, reviewedEmergencyMaxTasks: 3 };
  }
  if (profile === 'fidelity') {
    const recommendedTasks = workerLike ? 1 : 2;
    const normalMaxTasks = workerLike ? 3 : 4;
    return { minimumLiveTasks: workerLike ? 1 : 2, recommendedTasks,
      normalMaxTasks, reviewedEmergencyMaxTasks: normalMaxTasks * 2 };
  }
  const normalMaxTasks = requestNormalMax[name];
  return { minimumLiveTasks: 2, recommendedTasks: 2, normalMaxTasks,
    reviewedEmergencyMaxTasks: normalMaxTasks * 2 };
}

export function databaseConnectionDemand(profile: DeploymentProfile, emergency = false): number {
  return workloadNames.reduce((total, name) => {
    const scale = workloadScale(profile, name);
    return total + definitions[name].databaseConnectionsPerTask
      * (emergency ? scale.reviewedEmergencyMaxTasks : scale.normalMaxTasks);
  }, 0);
}

export function validateDatabaseConnectionBudget(
  profile: DeploymentProfile,
  normalBudget: number,
  reviewedEmergencyBudget: number,
): void {
  const normal = databaseConnectionDemand(profile);
  if (normal > normalBudget) {
    throw new Error(`${profile} normal scaling requires ${normal} database connections but budget is ${normalBudget}`);
  }
  const emergency = databaseConnectionDemand(profile, true);
  if (emergency > reviewedEmergencyBudget) {
    throw new Error(`${profile} reviewed-emergency scaling requires ${emergency} database connections but budget is ${reviewedEmergencyBudget}`);
  }
}

export const browserPaths = ['/', '/ehr/', '/lab/', '/pharmacy/', '/ocr/', '/outreach/', '/admin/'] as const;

export const serviceHostLabels: Partial<Record<WorkloadName, string>> = {
  'identity-api': 'identity', 'ehr-api': 'ehr', 'lab-api': 'lab', 'pharmacy-api': 'pharmacy',
  'ocr-api': 'ocr', 'outreach-api': 'outreach', 'event-dispatcher': 'dispatcher',
  'notification-api': 'notification', 'notification-worker': 'notification-worker',
};

function request(name: WorkloadName, port: number, cpu: number, memoryMiB: number,
  databaseConnectionsPerTask: number, tokenFiles: Readonly<Record<string, string>>,
  requestTargetPerMinute: number, browserRouted = true): WorkloadDefinition {
  return { name, repository: name, port, healthPath: name === 'gateway'
    ? '/gateway-health/ready' : '/api/v1/health/ready', cpu, memoryMiB, browserRouted,
  hasDatabase: databaseConnectionsPerTask > 0, databaseConnectionsPerTask, scalingKind: 'request',
  cpuTargetPercent: 65, memoryTargetPercent: 75, requestTargetPerMinute,
  scaleInCooldownSeconds: 300, scaleOutCooldownSeconds: 60, tokenFiles };
}

function worker(name: WorkloadName, cpu: number, memoryMiB: number,
  databaseConnectionsPerTask: number, scalingKind: Exclude<ScalingKind, 'request'>): WorkloadDefinition {
  return { name, repository: name, cpu, memoryMiB, browserRouted: false, hasDatabase: true,
    databaseConnectionsPerTask, scalingKind, cpuTargetPercent: 70, memoryTargetPercent: 80,
    scaleInCooldownSeconds: 600, scaleOutCooldownSeconds: 60, tokenFiles: {} };
}
