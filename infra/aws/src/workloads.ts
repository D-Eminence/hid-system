export const tokenRoot = '/var/run/hid/workload-tokens';

export const workloadNames = [
  'identity-api',
  'ehr-api',
  'lab-api',
  'pharmacy-api',
  'ocr-api',
  'ocr-worker',
  'outreach-api',
  'notification-api',
  'notification-worker',
  'event-dispatcher',
  'gateway',
] as const;

export type WorkloadName = typeof workloadNames[number];

export interface WorkloadDefinition {
  readonly name: WorkloadName;
  readonly repository: string;
  readonly port?: number;
  readonly healthPath?: string;
  readonly cpu: number;
  readonly memoryMiB: number;
  readonly browserRouted: boolean;
  readonly hasDatabase: boolean;
  readonly tokenFiles: Readonly<Record<string, string>>;
}

export const workloads: Record<WorkloadName, WorkloadDefinition> = {
  'identity-api': {
    name: 'identity-api', repository: 'identity-api', port: 3001,
    healthPath: '/api/v1/health/ready', cpu: 512, memoryMiB: 1_024,
    browserRouted: true, hasDatabase: true,
    tokenFiles: { NOTIFICATION_IDENTITY_WORKLOAD_TOKEN_FILE: `${tokenRoot}/notification.jwt` },
  },
  'ehr-api': {
    name: 'ehr-api', repository: 'ehr-api', port: 3002,
    healthPath: '/api/v1/health/ready', cpu: 1_024, memoryMiB: 2_048,
    browserRouted: true, hasDatabase: true,
    tokenFiles: {
      IDENTITY_EHR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/identity.jwt`,
      LAB_EHR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/lab.jwt`,
      PHARMACY_EHR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/pharmacy.jwt`,
    },
  },
  'lab-api': {
    name: 'lab-api', repository: 'lab-api', port: 3003,
    healthPath: '/api/v1/health/ready', cpu: 512, memoryMiB: 1_024,
    browserRouted: true, hasDatabase: true,
    tokenFiles: { IDENTITY_LAB_WORKLOAD_TOKEN_FILE: `${tokenRoot}/identity.jwt` },
  },
  'pharmacy-api': {
    name: 'pharmacy-api', repository: 'pharmacy-api', port: 3004,
    healthPath: '/api/v1/health/ready', cpu: 512, memoryMiB: 1_024,
    browserRouted: true, hasDatabase: true,
    tokenFiles: { IDENTITY_PHARMACY_WORKLOAD_TOKEN_FILE: `${tokenRoot}/identity.jwt` },
  },
  'ocr-api': {
    name: 'ocr-api', repository: 'ocr-api', port: 3005,
    healthPath: '/api/v1/health/ready', cpu: 512, memoryMiB: 1_024,
    browserRouted: true, hasDatabase: true,
    tokenFiles: {
      IDENTITY_OCR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/identity.jwt`,
      EHR_OCR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/ehr.jwt`,
      LAB_OCR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/lab.jwt`,
      PHARMACY_OCR_WORKLOAD_TOKEN_FILE: `${tokenRoot}/pharmacy.jwt`,
    },
  },
  'ocr-worker': {
    name: 'ocr-worker', repository: 'ocr-worker', cpu: 1_024, memoryMiB: 2_048,
    browserRouted: false, hasDatabase: true, tokenFiles: {},
  },
  'outreach-api': {
    name: 'outreach-api', repository: 'outreach-api', port: 3006,
    healthPath: '/api/v1/health/ready', cpu: 512, memoryMiB: 1_024,
    browserRouted: true, hasDatabase: true,
    tokenFiles: { OUTREACH_IDENTITY_WORKLOAD_TOKEN_FILE: `${tokenRoot}/identity.jwt` },
  },
  'notification-api': {
    name: 'notification-api', repository: 'notification-api', port: 3007,
    healthPath: '/api/v1/health/ready', cpu: 512, memoryMiB: 1_024,
    browserRouted: false, hasDatabase: false, tokenFiles: {},
  },
  'notification-worker': {
    name: 'notification-worker', repository: 'notification-worker', port: 3008,
    healthPath: '/api/v1/health/ready', cpu: 512, memoryMiB: 1_024,
    browserRouted: false, hasDatabase: true, tokenFiles: {},
  },
  'event-dispatcher': {
    name: 'event-dispatcher', repository: 'event-dispatcher', port: 3010,
    healthPath: '/api/v1/health/ready', cpu: 512, memoryMiB: 1_024,
    browserRouted: false, hasDatabase: true, tokenFiles: {},
  },
  gateway: {
    name: 'gateway', repository: 'gateway', port: 3000,
    healthPath: '/gateway-health/ready', cpu: 512, memoryMiB: 1_024,
    browserRouted: true, hasDatabase: false, tokenFiles: {},
  },
};

export const browserPaths = ['/', '/ehr/', '/lab/', '/pharmacy/', '/ocr/', '/outreach/', '/admin/'] as const;

export const serviceHostLabels: Partial<Record<WorkloadName, string>> = {
  'identity-api': 'identity',
  'ehr-api': 'ehr',
  'lab-api': 'lab',
  'pharmacy-api': 'pharmacy',
  'ocr-api': 'ocr',
  'outreach-api': 'outreach',
  'event-dispatcher': 'dispatcher',
  'notification-api': 'notification',
  'notification-worker': 'notification-worker',
};
