import { Aws, CfnOutput, Duration, RemovalPolicy, Stack } from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';

export interface StagingWorkloadCaller {
  readonly role: iam.IRole;
  readonly subject: string;
  readonly audiences: readonly string[];
}

/** Staging-only IAM-authenticated issuer. Task roles never receive signing authority. */
export class StagingWorkloadIdentity extends Construct {
  readonly issuerUrl: string;
  readonly jwksUrl: string;
  private readonly api: apigateway.RestApi;
  private readonly issuer: lambda.Function;

  constructor(scope: Construct, id: string) {
    super(scope, id);
    const key = new kms.Key(this, 'SigningKey', {
      alias: 'alias/hid-staging-workload-signing',
      description: 'Staging workload identity ES256 signer; distinct from release signing custody',
      keySpec: kms.KeySpec.ECC_NIST_P256, keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const logGroup = new logs.LogGroup(this, 'IssuerLogs', {
      logGroupName: '/hid/staging/workload-issuer', retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    this.issuer = new lambda.Function(this, 'Issuer', {
      functionName: 'hid-staging-workload-issuer', runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64, handler: 'index.handler',
      code: lambda.Code.fromAsset(fileURLToPath(new URL('../runtime/workload-issuer', import.meta.url))),
      timeout: Duration.seconds(10), memorySize: 256, logGroup,
      environment: { HID_DEPLOYMENT_ENV: 'staging', WORKLOAD_SIGNING_KEY_ID: key.keyArn },
    });
    this.issuer.addToRolePolicy(new iam.PolicyStatement({
      actions: ['kms:Sign'], resources: [key.keyArn],
      conditions: { StringEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256' } },
    }));
    this.issuer.addToRolePolicy(new iam.PolicyStatement({ actions: ['kms:GetPublicKey'], resources: [key.keyArn] }));
    this.api = new apigateway.RestApi(this, 'Api', {
      restApiName: 'hid-staging-workload-identity',
      description: 'IAM-bound short-lived staging workload tokens and public verification keys',
      endpointTypes: [apigateway.EndpointType.REGIONAL], cloudWatchRole: false,
      deployOptions: {
        stageName: 'staging', dataTraceEnabled: false, loggingLevel: apigateway.MethodLoggingLevel.OFF,
        throttlingRateLimit: 30, throttlingBurstLimit: 60, metricsEnabled: true,
      },
    });
    const integration = new apigateway.LambdaIntegration(this.issuer, { proxy: true, allowTestInvoke: false });
    this.api.root.addResource('token').addMethod('POST', integration, { authorizationType: apigateway.AuthorizationType.IAM });
    this.api.root.addResource('.well-known').addResource('jwks.json').addMethod('GET', integration,
      { authorizationType: apigateway.AuthorizationType.NONE });
    // Use explicit stage text to avoid Lambda -> deployment -> Lambda cycles.
    this.issuerUrl = `https://${this.api.restApiId}.execute-api.${Aws.REGION}.${Aws.URL_SUFFIX}/staging`;
    this.jwksUrl = `${this.issuerUrl}/.well-known/jwks.json`;
    this.issuer.addEnvironment('WORKLOAD_ISSUER_URL', this.issuerUrl);
    this.issuer.addEnvironment('WORKLOAD_API_ID', this.api.restApiId);
    new CfnOutput(this, 'IssuerUrl', { value: this.issuerUrl });
    new CfnOutput(this, 'JwksUrl', { value: this.jwksUrl });
  }

  bindCallers(callers: readonly StagingWorkloadCaller[]): void {
    if (callers.length !== 6 || new Set(callers.map(caller => caller.subject)).size !== callers.length) {
      throw new Error('Exactly six distinct staging workload subjects are required');
    }
    this.issuer.addEnvironment('WORKLOAD_CALLER_POLICY_JSON', Stack.of(this).toJsonString(callers.map(caller => ({
      roleArn: caller.role.roleArn, subject: caller.subject, audiences: caller.audiences,
    }))));
    for (const caller of callers) caller.role.addToPrincipalPolicy(new iam.PolicyStatement({
      actions: ['execute-api:Invoke'], resources: [this.api.arnForExecuteApi('POST', '/token', 'staging')],
    }));
  }
}
