#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { environmentConfig, externalAwsEnvironment } from '../src/config.js';
import { HidRegionalStack } from '../src/hid-regional-stack.js';
import { HidCostGovernanceStack } from '../src/cost-governance-stack.js';

const application = new App();
const configuration = environmentConfig(process.env.HID_INFRA_ENV, process.env.HID_STAGING_MODE);
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
