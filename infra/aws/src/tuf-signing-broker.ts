import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  Token,
} from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import type * as s3 from 'aws-cdk-lib/aws-s3';
import type * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export const onlineSigningCandidateNames = [
  'snapshotOne',
  'snapshotTwo',
  'timestampOne',
  'timestampTwo',
] as const;

export type OnlineSigningCandidateName =
  (typeof onlineSigningCandidateNames)[number];
export type OnlineSigningRole = 'snapshot' | 'timestamp';
export type OnlineSigningCandidateOrdinal = 'one' | 'two';

/**
 * Ceremony-approved values required before any online signing endpoint exists.
 *
 * The bootstrap root is uploaded to the release-trust evidence bucket at
 * `tuf-signing-broker/bootstrap/<stateId>/root.json`. Its exact S3 version is
 * deliberately supplied only during a second, reviewed deployment after the
 * bucket, KMS candidates, and immutable root object already exist.
 */
export interface TufSigningBrokerConfig {
  /** Stable identifier embedded in and checked against every request. */
  readonly repositoryId: string;
  /** Stable DynamoDB partition and storage-prefix identifier. */
  readonly stateId: string;
  /** Lowercase content digest. Tags are intentionally unsupported. */
  readonly imageDigest: string;
  /** Fixed public TUF repository base URL consumed by the checkpoint canary. */
  readonly publicRepositoryUrl: string;
  /** SHA-256 of the exact trusted bootstrap root bytes. */
  readonly bootstrapRootSha256: string;
  /** Exact immutable S3 VersionId for the trusted bootstrap root object. */
  readonly bootstrapRootObjectVersionId: string;
  /** SHA-256 of each KMS candidate's DER SubjectPublicKeyInfo bytes. */
  readonly candidatePublicKeySpkiSha256: Readonly<
    Record<OnlineSigningCandidateName, string>
  >;
  /** Explicit ceremony/deployment acknowledgement; must be the literal true. */
  readonly acknowledgeCeremonyApprovedImmutablePins: true;
}

export interface ValidatedTufSigningBrokerConfig extends TufSigningBrokerConfig {
  readonly bootstrapRootObjectKey: string;
}

export interface TufSigningCandidateBinding {
  readonly name: OnlineSigningCandidateName;
  readonly role: OnlineSigningRole;
  readonly ordinal: OnlineSigningCandidateOrdinal;
  readonly signingKey: kms.Key;
  readonly requestSubmitterRole: iam.Role;
}

export interface TufSigningBrokerProps {
  readonly environmentName: 'staging' | 'production';
  readonly approvedAccount: string;
  readonly approvedRegion: string;
  readonly config: ValidatedTufSigningBrokerConfig;
  /** Stack-owned immutable repository whose resource policy Lambda can update. */
  readonly imageRepository: ecr.Repository;
  readonly evidenceBucket: s3.Bucket;
  readonly evidenceEncryptionKey: kms.Key;
  readonly evidenceObjectLockMode: 'GOVERNANCE' | 'COMPLIANCE';
  readonly evidenceRetentionDays: number;
  readonly auditTrail: cloudtrail.Trail;
  readonly auditLogGroup: logs.LogGroup;
  readonly alarmTopic: sns.ITopic;
  readonly publisherRole: iam.Role;
  readonly signingCandidates: readonly TufSigningCandidateBinding[];
}

const identifierPattern = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u;
const lowercaseSha256Pattern = /^[0-9a-f]{64}$/u;
const imageDigestPattern = /^sha256:[0-9a-f]{64}$/u;
const forbiddenLiteralCharacters = /[*?\s]/u;
const exactS3VersionIdPattern = /^[\x21-\x7e]+$/u;

function requireLiteral(name: string, value: string): void {
  if (Token.isUnresolved(value)) {
    throw new Error(`${name} must be a literal value reviewed in source`);
  }
}

export function validateTufSigningBrokerConfig(
  config: TufSigningBrokerConfig,
  environmentName: 'staging' | 'production',
): ValidatedTufSigningBrokerConfig {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('signingBroker must be a complete object when enabled');
  }

  for (const [name, value] of Object.entries({
    repositoryId: config.repositoryId,
    stateId: config.stateId,
    imageDigest: config.imageDigest,
    publicRepositoryUrl: config.publicRepositoryUrl,
    bootstrapRootSha256: config.bootstrapRootSha256,
    bootstrapRootObjectVersionId: config.bootstrapRootObjectVersionId,
  })) {
    if (typeof value !== 'string') {
      throw new Error(`signingBroker.${name} must be a string`);
    }
    requireLiteral(`signingBroker.${name}`, value);
  }

  if (!identifierPattern.test(config.repositoryId)) {
    throw new Error(
      'signingBroker.repositoryId must be an exact lowercase identifier of at most 64 characters',
    );
  }
  if (!identifierPattern.test(config.stateId)) {
    throw new Error(
      'signingBroker.stateId must be an exact lowercase identifier of at most 64 characters',
    );
  }
  if (config.repositoryId !== `hid-${environmentName}-v1`) {
    throw new Error('signingBroker.repositoryId must equal the governed release-trust repository ID');
  }
  if (config.stateId !== `hid-${environmentName}-broker-v1`) {
    throw new Error(
      'signingBroker.stateId must equal the governed release-trust broker state ID',
    );
  }

  if (!imageDigestPattern.test(config.imageDigest)) {
    throw new Error(
      'signingBroker.imageDigest must be an exact lowercase sha256 content digest; image tags are forbidden',
    );
  }

  let publicRepositoryUrl: URL;
  try {
    publicRepositoryUrl = new URL(config.publicRepositoryUrl);
  } catch {
    throw new Error('signingBroker.publicRepositoryUrl must be an exact HTTPS URL');
  }
  if (
    publicRepositoryUrl.protocol !== 'https:' ||
    publicRepositoryUrl.username !== '' ||
    publicRepositoryUrl.password !== '' ||
    publicRepositoryUrl.port !== '' ||
    publicRepositoryUrl.search !== '' ||
    publicRepositoryUrl.hash !== '' ||
    publicRepositoryUrl.hostname.length === 0 ||
    forbiddenLiteralCharacters.test(config.publicRepositoryUrl) ||
    publicRepositoryUrl.href !== config.publicRepositoryUrl
  ) {
    throw new Error(
      'signingBroker.publicRepositoryUrl must be a normalized HTTPS URL without credentials, port, query, fragment, or wildcard',
    );
  }
  const expectedPublicRepositoryUrl =
    environmentName === 'production'
      ? 'https://updates.healthidentitydirectory.com/'
      : 'https://updates.staging.healthidentitydirectory.com/';
  if (config.publicRepositoryUrl !== expectedPublicRepositoryUrl) {
    throw new Error(
      'signingBroker.publicRepositoryUrl must equal the governed environment repository origin',
    );
  }
  if (!lowercaseSha256Pattern.test(config.bootstrapRootSha256)) {
    throw new Error('signingBroker.bootstrapRootSha256 must be a lowercase SHA-256 digest');
  }
  if (
    config.bootstrapRootObjectVersionId.length === 0 ||
    config.bootstrapRootObjectVersionId.length > 1024 ||
    config.bootstrapRootObjectVersionId === 'null' ||
    !exactS3VersionIdPattern.test(config.bootstrapRootObjectVersionId) ||
    /[\\"]/u.test(config.bootstrapRootObjectVersionId)
  ) {
    throw new Error(
      'signingBroker.bootstrapRootObjectVersionId must be an exact non-null immutable S3 VersionId',
    );
  }

  if (
    config.candidatePublicKeySpkiSha256 === null ||
    typeof config.candidatePublicKeySpkiSha256 !== 'object' ||
    Array.isArray(config.candidatePublicKeySpkiSha256)
  ) {
    throw new Error(
      'signingBroker.candidatePublicKeySpkiSha256 must contain all four candidate pins',
    );
  }
  const suppliedCandidates = Object.keys(config.candidatePublicKeySpkiSha256).sort();
  const expectedCandidates = [...onlineSigningCandidateNames].sort();
  if (JSON.stringify(suppliedCandidates) !== JSON.stringify(expectedCandidates)) {
    throw new Error(
      'signingBroker.candidatePublicKeySpkiSha256 must contain exactly all four candidate pins',
    );
  }
  const distinctPins = new Set<string>();
  for (const candidate of onlineSigningCandidateNames) {
    const pin = config.candidatePublicKeySpkiSha256[candidate];
    if (typeof pin !== 'string') {
      throw new Error(
        `signingBroker.candidatePublicKeySpkiSha256.${candidate} must be a string`,
      );
    }
    requireLiteral(
      `signingBroker.candidatePublicKeySpkiSha256.${candidate}`,
      pin,
    );
    if (!lowercaseSha256Pattern.test(pin)) {
      throw new Error(
        `signingBroker.candidatePublicKeySpkiSha256.${candidate} must be a lowercase SHA-256 digest`,
      );
    }
    distinctPins.add(pin);
  }
  if (distinctPins.size !== onlineSigningCandidateNames.length) {
    throw new Error('signingBroker candidate public-key pins must be distinct');
  }
  if (config.acknowledgeCeremonyApprovedImmutablePins !== true) {
    throw new Error(
      'signingBroker.acknowledgeCeremonyApprovedImmutablePins must be true',
    );
  }

  return {
    ...config,
    bootstrapRootObjectKey:
      `tuf-signing-broker/bootstrap/${config.stateId}/root.json`,
  };
}

const brokerSchema = 'hid.tuf.signing-broker.config/v1';
const stateRetentionDays = 730;
const maximumExpectedSignaturesPerFiveMinutes = 8;
const lambdaImagePullActions = [
  'ecr:BatchCheckLayerAvailability',
  'ecr:BatchGetImage',
  'ecr:GetDownloadUrlForLayer',
];

interface CandidateRuntime {
  readonly binding: TufSigningCandidateBinding;
  readonly executionRole: iam.Role;
  readonly function: lambda.DockerImageFunction;
  readonly version: lambda.Version;
}

export class TufSigningBroker extends Construct {
  public readonly stateTable: dynamodb.Table;
  public readonly candidateVersions: Readonly<
    Record<OnlineSigningCandidateName, lambda.Version>
  >;
  public readonly checkpointVersion: lambda.Version;

  public constructor(scope: Construct, id: string, props: TufSigningBrokerProps) {
    super(scope, id);

    if (props.signingCandidates.length !== onlineSigningCandidateNames.length) {
      throw new Error('The signing broker requires exactly four candidate bindings');
    }
    if (
      (props.evidenceObjectLockMode !== 'GOVERNANCE' &&
        props.evidenceObjectLockMode !== 'COMPLIANCE') ||
      (props.environmentName === 'production' &&
        props.evidenceObjectLockMode !== 'COMPLIANCE') ||
      !Number.isSafeInteger(props.evidenceRetentionDays) ||
      props.evidenceRetentionDays <
        (props.environmentName === 'production' ? 180 : 90) ||
      props.evidenceRetentionDays > stateRetentionDays
    ) {
      throw new Error(
        'The signing broker requires the validated evidence Object Lock policy',
      );
    }
    const suppliedCandidateNames = props.signingCandidates.map(({ name }) => name).sort();
    if (
      JSON.stringify(suppliedCandidateNames) !==
      JSON.stringify([...onlineSigningCandidateNames].sort())
    ) {
      throw new Error('The signing broker requires each fixed candidate exactly once');
    }

    const stack = Stack.of(this);
    const stateEncryptionKey = new kms.Key(this, 'StateEncryptionKey', {
      description: `Encryption for ${props.environmentName} TUF broker state and logs`,
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const stateTableName = `hid-${props.environmentName}-tuf-broker-state`;
    const stateTableArn = stack.formatArn({
      service: 'dynamodb',
      resource: 'table',
      resourceName: stateTableName,
    });

    this.stateTable = new dynamodb.Table(this, 'StateTable', {
      tableName: stateTableName,
      partitionKey: { name: 'state_id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'record_id', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.CUSTOMER_MANAGED,
      encryptionKey: stateEncryptionKey,
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
        recoveryPeriodInDays: 35,
      },
      deletionProtection: true,
      removalPolicy: RemovalPolicy.RETAIN,
      resourcePolicy: new iam.PolicyDocument({
        statements: [
          new iam.PolicyStatement({
            sid: 'DenyEveryNonCasStateMutation',
            effect: iam.Effect.DENY,
            principals: [new iam.AnyPrincipal()],
            actions: [
              'dynamodb:BatchWriteItem',
              'dynamodb:DeleteItem',
              'dynamodb:PartiQLDelete',
              'dynamodb:PartiQLInsert',
              'dynamodb:PartiQLUpdate',
              'dynamodb:PutItem',
              'dynamodb:TransactWriteItems',
            ],
            resources: [stateTableArn],
          }),
        ],
      }),
    });

    this.authorizePublicationStateRead(props);
    this.authorizePublicationJournal(props);

    this.authorizeEncryptedLambdaLogs(
      stateEncryptionKey,
      props.approvedRegion,
      props.approvedAccount,
      props.environmentName,
    );

    const runtimes = props.signingCandidates.map((binding) =>
      this.createCandidateRuntime(
        binding,
        props,
        props.imageRepository,
        stateEncryptionKey,
      ),
    );
    this.candidateVersions = Object.fromEntries(
      runtimes.map(({ binding, version }) => [binding.name, version]),
    ) as unknown as Readonly<Record<OnlineSigningCandidateName, lambda.Version>>;

    for (const runtime of runtimes) {
      const sourceFunctionArn = this.candidateFunctionArn(
        props.environmentName,
        runtime.binding,
      );
      this.authorizeFixedCandidateKey(runtime, sourceFunctionArn);
      this.authorizeStateReadWrite(
        runtime.executionRole,
        props.config.stateId,
        sourceFunctionArn,
      );
      this.authorizeStateObjectReadWrite(
        runtime.executionRole,
        sourceFunctionArn,
        props,
      );
      this.authorizeVersionedRequestRead(
        runtime.executionRole,
        sourceFunctionArn,
        runtime.binding,
        props,
      );
      this.authorizeRequestSubmission(runtime.binding, props);
      runtime.binding.requestSubmitterRole.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: 'InvokeExactSigningBrokerVersion',
          actions: ['lambda:InvokeFunction'],
          resources: [runtime.version.functionArn],
        }),
      );
      this.addFunctionAlarms(runtime.version, runtime.binding.name);
      new CfnOutput(this, `${this.pascal(runtime.binding.name)}BrokerVersionArn`, {
        value: runtime.version.functionArn,
      });
    }

    const checkpointRuntime = this.createCheckpointRuntime(
      props,
      props.imageRepository,
      stateEncryptionKey,
    );
    this.checkpointVersion = checkpointRuntime.version;
    this.authorizeExactBrokerImagePulls(
      props.imageRepository,
      runtimes
        .map(({ binding }) => this.candidateFunctionArn(props.environmentName, binding))
        .concat(this.checkpointFunctionArn(props.environmentName)),
      props.approvedAccount,
    );
    const checkpointSourceFunctionArn = this.checkpointFunctionArn(
      props.environmentName,
    );
    this.authorizeStateReadWrite(
      checkpointRuntime.executionRole,
      props.config.stateId,
      checkpointSourceFunctionArn,
    );
    this.authorizeStateObjectReadWrite(
      checkpointRuntime.executionRole,
      checkpointSourceFunctionArn,
      props,
    );
    this.authorizeBootstrapRootRead(
      checkpointRuntime.executionRole,
      checkpointSourceFunctionArn,
      props,
    );
    this.addFunctionAlarms(checkpointRuntime.version, 'checkpoint');

    this.authorizeExactStateWriters(
      runtimes
        .map(({ binding }) =>
          this.candidateExecutionRoleName(props.environmentName, binding),
        )
        .concat(this.checkpointExecutionRoleName(props.environmentName)),
      props.environmentName,
    );
    this.reserveBrokerObjectNamespaces(
      runtimes,
      checkpointRuntime.executionRole,
      props,
    );

    const checkpointRuleName =
      `hid-${props.environmentName}-tuf-broker-checkpoint`;
    new events.Rule(this, 'CheckpointSchedule', {
      ruleName: checkpointRuleName,
      description:
        'Independently validates the fixed public TUF repository and conditionally advances broker trust state',
      enabled: true,
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [
        new eventTargets.LambdaFunction(checkpointRuntime.version, {
          maxEventAge: Duration.minutes(2),
          retryAttempts: 0,
        }),
      ],
    });
    new cloudwatch.Alarm(this, 'CheckpointScheduleFailedInvocationAlarm', {
      alarmDescription:
        'EventBridge failed to invoke the fixed TUF checkpoint Lambda version',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Events',
        metricName: 'FailedInvocations',
        dimensionsMap: { RuleName: checkpointRuleName },
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'CheckpointInvocationHeartbeatAlarm', {
      alarmDescription:
        'The fixed TUF checkpoint Lambda version received no scheduled invocation',
      metric: checkpointRuntime.version.metricInvocations({
        period: Duration.minutes(10),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 2,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.BREACHING,
    });

    props.auditTrail.addLambdaEventSelector(
      [...runtimes.map(({ function: brokerFunction }) => brokerFunction), checkpointRuntime.function],
      {
        includeManagementEvents: false,
        readWriteType: cloudtrail.ReadWriteType.ALL,
      },
    );
    props.auditTrail.addEventSelector(
      'AWS::DynamoDB::Table' as cloudtrail.DataResourceType,
      [this.stateTable.tableArn],
      {
        includeManagementEvents: false,
        readWriteType: cloudtrail.ReadWriteType.ALL,
      },
    );
    this.addAuditMetricFilters(
      props,
      runtimes.map(({ executionRole }) => executionRole).concat(
        checkpointRuntime.executionRole,
      ),
    );

    new cloudwatch.Alarm(this, 'StateConditionalWriteFailureAlarm', {
      alarmDescription:
        'A stale or concurrent signing/checkpoint transition was rejected by DynamoDB',
      metric: this.stateTable.metricConditionalCheckFailedRequests({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, 'StateSystemErrorAlarm', {
      alarmDescription: 'The durable TUF signing-broker state table reported errors',
      metric: this.stateTable.metricSystemErrorsForOperations({
        operations: [
          dynamodb.Operation.GET_ITEM,
          dynamodb.Operation.UPDATE_ITEM,
        ],
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    for (const child of this.node.findAll()) {
      if (child instanceof cloudwatch.Alarm) {
        child.addAlarmAction(new cloudwatchActions.SnsAction(props.alarmTopic));
      }
    }

    new CfnOutput(this, 'StateTableName', { value: this.stateTable.tableName });
    new CfnOutput(this, 'CheckpointVersionArn', {
      value: this.checkpointVersion.functionArn,
    });
    new CfnOutput(this, 'PinnedBrokerImageDigest', {
      value: props.config.imageDigest,
    });
    new CfnOutput(this, 'PinnedBootstrapRootSha256', {
      value: props.config.bootstrapRootSha256,
    });
  }

  private createCandidateRuntime(
    binding: TufSigningCandidateBinding,
    props: TufSigningBrokerProps,
    imageRepository: ecr.IRepository,
    stateEncryptionKey: kms.Key,
  ): CandidateRuntime {
    const candidateLabel = `${binding.role}-${binding.ordinal}`;
    const requestObjectPrefix =
      `tuf-signing-broker/requests/${props.config.stateId}/${candidateLabel}/`;
    const stateObjectPrefix = `tuf-signing-broker/state/${props.config.stateId}/`;
    const executionRole = this.executionRole(
      `${this.pascal(binding.name)}ExecutionRole`,
      this.candidateExecutionRoleName(props.environmentName, binding),
      `Fixed ${binding.role} candidate ${binding.ordinal} TUF signing-broker execution role; only its paired key policy permits KMS Sign`,
    );
    const functionName = this.candidateFunctionName(
      props.environmentName,
      binding,
    );
    const logGroup = this.encryptedFunctionLogGroup(
      `${this.pascal(binding.name)}LogGroup`,
      functionName,
      stateEncryptionKey,
    );
    this.authorizeFunctionLogs(executionRole, logGroup);
    const brokerFunction = new lambda.DockerImageFunction(
      this,
      `${this.pascal(binding.name)}Function`,
      {
        functionName,
        description:
          `State-pinned ${binding.role} candidate ${binding.ordinal} signer for ${props.environmentName}`,
        code: lambda.DockerImageCode.fromEcr(imageRepository, {
          tagOrDigest: props.config.imageDigest,
        }),
        role: executionRole,
        logGroup,
        memorySize: 512,
        timeout: Duration.seconds(30),
        reservedConcurrentExecutions: 1,
        loggingFormat: lambda.LoggingFormat.JSON,
        applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        systemLogLevelV2: lambda.SystemLogLevel.WARN,
        environment: {
          HID_BROKER_CONFIG_SCHEMA: brokerSchema,
          HID_BROKER_OPERATION: 'sign',
          HID_BROKER_ENVIRONMENT: props.environmentName,
          HID_REPOSITORY_ID: props.config.repositoryId,
          HID_STATE_ID: props.config.stateId,
          HID_ROLE: binding.role,
          HID_CANDIDATE: binding.ordinal,
          HID_KMS_KEY_ARN: binding.signingKey.keyArn,
          HID_KMS_PUBLIC_KEY_SPKI_SHA256:
            props.config.candidatePublicKeySpkiSha256[binding.name],
          HID_BOOTSTRAP_ROOT_SHA256: props.config.bootstrapRootSha256,
          HID_STATE_TABLE_NAME: this.stateTable.tableName,
          HID_STATE_BUCKET_NAME: props.evidenceBucket.bucketName,
          HID_STATE_OBJECT_PREFIX: stateObjectPrefix,
          HID_STORAGE_KMS_KEY_ARN: props.evidenceEncryptionKey.keyArn,
          HID_OBJECT_LOCK_MODE: props.evidenceObjectLockMode,
          HID_STATE_RETENTION_DAYS: String(stateRetentionDays),
          HID_EVIDENCE_RETENTION_DAYS: String(props.evidenceRetentionDays),
          HID_EXPECTED_AWS_ACCOUNT_ID: props.approvedAccount,
          HID_EXPECTED_AWS_REGION: props.approvedRegion,
          HID_REQUEST_BUCKET_NAME: props.evidenceBucket.bucketName,
          HID_REQUEST_OBJECT_PREFIX: requestObjectPrefix,
          HID_MAX_PLAN_AGE_SECONDS: '300',
          HID_MAX_CLOCK_SKEW_SECONDS: '60',
          HID_REQUIRE_OBJECT_LOCK_RETENTION: 'true',
        },
      },
    );
    const version = brokerFunction.currentVersion;
    return { binding, executionRole, function: brokerFunction, version };
  }

  private createCheckpointRuntime(
    props: TufSigningBrokerProps,
    imageRepository: ecr.IRepository,
    stateEncryptionKey: kms.Key,
  ): Omit<CandidateRuntime, 'binding'> {
    const executionRole = this.executionRole(
      'CheckpointExecutionRole',
      this.checkpointExecutionRoleName(props.environmentName),
      `Non-signing TUF public-repository checkpoint canary for ${props.environmentName}`,
    );
    const functionName = this.checkpointFunctionName(props.environmentName);
    const logGroup = this.encryptedFunctionLogGroup(
      'CheckpointLogGroup',
      functionName,
      stateEncryptionKey,
    );
    this.authorizeFunctionLogs(executionRole, logGroup);
    const checkpointFunction = new lambda.DockerImageFunction(
      this,
      'CheckpointFunction',
      {
        functionName,
        description:
          `Non-signing state-pinned TUF checkpoint canary for ${props.environmentName}`,
        code: lambda.DockerImageCode.fromEcr(imageRepository, {
          tagOrDigest: props.config.imageDigest,
        }),
        role: executionRole,
        logGroup,
        memorySize: 512,
        timeout: Duration.seconds(30),
        reservedConcurrentExecutions: 1,
        loggingFormat: lambda.LoggingFormat.JSON,
        applicationLogLevelV2: lambda.ApplicationLogLevel.INFO,
        systemLogLevelV2: lambda.SystemLogLevel.WARN,
        environment: {
          HID_BROKER_CONFIG_SCHEMA: brokerSchema,
          HID_BROKER_OPERATION: 'checkpoint',
          HID_BROKER_ENVIRONMENT: props.environmentName,
          HID_REPOSITORY_ID: props.config.repositoryId,
          HID_STATE_ID: props.config.stateId,
          HID_PUBLIC_REPOSITORY_URL: props.config.publicRepositoryUrl,
          HID_BOOTSTRAP_ROOT_SHA256: props.config.bootstrapRootSha256,
          HID_BOOTSTRAP_ROOT_BUCKET_NAME: props.evidenceBucket.bucketName,
          HID_BOOTSTRAP_ROOT_OBJECT_KEY: props.config.bootstrapRootObjectKey,
          HID_BOOTSTRAP_ROOT_OBJECT_VERSION_ID:
            props.config.bootstrapRootObjectVersionId,
          HID_STATE_TABLE_NAME: this.stateTable.tableName,
          HID_STATE_BUCKET_NAME: props.evidenceBucket.bucketName,
          HID_STATE_OBJECT_PREFIX:
            `tuf-signing-broker/state/${props.config.stateId}/`,
          HID_STORAGE_KMS_KEY_ARN: props.evidenceEncryptionKey.keyArn,
          HID_OBJECT_LOCK_MODE: props.evidenceObjectLockMode,
          HID_STATE_RETENTION_DAYS: String(stateRetentionDays),
          HID_EVIDENCE_RETENTION_DAYS: String(props.evidenceRetentionDays),
          HID_EXPECTED_AWS_ACCOUNT_ID: props.approvedAccount,
          HID_EXPECTED_AWS_REGION: props.approvedRegion,
          HID_CHECKPOINT_RULE_ARN: Stack.of(this).formatArn({
            service: 'events',
            resource: 'rule',
            resourceName: `hid-${props.environmentName}-tuf-broker-checkpoint`,
          }),
        },
      },
    );
    return {
      executionRole,
      function: checkpointFunction,
      version: checkpointFunction.currentVersion,
    };
  }

  private executionRole(
    id: string,
    roleName: string,
    description: string,
  ): iam.Role {
    return new iam.Role(this, id, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description,
      maxSessionDuration: Duration.hours(1),
      roleName,
    });
  }

  private authorizeFunctionLogs(role: iam.Role, logGroup: logs.LogGroup): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'WriteOnlyExactBrokerFunctionLogs',
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${logGroup.logGroupArn}:*`],
      }),
    );
  }

  private encryptedFunctionLogGroup(
    id: string,
    functionName: string,
    stateEncryptionKey: kms.Key,
  ): logs.LogGroup {
    return new logs.LogGroup(this, id, {
      logGroupName: `/aws/lambda/${functionName}`,
      encryptionKey: stateEncryptionKey,
      retention: logs.RetentionDays.TEN_YEARS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  private authorizeEncryptedLambdaLogs(
    encryptionKey: kms.Key,
    region: string,
    account: string,
    environmentName: string,
  ): void {
    const lambdaLogArn = Stack.of(this).formatArn({
      service: 'logs',
      resource: 'log-group',
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
      resourceName: `/aws/lambda/hid-${environmentName}-tuf-broker-*`,
    });
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowExactRegionalCloudWatchLogsEncryption',
        principals: [new iam.ServicePrincipal(`logs.${region}.amazonaws.com`)],
        actions: [
          'kms:Encrypt',
          'kms:Decrypt',
          'kms:ReEncrypt*',
          'kms:GenerateDataKey*',
          'kms:DescribeKey',
        ],
        resources: ['*'],
        conditions: {
          StringEquals: { 'kms:CallerAccount': account },
          ArnLike: { 'kms:EncryptionContext:aws:logs:arn': lambdaLogArn },
        },
      }),
    );
  }

  private authorizeFixedCandidateKey(
    runtime: CandidateRuntime,
    sourceFunctionArn: string,
  ): void {
    const { signingKey } = runtime.binding;
    signingKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: `AllowExact${this.pascal(runtime.binding.name)}BrokerKeyInspection`,
        principals: [runtime.executionRole],
        actions: ['kms:DescribeKey', 'kms:GetPublicKey'],
        resources: ['*'],
      }),
    );
    runtime.executionRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'SignOnlyFromExactBrokerFunction',
        actions: ['kms:Sign'],
        resources: [signingKey.keyArn],
        conditions: {
          StringEquals: {
            'kms:MessageType': 'DIGEST',
            'kms:SigningAlgorithm': 'ECDSA_SHA_256',
          },
          ArnEquals: {
            'lambda:SourceFunctionArn': sourceFunctionArn,
          },
        },
      }),
    );
    signingKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenySigningFromEveryOtherPrincipal',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:Sign'],
        resources: ['*'],
        conditions: {
          ArnNotEquals: { 'aws:PrincipalArn': runtime.executionRole.roleArn },
        },
      }),
    );
    signingKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyEveryOtherSigningAlgorithm',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:Sign'],
        resources: ['*'],
        conditions: {
          StringNotEquals: { 'kms:SigningAlgorithm': 'ECDSA_SHA_256' },
        },
      }),
    );
    signingKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyEveryOtherMessageType',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['kms:Sign'],
        resources: ['*'],
        conditions: {
          StringNotEquals: { 'kms:MessageType': 'DIGEST' },
        },
      }),
    );
  }

  private authorizeExactBrokerImagePulls(
    imageRepository: ecr.IRepository,
    sourceFunctionArns: readonly string[],
    sourceAccount: string,
  ): void {
    const lambdaService = new iam.ServicePrincipal('lambda.amazonaws.com');
    imageRepository.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowExactBrokerFunctionsToRetrievePinnedImage',
        principals: [lambdaService],
        actions: lambdaImagePullActions,
        conditions: {
          StringEquals: { 'aws:SourceAccount': sourceAccount },
          ArnEquals: { 'aws:SourceArn': sourceFunctionArns },
        },
      }),
    );
    imageRepository.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyLambdaImageRetrievalOutsideExactBrokerFunctions',
        effect: iam.Effect.DENY,
        principals: [lambdaService],
        actions: lambdaImagePullActions,
        conditions: {
          ArnNotEquals: { 'aws:SourceArn': sourceFunctionArns },
        },
      }),
    );
    imageRepository.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyLambdaImageRetrievalFromUnexpectedSourceAccount',
        effect: iam.Effect.DENY,
        principals: [lambdaService],
        actions: lambdaImagePullActions,
        conditions: {
          Null: { 'aws:SourceAccount': 'false' },
          StringNotEquals: { 'aws:SourceAccount': sourceAccount },
        },
      }),
    );
  }

  private authorizeExactStateWriters(
    roleNames: readonly string[],
    environmentName: 'staging' | 'production',
  ): void {
    const stack = Stack.of(this);
    const exactRoleArns = roleNames.map((roleName) =>
      stack.formatArn({
        service: 'iam',
        region: '',
        resource: 'role',
        resourceName: roleName,
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
      }),
    );
    const exactTableArn = stack.formatArn({
      service: 'dynamodb',
      resource: 'table',
      resourceName: `hid-${environmentName}-tuf-broker-state`,
    });
    this.stateTable.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyStateUpdateFromEveryOtherPrincipal',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['dynamodb:UpdateItem'],
        resources: [exactTableArn],
        conditions: {
          'ForAnyValue:StringEquals': {
            'dynamodb:LeadingKeys': [`hid-${environmentName}-broker-v1`],
          },
          ArnNotEquals: {
            'aws:PrincipalArn': exactRoleArns,
          },
        },
      }),
    );
  }

  private reserveBrokerObjectNamespaces(
    runtimes: readonly CandidateRuntime[],
    checkpointRole: iam.Role,
    props: TufSigningBrokerProps,
  ): void {
    const stateObjects = props.evidenceBucket.arnForObjects(
      `tuf-signing-broker/state/${props.config.stateId}/*`,
    );
    props.evidenceBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyBrokerStateWritesFromEveryOtherPrincipal',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject', 's3:PutObjectRetention'],
        resources: [stateObjects],
        conditions: {
          ArnNotEquals: {
            'aws:PrincipalArn': runtimes
              .map(({ executionRole }) => executionRole.roleArn)
              .concat(checkpointRole.roleArn),
          },
        },
      }),
    );

    for (const { binding } of runtimes) {
      const candidateLabel = `${binding.role}-${binding.ordinal}`;
      props.evidenceBucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: `Deny${this.pascal(binding.name)}RequestWritesFromEveryOtherPrincipal`,
          effect: iam.Effect.DENY,
          principals: [new iam.AnyPrincipal()],
          actions: ['s3:PutObject'],
          resources: [
            props.evidenceBucket.arnForObjects(
              `tuf-signing-broker/requests/${props.config.stateId}/${candidateLabel}/*`,
            ),
          ],
          conditions: {
            ArnNotEquals: {
              'aws:PrincipalArn': binding.requestSubmitterRole.roleArn,
            },
          },
        }),
      );
    }

    props.evidenceBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyPinnedBootstrapRootMutation',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject', 's3:PutObjectRetention'],
        resources: [
          props.evidenceBucket.arnForObjects(props.config.bootstrapRootObjectKey),
        ],
      }),
    );
    props.evidenceBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyBrokerObjectDeletionAndRetentionBypass',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: [
          's3:BypassGovernanceRetention',
          's3:DeleteObject',
          's3:DeleteObjectVersion',
        ],
        resources: [props.evidenceBucket.arnForObjects('tuf-signing-broker/*')],
      }),
    );
  }

  private candidateExecutionRoleName(
    environmentName: 'staging' | 'production',
    binding: TufSigningCandidateBinding,
  ): string {
    return `hid-${environmentName}-tuf-broker-${binding.role}-${binding.ordinal}-runtime`;
  }

  private checkpointExecutionRoleName(
    environmentName: 'staging' | 'production',
  ): string {
    return `hid-${environmentName}-tuf-broker-checkpoint-runtime`;
  }

  private candidateFunctionName(
    environmentName: 'staging' | 'production',
    binding: TufSigningCandidateBinding,
  ): string {
    return `hid-${environmentName}-tuf-broker-${binding.role}-${binding.ordinal}`;
  }

  private checkpointFunctionName(
    environmentName: 'staging' | 'production',
  ): string {
    return `hid-${environmentName}-tuf-broker-checkpoint`;
  }

  private candidateFunctionArn(
    environmentName: 'staging' | 'production',
    binding: TufSigningCandidateBinding,
  ): string {
    return this.functionArn(this.candidateFunctionName(environmentName, binding));
  }

  private checkpointFunctionArn(
    environmentName: 'staging' | 'production',
  ): string {
    return this.functionArn(this.checkpointFunctionName(environmentName));
  }

  private functionArn(functionName: string): string {
    return Stack.of(this).formatArn({
      service: 'lambda',
      resource: 'function',
      resourceName: functionName,
      arnFormat: ArnFormat.COLON_RESOURCE_NAME,
    });
  }

  private authorizeStateReadWrite(
    role: iam.Role,
    stateId: string,
    sourceFunctionArn: string,
  ): void {
    const leadingKeyCondition = {
      'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [stateId] },
      ArnEquals: { 'lambda:SourceFunctionArn': sourceFunctionArn },
    };
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadExactBrokerStatePartition',
        actions: ['dynamodb:GetItem'],
        resources: [this.stateTable.tableArn],
        conditions: leadingKeyCondition,
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ConditionallyAdvanceExactBrokerStatePartition',
        actions: ['dynamodb:UpdateItem'],
        resources: [this.stateTable.tableArn],
        conditions: leadingKeyCondition,
      }),
    );
  }

  private authorizePublicationStateRead(props: TufSigningBrokerProps): void {
    const stateObjectPrefix = `tuf-signing-broker/state/${props.config.stateId}/`;
    const stateObjects = props.evidenceBucket.arnForObjects(`${stateObjectPrefix}*`);
    props.publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PublisherReadExactBrokerCheckpoint',
      actions: ['dynamodb:GetItem'],
      resources: [this.stateTable.tableArn],
      conditions: {
        'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [props.config.stateId] },
      },
    }));
    props.publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PublisherReadOnlyLockedBrokerStateVersions',
      actions: ['s3:GetObjectVersion', 's3:GetObjectRetention'],
      resources: [stateObjects],
    }));
    props.publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PublisherDecryptOnlyBrokerStateThroughS3',
      actions: ['kms:Decrypt'],
      resources: [props.evidenceEncryptionKey.keyArn],
      conditions: {
        StringEquals: {
          'kms:CallerAccount': props.approvedAccount,
          'kms:ViaService': `s3.${props.approvedRegion}.amazonaws.com`,
        },
        ArnLike: { 'kms:EncryptionContext:aws:s3:arn': stateObjects },
      },
    }));
    new CfnOutput(this, 'PublicationReaderConfiguration', {
      description: 'Public trust/storage pins; review and hash in the protected publisher configuration before use',
      value: JSON.stringify({
        schema_version: 'hid.tuf.publication-reader/v1',
        environment: props.environmentName,
        repository_id: props.config.repositoryId,
        state_id: props.config.stateId,
        bootstrap_root_sha256: props.config.bootstrapRootSha256,
        table_name: this.stateTable.tableName,
        bucket_name: props.evidenceBucket.bucketName,
        state_object_prefix: stateObjectPrefix,
        expected_aws_account_id: props.approvedAccount,
        expected_aws_region: props.approvedRegion,
        encryption_key_arn: props.evidenceEncryptionKey.keyArn,
        object_lock_mode: props.evidenceObjectLockMode,
      }),
    });
  }

  private authorizePublicationJournal(props: TufSigningBrokerProps): void {
    // A table resource policy cannot reference its own GetAtt ARN.
    const stateTableArn = Stack.of(this).formatArn({
      service: 'dynamodb', resource: 'table',
      resourceName: `hid-${props.environmentName}-tuf-broker-state`,
      arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    });
    const journalId = `hid-${props.environmentName}-publication-v1`;
    const journalPrefix = `tuf-publication-journal/${journalId}/`;
    const slotPrefix = `${journalPrefix}slots/`;
    const slots = props.evidenceBucket.arnForObjects(`${slotPrefix}*.json`);
    const evidence = props.evidenceBucket.arnForObjects(`${journalPrefix}evidence/*.json`);
    const archive = props.evidenceBucket.arnForObjects(`${journalPrefix}archives/*`);
    const immutableObjects = [slots, evidence, archive];
    const leadingKey = { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [journalId] } };
    props.publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PublicationJournalReadAndCompareExchangeHead',
      actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'],
      resources: [this.stateTable.tableArn],
      conditions: { ...leadingKey, Null: { 'dynamodb:LeadingKeys': 'false' } },
    }));
    this.stateTable.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyPublicationJournalUpdateFromEveryOtherPrincipal',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['dynamodb:UpdateItem'],
      resources: [stateTableArn],
      conditions: {
        'ForAnyValue:StringEquals': { 'dynamodb:LeadingKeys': [journalId] },
        ArnNotEquals: { 'aws:PrincipalArn': props.publisherRole.roleArn },
      },
    }));
    this.stateTable.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyUpdateOutsideGovernedStatePartitions',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['dynamodb:UpdateItem'],
      resources: [stateTableArn],
      conditions: {
        'ForAnyValue:StringNotEquals': { 'dynamodb:LeadingKeys': [props.config.stateId, journalId] },
      },
    }));
    this.stateTable.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyUpdateWithoutStatePartition',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['dynamodb:UpdateItem'],
      resources: [stateTableArn],
      conditions: { Null: { 'dynamodb:LeadingKeys': 'true' } },
    }));
    props.publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PublicationJournalReadExactLockedSlots',
      actions: ['s3:GetObjectVersion', 's3:GetObjectRetention'],
      resources: immutableObjects,
    }));
    props.publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PublicationJournalInspectOnlyExactSlotVersions',
      actions: ['s3:ListBucketVersions'],
      resources: [props.evidenceBucket.bucketArn],
      conditions: {
        StringLike: { 's3:prefix': [`${slotPrefix}*.json`, `${journalPrefix}evidence/*.json`, `${journalPrefix}archives/*`] },
        NumericEquals: { 's3:max-keys': '2' },
      },
    }));
    props.publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PublicationJournalAppendConditionalLockedSlots',
      actions: ['s3:PutObject'],
      resources: immutableObjects,
      conditions: {
        StringEquals: { 's3:if-none-match': '*', 's3:object-lock-mode': props.evidenceObjectLockMode },
        Null: { 's3:object-lock-retain-until-date': 'false' },
      },
    }));
    props.publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PublicationJournalRequireExactLongTermRetention',
      actions: ['s3:PutObjectRetention'],
      resources: immutableObjects,
      conditions: {
        StringEquals: { 's3:object-lock-mode': props.evidenceObjectLockMode },
        // Request time elapses between computing RetainUntilDate and AWS's
        // evaluation. Code writes 730 days and authenticates the original
        // record lifetime; the IAM floor allows only that day-boundary drift.
        NumericGreaterThanEquals: { 's3:object-lock-remaining-retention-days': '729' },
        NumericLessThanEquals: { 's3:object-lock-remaining-retention-days': String(stateRetentionDays) },
      },
    }));
    props.publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PublicationJournalUseOnlyArchiveKeyThroughS3',
      actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
      resources: [props.evidenceEncryptionKey.keyArn],
      conditions: {
        StringEquals: {
          'kms:CallerAccount': props.approvedAccount,
          'kms:ViaService': `s3.${props.approvedRegion}.amazonaws.com`,
        },
        ArnLike: { 'kms:EncryptionContext:aws:s3:arn': immutableObjects },
      },
    }));
    const journalObjects = props.evidenceBucket.arnForObjects(`${journalPrefix}*`);
    props.evidenceBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyPublicationJournalWritesFromEveryOtherPrincipal',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject', 's3:PutObjectRetention'],
      resources: [journalObjects],
      conditions: { ArnNotEquals: { 'aws:PrincipalArn': props.publisherRole.roleArn } },
    }));
    props.evidenceBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyPublicationJournalDeletionAndRetentionBypass',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:DeleteObject', 's3:DeleteObjectVersion', 's3:BypassGovernanceRetention'],
      resources: [journalObjects],
    }));
    props.evidenceBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyPublicationJournalNonConditionalWrites',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [journalObjects],
      conditions: { StringNotEquals: { 's3:if-none-match': '*' } },
    }));
    props.evidenceBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyPublicationJournalMissingExplicitRetention',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject'],
      resources: [journalObjects],
      conditions: { Null: { 's3:object-lock-retain-until-date': 'true' } },
    }));
    props.evidenceBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyPublicationJournalWrongRetentionMode',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObject', 's3:PutObjectRetention'],
      resources: [journalObjects],
      conditions: { StringNotEquals: { 's3:object-lock-mode': props.evidenceObjectLockMode } },
    }));
    props.evidenceBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyPublicationJournalRetentionBelowTwoYears',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObjectRetention'],
      resources: [journalObjects],
      conditions: { NumericLessThan: { 's3:object-lock-remaining-retention-days': '729' } },
    }));
    props.evidenceBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyPublicationJournalRetentionAboveTwoYears',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObjectRetention'],
      resources: [journalObjects],
      conditions: { NumericGreaterThan: { 's3:object-lock-remaining-retention-days': String(stateRetentionDays) } },
    }));
    new CfnOutput(this, 'PublicationJournalStorageConfiguration', {
      description: 'Separate append-only publication lineage in existing broker storage; no checkpoint mutation authority',
      value: JSON.stringify({
        schema_version: 'hid.tuf.publication-journal-storage/v1',
        journal_id: journalId,
        record_id: 'publication-head',
        table_name: this.stateTable.tableName,
        bucket_name: props.evidenceBucket.bucketName,
        object_prefix: journalPrefix,
        expected_aws_account_id: props.approvedAccount,
        expected_aws_region: props.approvedRegion,
        encryption_key_arn: props.evidenceEncryptionKey.keyArn,
        object_lock_mode: props.evidenceObjectLockMode,
        retention_days: stateRetentionDays,
      }),
    });
  }

  private authorizeStateObjectReadWrite(
    role: iam.Role,
    sourceFunctionArn: string,
    props: TufSigningBrokerProps,
  ): void {
    const stateObjectPrefix =
      `tuf-signing-broker/state/${props.config.stateId}/`;
    const stateObjects = props.evidenceBucket.arnForObjects(
      `${stateObjectPrefix}*`,
    );
    const sourceFunctionCondition = {
      ArnEquals: { 'lambda:SourceFunctionArn': sourceFunctionArn },
    };
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadExactImmutableBrokerStateObjects',
        actions: ['s3:GetObjectRetention', 's3:GetObjectVersion'],
        resources: [stateObjects],
        conditions: sourceFunctionCondition,
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AppendLockedBrokerStateObjects',
        actions: ['s3:PutObject', 's3:PutObjectRetention'],
        resources: [stateObjects],
        conditions: sourceFunctionCondition,
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'UseEvidenceKeyOnlyForBrokerStateThroughS3',
        actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'],
        resources: [props.evidenceEncryptionKey.keyArn],
        conditions: {
          StringEquals: {
            'kms:CallerAccount': props.approvedAccount,
            'kms:ViaService': `s3.${props.approvedRegion}.amazonaws.com`,
          },
          ArnEquals: {
            'lambda:SourceFunctionArn': sourceFunctionArn,
          },
          ArnLike: {
            'kms:EncryptionContext:aws:s3:arn': stateObjects,
          },
        },
      }),
    );
  }

  private authorizeVersionedRequestRead(
    role: iam.Role,
    sourceFunctionArn: string,
    binding: TufSigningCandidateBinding,
    props: TufSigningBrokerProps,
  ): void {
    const candidateLabel = `${binding.role}-${binding.ordinal}`;
    const requestObjectPrefix =
      `tuf-signing-broker/requests/${props.config.stateId}/${candidateLabel}/`;
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadOnlyImmutableVersionedSigningRequests',
        actions: [
          's3:GetObjectRetention',
          's3:GetObjectVersion',
        ],
        resources: [props.evidenceBucket.arnForObjects(`${requestObjectPrefix}*`)],
        conditions: {
          ArnEquals: { 'lambda:SourceFunctionArn': sourceFunctionArn },
        },
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'DecryptOnlyCandidateSigningRequestsThroughS3',
        actions: ['kms:Decrypt'],
        resources: [props.evidenceEncryptionKey.keyArn],
        conditions: {
          StringEquals: {
            'kms:CallerAccount': props.approvedAccount,
            'kms:ViaService': `s3.${props.approvedRegion}.amazonaws.com`,
          },
          ArnEquals: {
            'lambda:SourceFunctionArn': sourceFunctionArn,
          },
          ArnLike: {
            'kms:EncryptionContext:aws:s3:arn':
              props.evidenceBucket.arnForObjects(`${requestObjectPrefix}*`),
          },
        },
      }),
    );
  }

  private authorizeRequestSubmission(
    binding: TufSigningCandidateBinding,
    props: TufSigningBrokerProps,
  ): void {
    const candidateLabel = `${binding.role}-${binding.ordinal}`;
    const requestObjectPrefix =
      `tuf-signing-broker/requests/${props.config.stateId}/${candidateLabel}/`;
    const requestObjects = props.evidenceBucket.arnForObjects(
      `${requestObjectPrefix}*`,
    );
    binding.requestSubmitterRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'WriteOnlyCandidateSigningRequests',
        actions: ['s3:PutObject'],
        resources: [requestObjects],
      }),
    );
    binding.requestSubmitterRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'EncryptOnlyCandidateSigningRequestsThroughS3',
        actions: ['kms:Encrypt', 'kms:GenerateDataKey'],
        resources: [props.evidenceEncryptionKey.keyArn],
        conditions: {
          StringEquals: {
            'kms:CallerAccount': props.approvedAccount,
            'kms:ViaService': `s3.${props.approvedRegion}.amazonaws.com`,
          },
          ArnLike: {
            'kms:EncryptionContext:aws:s3:arn': requestObjects,
          },
        },
      }),
    );
  }

  private authorizeBootstrapRootRead(
    role: iam.Role,
    sourceFunctionArn: string,
    props: TufSigningBrokerProps,
  ): void {
    const bootstrapRootArn = props.evidenceBucket.arnForObjects(
      props.config.bootstrapRootObjectKey,
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadExactBootstrapRootRetention',
        actions: ['s3:GetObjectRetention'],
        resources: [bootstrapRootArn],
        conditions: {
          ArnEquals: { 'lambda:SourceFunctionArn': sourceFunctionArn },
        },
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadOnlyExactImmutableBootstrapRoot',
        actions: ['s3:GetObjectVersion'],
        resources: [bootstrapRootArn],
        conditions: {
          StringEquals: {
            's3:VersionId': props.config.bootstrapRootObjectVersionId,
          },
          ArnEquals: {
            'lambda:SourceFunctionArn': sourceFunctionArn,
          },
        },
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'DecryptOnlyBootstrapRootThroughS3',
        actions: ['kms:Decrypt'],
        resources: [props.evidenceEncryptionKey.keyArn],
        conditions: {
          StringEquals: {
            'kms:CallerAccount': props.approvedAccount,
            'kms:ViaService': `s3.${props.approvedRegion}.amazonaws.com`,
            'kms:EncryptionContext:aws:s3:arn': bootstrapRootArn,
          },
          ArnEquals: {
            'lambda:SourceFunctionArn': sourceFunctionArn,
          },
        },
      }),
    );
  }

  private addFunctionAlarms(
    version: lambda.Version,
    candidate: OnlineSigningCandidateName | 'checkpoint',
  ): void {
    const label = this.pascal(candidate);
    new cloudwatch.Alarm(this, `${label}ErrorAlarm`, {
      alarmDescription: `${candidate} TUF broker Lambda returned an error`,
      metric: version.metricErrors({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    new cloudwatch.Alarm(this, `${label}ThrottleAlarm`, {
      alarmDescription: `${candidate} TUF broker Lambda was throttled`,
      metric: version.metricThrottles({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }

  private addAuditMetricFilters(
    props: TufSigningBrokerProps,
    expectedStateWriters: readonly iam.Role[],
  ): void {
    const namespace = `HID/ReleaseTrust/${props.environmentName}`;
    const exactSigningKey = logs.FilterPattern.any(
      ...props.signingCandidates.map(({ signingKey }) =>
        logs.FilterPattern.stringValue(
          '$.requestParameters.keyId',
          '=',
          signingKey.keyArn,
        ),
      ),
    );
    const signAttempts = props.auditLogGroup.addMetricFilter('KmsSignAttempts', {
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue(
          '$.eventSource',
          '=',
          'kms.amazonaws.com',
        ),
        logs.FilterPattern.stringValue('$.eventName', '=', 'Sign'),
        exactSigningKey,
      ),
      metricNamespace: namespace,
      metricName: 'KmsSignAttempts',
      metricValue: '1',
      defaultValue: 0,
    });
    new cloudwatch.Alarm(this, 'KmsSignVolumeAlarm', {
      alarmDescription:
        'KMS signing volume exceeded the fixed release-ceremony envelope',
      metric: signAttempts.metric({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: maximumExpectedSignaturesPerFiveMinutes + 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const rejectedSignAttempts = props.auditLogGroup.addMetricFilter(
      'RejectedKmsSignAttempts',
      {
        filterPattern: logs.FilterPattern.all(
          logs.FilterPattern.stringValue(
            '$.eventSource',
            '=',
            'kms.amazonaws.com',
          ),
          logs.FilterPattern.stringValue('$.eventName', '=', 'Sign'),
          exactSigningKey,
          logs.FilterPattern.exists('$.errorCode'),
        ),
        metricNamespace: namespace,
        metricName: 'RejectedKmsSignAttempts',
        metricValue: '1',
        defaultValue: 0,
      },
    );
    new cloudwatch.Alarm(this, 'RejectedKmsSignAlarm', {
      alarmDescription: 'At least one KMS signing attempt was rejected',
      metric: rejectedSignAttempts.metric({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const unexpectedStateWriter = logs.FilterPattern.any(
      logs.FilterPattern.notExists(
        '$.userIdentity.sessionContext.sessionIssuer.arn',
      ),
      logs.FilterPattern.all(
        ...expectedStateWriters.map((role) =>
          logs.FilterPattern.stringValue(
            '$.userIdentity.sessionContext.sessionIssuer.arn',
            '!=',
            role.roleArn,
          ),
        ),
      ),
    );
    const unexpectedStateWrites = props.auditLogGroup.addMetricFilter(
      'UnexpectedStateWrites',
      {
        filterPattern: logs.FilterPattern.all(
          logs.FilterPattern.stringValue(
            '$.eventSource',
            '=',
            'dynamodb.amazonaws.com',
          ),
          logs.FilterPattern.any(
            logs.FilterPattern.stringValue('$.eventName', '=', 'PutItem'),
            logs.FilterPattern.stringValue('$.eventName', '=', 'UpdateItem'),
            logs.FilterPattern.stringValue(
              '$.eventName',
              '=',
              'TransactWriteItems',
            ),
            logs.FilterPattern.stringValue('$.eventName', '=', 'DeleteItem'),
            logs.FilterPattern.stringValue('$.eventName', '=', 'BatchWriteItem'),
            logs.FilterPattern.stringValue('$.eventName', '=', 'ExecuteStatement'),
            logs.FilterPattern.stringValue('$.eventName', '=', 'BatchExecuteStatement'),
          ),
          unexpectedStateWriter,
        ),
        metricNamespace: namespace,
        metricName: 'UnexpectedStateWrites',
        metricValue: '1',
        defaultValue: 0,
      },
    );
    new cloudwatch.Alarm(this, 'UnexpectedStateWriteAlarm', {
      alarmDescription:
        'A principal other than the fixed broker/checkpoint roles attempted a state write',
      metric: unexpectedStateWrites.metric({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });

    const destructiveStateWrites = props.auditLogGroup.addMetricFilter(
      'DestructiveStateWrites',
      {
        filterPattern: logs.FilterPattern.all(
          logs.FilterPattern.stringValue(
            '$.eventSource',
            '=',
            'dynamodb.amazonaws.com',
          ),
          logs.FilterPattern.any(
            logs.FilterPattern.stringValue('$.eventName', '=', 'PutItem'),
            logs.FilterPattern.stringValue('$.eventName', '=', 'DeleteItem'),
            logs.FilterPattern.stringValue('$.eventName', '=', 'BatchWriteItem'),
            logs.FilterPattern.stringValue(
              '$.eventName',
              '=',
              'TransactWriteItems',
            ),
            logs.FilterPattern.stringValue('$.eventName', '=', 'ExecuteStatement'),
            logs.FilterPattern.stringValue('$.eventName', '=', 'BatchExecuteStatement'),
          ),
        ),
        metricNamespace: namespace,
        metricName: 'DestructiveStateWrites',
        metricValue: '1',
        defaultValue: 0,
      },
    );
    new cloudwatch.Alarm(this, 'DestructiveStateWriteAlarm', {
      alarmDescription: 'An always-forbidden destructive broker-state write was attempted',
      metric: destructiveStateWrites.metric({
        period: Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator:
        cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
  }

  private pascal(value: string): string {
    return value
      .split(/[^A-Za-z0-9]+/u)
      .filter((part) => part.length > 0)
      .map((part) => part[0]?.toUpperCase() + part.slice(1))
      .join('');
  }
}
