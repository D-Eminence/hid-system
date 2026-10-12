import { Aws, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import type { WorkloadName } from './workloads.js';

/**
 * Environments with an in-stack issuer. Development keeps the external issuer,
 * JWKS and subject inputs. Production is proposed in ADR-047 and is not
 * accepted until that decision is made.
 */
export type WorkloadIssuerEnvironment = 'staging' | 'production';

const labels: Readonly<Record<WorkloadIssuerEnvironment, string>> = { staging: 'Staging', production: 'Production' };

/** The issuer environment for a deployment, or undefined when it keeps the external contract. */
export function workloadIssuerEnvironment(name: string): WorkloadIssuerEnvironment | undefined {
  return Object.hasOwn(labels, name) ? name as WorkloadIssuerEnvironment : undefined;
}

/** The construct ID; staging keeps its original ID so its retained key's logical ID never changes. */
export function workloadIdentityConstructId(environment: WorkloadIssuerEnvironment): string {
  return `${labels[environment]}WorkloadIdentity`;
}

export interface WorkloadCaller {
  readonly role: iam.IRole;
  readonly subject: string;
  readonly audiences: readonly string[];
}

export interface WorkloadIdentityProps {
  readonly environment: WorkloadIssuerEnvironment;
  readonly logRetention: logs.RetentionDays;
}

/**
 * IAM-authenticated issuer bound to one environment: its own key, API, stage
 * and `hid:<environment>:<service>` subjects. Task roles never receive signing
 * authority.
 */
export class WorkloadIdentity extends Construct {
  readonly environment: WorkloadIssuerEnvironment;
  readonly issuerUrl: string;
  readonly jwksUrl: string;
  private readonly api: apigateway.RestApi;
  private readonly issuer: lambda.Function;

  constructor(scope: Construct, id: string, props: WorkloadIdentityProps) {
    super(scope, id);
    const environment = workloadIssuerEnvironment(props.environment);
    if (!environment) throw new Error('A workload issuer exists only for staging or production');
    this.environment = environment;
    const label = labels[environment];
    const key = new kms.Key(this, 'SigningKey', {
      alias: `alias/hid-${environment}-workload-signing`,
      description: `${label} workload identity ES256 signer; distinct from release signing custody`,
      keySpec: kms.KeySpec.ECC_NIST_P256, keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const logGroup = new logs.LogGroup(this, 'IssuerLogs', {
      logGroupName: `/hid/${environment}/workload-issuer`, retention: props.logRetention,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.issuer = new lambda.Function(this, 'Issuer', {
      functionName: `hid-${environment}-workload-issuer`, runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, handler: 'index.handler',
      code: lambda.Code.fromAsset(fileURLToPath(new URL('../runtime/workload-issuer', import.meta.url))),
      timeout: Duration.seconds(10), memorySize: 256, logGroup,
      environment: { HID_DEPLOYMENT_ENV: environment, WORKLOAD_SIGNING_KEY_ID: key.keyArn },
    });
    this.issuer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Sign'], resources: [key.keyArn],
      conditions: { StringEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256' } },
    }));
    this.issuer.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:GetPublicKey'], resources: [key.keyArn] }));
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `hid-${environment}-workload-identity`,
      description: `IAM-bound short-lived ${environment} workload tokens and public verification keys`,
      endpointTypes: [apigateway.EndpointType.REGIONAL], cloudWatchRole: false,
      deployOptions: {
        stageName: environment, dataTraceEnabled: false, loggingLevel: apigateway.MethodLoggingLevel.OFF,
        throttlingRateLimit: 30, throttlingBurstLimit: 60, metricsEnabled: true,
      },
    });
    const integration = new apigateway.LambdaIntegration(this.issuer, { proxy: true, allowTestInvoke: false });
    this.api.root.addResource('token').addMethod('POST', integration, { authorizationType: apigateway.AuthorizationType.IAM });
    this.api.root.addResource('.well-known').addResource('jwks.json').addMethod('GET', integration,
      { authorizationType: apigateway.AuthorizationType.NONE });
    // Use explicit stage text to avoid Lambda -> deployment -> Lambda cycles.
    this.issuerUrl = `https://${this.api.restApiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}/${environment}`;
    this.jwksUrl = `${this.issuerUrl}/.well-known/jwks.json`;
    this.issuer.addEnvironment('WORKLOAD_ISSUER_URL', this.issuerUrl);
    this.issuer.addEnvironment('WORKLOAD_API_ID', this.api.restApiId);
    new CfnOutput(this, 'IssuerUrl', { value: this.issuerUrl });
    new CfnOutput(this, 'JwksUrl', { value: this.jwksUrl });
  }

  /** The exact JWT subject of a caller in this environment. */
  subject(name: WorkloadName): string {
    return `hid:${this.environment}:${name}`;
  }

  bindCallers(callers: readonly WorkloadCaller[]): void {
    if (callers.length !== 6 || new Set(callers.map(caller => caller.subject)).size !== callers.length
      || callers.some(caller => !caller.subject.startsWith(`hid:${this.environment}:`))) {
      throw new Error(`Exactly six distinct ${this.environment} workload subjects are required`);
    }
    this.issuer.addEnvironment('WORKLOAD_CALLER_POLICY_JSON', Stack.of(this).toJsonString(callers.map(caller => ({
      roleArn: caller.role.roleArn, subject: caller.subject, audiences: caller.audiences,
    }))));
    for (const caller of callers) caller.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['execute-api:Invoke'], resources: [this.api.arnForExecuteApi('POST', '/token', this.environment)],
    }));
  }
}
