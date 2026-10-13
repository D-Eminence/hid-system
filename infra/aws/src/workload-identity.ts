import { Aws, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import type { WorkloadName } from './workloads.js';

/**
 * Environments with an in-stack issuer (ADR-047). Development keeps the
 * external issuer, JWKS and subject inputs.
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
  /**
   * IPv4 /32 addresses through which every caller of the issuer leaves the
   * VPC (its NAT gateway Elastic IPs). When given, a REGIONAL web ACL on the
   * stage blocks every other source (D3). Omitted only where no NAT gateway
   * and no running task exist (staging sleep).
   */
  readonly allowedSourceAddresses?: readonly string[];
}

// Per-method limits (DEP-4-DOS). POST /token: at production normal maximum the
// six token services renew 74 caller/audience pairs every 90 s (148 at the
// reviewed emergency maximum), about 15 requests per second at worst on the
// 10 s retry cadence. The JWKS limit is never below it. Each method has its
// own bucket, so a flood of one cannot throttle the other.
const tokenThrottle = { throttlingRateLimit: 30, throttlingBurstLimit: 60 } as const;
const jwksThrottle = { throttlingRateLimit: 30, throttlingBurstLimit: 60 } as const;
const methodDefaults = { dataTraceEnabled: false, loggingLevel: apigateway.MethodLoggingLevel.OFF, metricsEnabled: true } as const;

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
    // DEP-4-KEY (D1): the default root statement stays, so the account keeps
    // key administration and the key can never be locked out. These Deny
    // statements override any IAM grant: only the issuer role may sign, and
    // only ES256 over a RAW message, as index.mjs does. An account
    // administrator can still change this policy or the function; that
    // same-account custody risk is accepted in ADR-047.
    const issuerRole = this.issuer.role!;
    for (const [sid, condition] of [
      ['DenySigningFromEveryOtherPrincipal', { ArnNotEquals: { 'aws:PrincipalArn': issuerRole.roleArn } }],
      ['DenyEveryOtherSigningAlgorithm', { StringNotEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256' } }],
      ['DenyEveryOtherMessageType', { StringNotEquals: { 'kms:MessageType': 'RAW' } }],
    ] as const) {
      key.addToResourcePolicy(new iam.PolicyStatement({
        sid, effect: iam.Effect.DENY, principals: [new iam.AnyPrincipal()], actions: ['kms:Sign'], resources: ['*'],
        conditions: condition,
      }));
    }
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: `hid-${environment}-workload-identity`,
      description: `IAM-bound short-lived ${environment} workload tokens and public verification keys`,
      endpointTypes: [apigateway.EndpointType.REGIONAL], cloudWatchRole: false,
      // No stage-wide ('/*/*') setting: each method carries its own logging
      // and throttle settings.
      deployOptions: {
        stageName: environment,
        methodOptions: {
          '/token/POST': { ...methodDefaults, ...tokenThrottle },
          '/.well-known/jwks.json/GET': { ...methodDefaults, ...jwksThrottle },
        },
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
    if (props.allowedSourceAddresses) this.allowOnly(environment, props.allowedSourceAddresses);
    this.createAlarms(environment);
    new CfnOutput(this, 'IssuerUrl', { value: this.issuerUrl });
    new CfnOutput(this, 'JwksUrl', { value: this.jwksUrl });
  }

  /**
   * D3: deny by default at the edge. Every agent and receiver reaches the
   * issuer through the VPC's NAT gateways (there is no execute-api endpoint),
   * so the stage accepts only those addresses. WAF matches the connection
   * source, never a forwarded header.
   */
  private allowOnly(environment: WorkloadIssuerEnvironment, addresses: readonly string[]): void {
    if (addresses.length === 0) throw new Error('A workload issuer allowlist needs at least one NAT address');
    const allowlist = new wafv2.CfnIPSet(this, 'IssuerAllowlist', {
      scope: 'REGIONAL', ipAddressVersion: 'IPV4', addresses: [...addresses],
      description: `NAT gateway addresses of the ${environment} VPC, the only callers of its workload issuer`,
    });
    const acl = new wafv2.CfnWebACL(this, 'IssuerWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { block: {} },
      description: `Blocks every source except the ${environment} VPC NAT gateways`,
      visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `hid-${environment}-workload-issuer`,
        sampledRequestsEnabled: false },
      rules: [{
        name: 'AllowVpcNatEgress', priority: 0, action: { allow: {} },
        statement: { ipSetReferenceStatement: { arn: allowlist.attrArn } },
        visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: `hid-${environment}-workload-issuer-nat`,
          sampledRequestsEnabled: false },
      }],
    });
    new wafv2.CfnWebACLAssociation(this, 'IssuerWebAclAssociation', {
      resourceArn: this.api.deploymentStage.stageArn, webAclArn: acl.attrArn,
    });
  }

  /**
   * D4: the issuer's own failure signals. The regional stack routes every
   * alarm, these included, to the operational topic in production. REST API
   * Gateway publishes no separate 429 metric: a throttled request counts in
   * 4XXError, as do IAM refusals and, while it reaches the stage, a flood.
   */
  private createAlarms(environment: WorkloadIssuerEnvironment): void {
    const period = Duration.minutes(5);
    const stage = this.api.deploymentStage;
    const alarms: Array<[string, string, cloudwatch.IMetric, number]> = [
      ['IssuerErrorsAlarm', 'The workload issuer Lambda is failing; token renewal fails closed once tokens expire',
        this.issuer.metricErrors({ period, statistic: 'Sum' }), 1],
      ['IssuerThrottlesAlarm', 'The workload issuer Lambda is throttled (reserved concurrency or account limit)',
        this.issuer.metricThrottles({ period, statistic: 'Sum' }), 1],
      ['IssuerApi5xxAlarm', `The ${environment} workload issuer stage returns 5XX`,
        stage.metricServerError({ period, statistic: 'Sum' }), 1],
      ['IssuerApi4xxAlarm', `The ${environment} workload issuer stage returns 4XX: throttled (429) or refused requests`,
        stage.metricClientError({ period, statistic: 'Sum' }), 20],
    ];
    for (const [id, alarmDescription, metric, threshold] of alarms) {
      new cloudwatch.Alarm(this, id, {
        alarmDescription, metric, threshold,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
    }
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
