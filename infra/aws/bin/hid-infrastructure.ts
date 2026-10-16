#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { environmentConfig, externalAwsEnvironment } from '../src/config.js';
import { HidRegionalStack } from '../src/hid-regional-stack.js';
import { HidCostGovernanceStack } from '../src/cost-governance-stack.js';

const application = new App();
const configuration = environmentConfig(
  process.env.HID_INFRA_ENV,
  process.env.HID_STAGING_MODE,
  process.env.HID_QOREID_ENABLED,
  process.env.HID_ENABLED_API_ROUTES,
  {
    qoreIdNinOnlyEnrollmentEnabled: process.env.HID_QOREID_NIN_ONLY_ENROLLMENT_ENABLED,
    ninHolderSmsEnabled: process.env.HID_NIN_HOLDER_SMS_ENABLED,
    assistedRegistrationEnabled: process.env.HID_ASSISTED_REGISTRATION_ENABLED,
    qoreIdPatientSelfNinBindingEnabled: process.env.HID_QOREID_PATIENT_SELF_NIN_BINDING_ENABLED,
    notificationWorkerEnabled: process.env.HID_NOTIFICATION_WORKER_ENABLED,
    novuSubscriberSyncEnabled: process.env.HID_NOVU_SUBSCRIBER_SYNC_ENABLED,
    operationalAlarmTopicArn: process.env.HID_OPERATIONAL_ALARM_TOPIC_ARN,
    patientReleaseVitals: process.env.HID_EHR_PATIENT_RELEASE_VITALS,
    patientReleaseDiagnoses: process.env.HID_EHR_PATIENT_RELEASE_DIAGNOSES,
    patientReleasePrescriptions: process.env.HID_EHR_PATIENT_RELEASE_PRESCRIPTIONS,
    patientReleaseLabResults: process.env.HID_EHR_PATIENT_RELEASE_LAB_RESULTS,
    patientReleaseDocuments: process.env.HID_EHR_PATIENT_RELEASE_DOCUMENTS,
    importedHistoryPatientRead: process.env.HID_EHR_PATIENT_RELEASE_IMPORTED_HISTORY,
    importedHistoryStaffRead: process.env.HID_EHR_STAFF_IMPORTED_HISTORY_ENABLED,
    importedHistorySharing: process.env.HID_IMPORTED_HISTORY_SHARING_ENABLED,
  },
);
const regionalEnvironment = externalAwsEnvironment(process.env.HID_AWS_ACCOUNT, process.env.HID_AWS_REGION);

new HidRegionalStack(application, `Hid-${configuration.name}-Regional`, {
  configuration,
  ...(regionalEnvironment ? { env: regionalEnvironment } : {}),
  description: `HID ${configuration.name} private data and independently deployable ECS/Fargate runtimes`,
});

const costGovernanceEnabled = process.env.HID_COST_GOVERNANCE_ENABLED ?? 'false';
if (!['true', 'false'].includes(costGovernanceEnabled)) {
  throw new Error('HID_COST_GOVERNANCE_ENABLED must be true or false');
}
if (costGovernanceEnabled === 'true') {
  new HidCostGovernanceStack(application, 'Hid-Cost-Governance', {
    ...(regionalEnvironment ? { env: regionalEnvironment } : {}),
    description: 'Optional HID account billing alerts and cost anomaly detection; contains no actions',
  });
}

application.synth();
