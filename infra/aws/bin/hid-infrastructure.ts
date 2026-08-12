#!/usr/bin/env node
import { App } from 'aws-cdk-lib';
import { environmentConfig, externalAwsEnvironment } from '../src/config.js';
import { HidRegionalStack } from '../src/hid-regional-stack.js';

const application = new App();
const configuration = environmentConfig(process.env.HID_INFRA_ENV);
const regionalEnvironment = externalAwsEnvironment(process.env.HID_AWS_ACCOUNT, process.env.HID_AWS_REGION);

new HidRegionalStack(application, `Hid-${configuration.name}-Regional`, {
  configuration,
  ...(regionalEnvironment ? { env: regionalEnvironment } : {}),
  description: `HID ${configuration.name} private data and independently deployable ECS/Fargate runtimes`,
});

application.synth();
