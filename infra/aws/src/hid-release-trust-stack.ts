import {
  ArnFormat,
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
  Token,
} from 'aws-cdk-lib';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';
import {
  TufSigningBroker,
  type TufSigningBrokerConfig,
  type ValidatedTufSigningBrokerConfig,
  validateTufSigningBrokerConfig,
} from './tuf-signing-broker.js';

export type ReleaseTrustEnvironment = 'staging' | 'production';
export type EvidenceObjectLockMode = 'GOVERNANCE' | 'COMPLIANCE';

export const releaseTrustCapabilities = [
  'build',
  'publisher',
  'evidenceWriter',
  'auditor',
  'snapshotSignerOne',
  'snapshotSignerTwo',
  'timestampSignerOne',
  'timestampSignerTwo',
] as const;

export type ReleaseTrustCapability = (typeof releaseTrustCapabilities)[number];
export type GitHubProtectedEnvironmentSubjects = Readonly<
  Record<ReleaseTrustCapability, string>
>;
export type GitHubImmutableWorkflowRefs = Readonly<Record<ReleaseTrustCapability, string>>;

export const capabilityWorkflowNames: Readonly<Record<ReleaseTrustCapability, string>> = {
  build: 'tuf-build.yml',
  publisher: 'tuf-publish.yml',
  evidenceWriter: 'tuf-evidence.yml',
  auditor: 'tuf-audit.yml',
  snapshotSignerOne: 'tuf-snapshot-signer-one.yml',
  snapshotSignerTwo: 'tuf-snapshot-signer-two.yml',
  timestampSignerOne: 'tuf-timestamp-signer-one.yml',
  timestampSignerTwo: 'tuf-timestamp-signer-two.yml',
};

export interface PublisherCloudflareToken {
  /** Existing environment-owned secret; this stack never creates or resolves its value. */
  readonly secretArn: string;
  readonly versionId: string;
  /** Omit only when the existing secret uses the AWS-managed Secrets Manager key. */
  readonly encryptionKeyArn?: string;
}

const capabilityEnvironmentLabels: Readonly<Record<ReleaseTrustCapability, string>> = {
  build: 'build',
  publisher: 'publisher',
  evidenceWriter: 'evidence-writer',
  auditor: 'auditor',
  snapshotSignerOne: 'snapshot-signer-one',
  snapshotSignerTwo: 'snapshot-signer-two',
  timestampSignerOne: 'timestamp-signer-one',
  timestampSignerTwo: 'timestamp-signer-two',
};

export interface HidReleaseTrustStackProps extends Omit<StackProps, 'env'> {
  readonly environmentName: ReleaseTrustEnvironment;
  readonly approvedAccount: string;
  readonly approvedRegion: string;
  readonly githubOidcProviderArn: string;
  readonly githubAudience: string;
  readonly approvedGithubRepository: string;
  readonly approvedGithubRepositoryId: string;
  readonly approvedGithubRepositoryOwnerId: string;
  /** Exact protected caller branch, never a tag, pull request or wildcard. */
  readonly approvedGithubRef: string;
  readonly githubWorkflowRefs: GitHubImmutableWorkflowRefs;
  /** Exact, distinct subjects for capability-specific protected GitHub environments. */
  readonly githubProtectedEnvironmentSubjects: GitHubProtectedEnvironmentSubjects;
  readonly evidenceObjectLockMode: EvidenceObjectLockMode;
  /** Default Object Lock retention for every release-trust archive. */
  readonly evidenceRetentionDays: number;
  /** Object Lock cannot be disabled after bucket creation. */
  readonly acknowledgeObjectLockIsIrreversible: true;
  /**
   * Required before this stack may create production online signing keys.
   * This is distinct from the later approval of exported public-key pins.
   */
  readonly acknowledgeProductionSigningKeyCustodyApproved?: true;
  /** Existing environment-owned SNS topic for all release-trust alarms. */
  readonly alarmNotificationTopicArn?: string;
  /**
   * Omit until a reviewed image, immutable bootstrap root version, and all
   * four ceremony-derived public-key pins exist. Partial configuration is not
   * accepted and no signing endpoint exists while this is omitted.
   */
  readonly signingBroker?: TufSigningBrokerConfig;
  readonly publisherCloudflareToken?: PublisherCloudflareToken;
}

interface ValidatedReleaseTrustProps {
  readonly environmentName: ReleaseTrustEnvironment;
  readonly approvedAccount: string;
  readonly approvedRegion: string;
  readonly githubOidcProviderArn: string;
  readonly githubAudience: string;
  readonly approvedGithubRepository: string;
  readonly githubProtectedEnvironmentSubjects: GitHubProtectedEnvironmentSubjects;
  readonly evidenceObjectLockMode: EvidenceObjectLockMode;
  readonly evidenceRetentionDays: number;
  readonly alarmNotificationTopicArn?: string;
  readonly signingBroker?: ValidatedTufSigningBrokerConfig;
  readonly publisherCloudflareToken?: PublisherCloudflareToken;
}

const forbiddenOidcPatternCharacters = /[*?]/u;

function validateProps(props: HidReleaseTrustStackProps): ValidatedReleaseTrustProps {
  if (props.environmentName !== 'staging' && props.environmentName !== 'production') {
    throw new Error('environmentName must be exactly staging or production');
  }
  if (!/^\d{12}$/u.test(props.approvedAccount)) {
    throw new Error('approvedAccount must be an exact 12-digit AWS account ID');
  }
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d$/u.test(props.approvedRegion)) {
    throw new Error('approvedRegion must be an exact AWS region');
  }

  const providerPattern = new RegExp(
    `^arn:(?:aws|aws-us-gov|aws-cn|aws-eusc):iam::${props.approvedAccount}:oidc-provider/token\\.actions\\.githubusercontent\\.com$`,
    'u',
  );
  if (!providerPattern.test(props.githubOidcProviderArn)) {
    throw new Error(
      'githubOidcProviderArn must identify token.actions.githubusercontent.com in approvedAccount',
    );
  }
  if (
    props.githubAudience.trim() !== props.githubAudience ||
    props.githubAudience.length === 0 ||
    /\s/u.test(props.githubAudience) ||
    forbiddenOidcPatternCharacters.test(props.githubAudience)
  ) {
    throw new Error('githubAudience must be an exact, non-wildcard audience');
  }
  if (
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9_.-]+$/u.test(
      props.approvedGithubRepository,
    ) ||
    forbiddenOidcPatternCharacters.test(props.approvedGithubRepository)
  ) {
    throw new Error('approvedGithubRepository must be an exact owner/repository name');
  }
  if (
    props.githubProtectedEnvironmentSubjects === null ||
    typeof props.githubProtectedEnvironmentSubjects !== 'object' ||
    Array.isArray(props.githubProtectedEnvironmentSubjects)
  ) {
    throw new Error('githubProtectedEnvironmentSubjects must contain every release capability');
  }
  const suppliedCapabilities = Object.keys(props.githubProtectedEnvironmentSubjects).sort();
  const expectedCapabilities = [...releaseTrustCapabilities].sort();
  if (JSON.stringify(suppliedCapabilities) !== JSON.stringify(expectedCapabilities)) {
    throw new Error('githubProtectedEnvironmentSubjects must contain exactly every release capability');
  }
  const subjectValues = new Set<string>();
  for (const field of ['approvedGithubRepositoryId', 'approvedGithubRepositoryOwnerId'] as const) {
    if (typeof props[field] !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(props[field])) {
      throw new Error(`${field} must be an exact positive numeric GitHub ID`);
    }
  }
  if (
    typeof props.approvedGithubRef !== 'string' ||
    !/^refs\/heads\/[A-Za-z0-9][A-Za-z0-9._/-]*$/u.test(props.approvedGithubRef) ||
    /\.\.|\/\.|\/\/|\/$|\.lock$|\.$/u.test(props.approvedGithubRef)
  ) {
    throw new Error('approvedGithubRef must be one exact protected branch ref');
  }
  if (
    props.githubWorkflowRefs === null || typeof props.githubWorkflowRefs !== 'object' ||
    Array.isArray(props.githubWorkflowRefs) ||
    JSON.stringify(Object.keys(props.githubWorkflowRefs).sort()) !== JSON.stringify(expectedCapabilities)
  ) {
    throw new Error('githubWorkflowRefs must contain exactly every release capability');
  }
  const approvedRepositorySubjectPrefix = `repo:${props.approvedGithubRepository}`;
  const [githubOwner, githubRepository] = props.approvedGithubRepository.split('/');
  const immutableRepositorySubjectPrefix =
    `repo:${githubOwner}@${props.approvedGithubRepositoryOwnerId}/${githubRepository}@${props.approvedGithubRepositoryId}`;
  for (const capability of releaseTrustCapabilities) {
    const workflowRef = props.githubWorkflowRefs[capability];
    const workflowPrefix = `${props.approvedGithubRepository}/.github/workflows/${capabilityWorkflowNames[capability]}@`;
    if (typeof workflowRef !== 'string' || !workflowRef.startsWith(workflowPrefix) ||
        !/^[a-f0-9]{40}$/u.test(workflowRef.slice(workflowPrefix.length))) {
      throw new Error(`githubWorkflowRefs.${capability} must pin its exact capability workflow to a reviewed 40-character commit SHA`);
    }
    const subject = props.githubProtectedEnvironmentSubjects[capability];
    if (typeof subject !== 'string') {
      throw new Error(
        `githubProtectedEnvironmentSubjects.${capability} must be a string`,
      );
    }
    const subjectMatch =
      /^((?:repo:)[^/:*?\s]+\/[^:*?\s]+):environment:([^:*?\s]+)$/u.exec(subject);
    const expectedEnvironment = `${props.environmentName}-${capabilityEnvironmentLabels[capability]}`;
    if (
      subjectMatch === null ||
      subject.trim() !== subject ||
      forbiddenOidcPatternCharacters.test(subject) ||
      subjectMatch[2] !== expectedEnvironment
    ) {
      throw new Error(
        `githubProtectedEnvironmentSubjects.${capability} must be the exact, non-wildcard ${expectedEnvironment} protected-environment subject`,
      );
    }
    if (subjectMatch[1] !== approvedRepositorySubjectPrefix && subjectMatch[1] !== immutableRepositorySubjectPrefix) {
      throw new Error(
        `githubProtectedEnvironmentSubjects.${capability} must identify approvedGithubRepository`,
      );
    }
    if (subjectValues.has(subject)) {
      throw new Error('GitHub protected-environment subjects must be distinct by release capability');
    }
    subjectValues.add(subject);
  }
  if (
    props.evidenceObjectLockMode !== 'GOVERNANCE' &&
    props.evidenceObjectLockMode !== 'COMPLIANCE'
  ) {
    throw new Error('evidenceObjectLockMode must be GOVERNANCE or COMPLIANCE');
  }
  if (
    props.environmentName === 'production' &&
    props.evidenceObjectLockMode !== 'COMPLIANCE'
  ) {
    throw new Error('production evidenceObjectLockMode must be COMPLIANCE');
  }
  const minimumRetentionDays = props.environmentName === 'production' ? 180 : 90;
  if (
    !Number.isSafeInteger(props.evidenceRetentionDays) ||
    props.evidenceRetentionDays < minimumRetentionDays ||
    props.evidenceRetentionDays > 730
  ) {
    throw new Error(
      `evidenceRetentionDays must be an integer from ${minimumRetentionDays} through 730 for ${props.environmentName}`,
    );
  }
  if (props.acknowledgeObjectLockIsIrreversible !== true) {
    throw new Error('acknowledgeObjectLockIsIrreversible must be true');
  }
  if (
    props.environmentName === 'production' &&
    props.acknowledgeProductionSigningKeyCustodyApproved !== true
  ) {
    throw new Error(
      'acknowledgeProductionSigningKeyCustodyApproved must be true before production signing keys are created',
    );
  }

  const signingBroker = props.signingBroker === undefined
    ? undefined
    : validateTufSigningBrokerConfig(
        props.signingBroker,
        props.environmentName,
      );
  const publisherCloudflareToken = props.publisherCloudflareToken;
  if (publisherCloudflareToken !== undefined) {
    if (signingBroker === undefined) {
      throw new Error('publisherCloudflareToken requires the durable signing broker and publication journal');
    }
    const partition = /^arn:([^:]+):/u.exec(props.githubOidcProviderArn)?.[1];
    const secretPrefix = `arn:${partition}:secretsmanager:${props.approvedRegion}:${props.approvedAccount}:secret:hid-${props.environmentName}-cloudflare-publisher-token-`;
    if (publisherCloudflareToken === null || typeof publisherCloudflareToken !== 'object' ||
        typeof publisherCloudflareToken.secretArn !== 'string' ||
        !publisherCloudflareToken.secretArn.startsWith(secretPrefix) ||
        !/^[A-Za-z0-9]{6}$/u.test(publisherCloudflareToken.secretArn.slice(secretPrefix.length))) {
      throw new Error('publisherCloudflareToken.secretArn must be the exact existing environment-owned secret ARN');
    }
    if (typeof publisherCloudflareToken.versionId !== 'string' ||
        !/^[A-Za-z0-9-]{32,64}$/u.test(publisherCloudflareToken.versionId)) {
      throw new Error('publisherCloudflareToken.versionId must be an exact immutable secret version ID');
    }
    if (publisherCloudflareToken.encryptionKeyArn !== undefined) {
      const keyPrefix = `arn:${partition}:kms:${props.approvedRegion}:${props.approvedAccount}:key/`;
      if (!publisherCloudflareToken.encryptionKeyArn.startsWith(keyPrefix) ||
          !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(publisherCloudflareToken.encryptionKeyArn.slice(keyPrefix.length))) {
        throw new Error('publisherCloudflareToken.encryptionKeyArn must be an exact environment-account regional KMS key ARN');
      }
    }
  }
  let alarmNotificationTopicArn: string | undefined;
  if (signingBroker !== undefined) {
    if (typeof props.alarmNotificationTopicArn !== 'string') {
      throw new Error(
        'alarmNotificationTopicArn is required when the signing broker is enabled',
      );
    }
    if (Token.isUnresolved(props.alarmNotificationTopicArn)) {
      throw new Error('alarmNotificationTopicArn must be a literal reviewed ARN');
    }
    const partition = /^arn:([^:]+):/u.exec(props.githubOidcProviderArn)?.[1];
    const expectedAlarmTopicArn =
      `arn:${partition}:sns:${props.approvedRegion}:${props.approvedAccount}:hid-${props.environmentName}-release-trust-alerts`;
    if (props.alarmNotificationTopicArn !== expectedAlarmTopicArn) {
      throw new Error(
        'alarmNotificationTopicArn must identify the exact governed environment alert topic',
      );
    }
    alarmNotificationTopicArn = props.alarmNotificationTopicArn;
  }

  return {
    environmentName: props.environmentName,
    approvedAccount: props.approvedAccount,
    approvedRegion: props.approvedRegion,
    githubOidcProviderArn: props.githubOidcProviderArn,
    githubAudience: props.githubAudience,
    approvedGithubRepository: props.approvedGithubRepository,
    githubProtectedEnvironmentSubjects: props.githubProtectedEnvironmentSubjects,
    evidenceObjectLockMode: props.evidenceObjectLockMode,
    evidenceRetentionDays: props.evidenceRetentionDays,
    ...(alarmNotificationTopicArn === undefined ? {} : { alarmNotificationTopicArn }),
    ...(signingBroker === undefined ? {} : { signingBroker }),
    ...(publisherCloudflareToken === undefined ? {} : { publisherCloudflareToken }),
  };
}

export class HidReleaseTrustStack extends Stack {
  public readonly repositoryBucket: s3.Bucket;
  public readonly evidenceArchiveBucket: s3.Bucket;
  public readonly auditLogBucket: s3.Bucket;
  public readonly brokerImageRepository: ecr.Repository;
  public readonly snapshotSigningCandidates: readonly [kms.Key, kms.Key];
  public readonly timestampSigningCandidates: readonly [kms.Key, kms.Key];
  public readonly signingBroker?: TufSigningBroker;

  public constructor(scope: Construct, id: string, props: HidReleaseTrustStackProps) {
    const validated = validateProps(props);
    const {
      environmentName,
      approvedAccount,
      approvedRegion,
      githubOidcProviderArn,
      githubAudience,
      approvedGithubRepository: _approvedGithubRepository,
      approvedGithubRepositoryId,
      approvedGithubRepositoryOwnerId,
      approvedGithubRef,
      githubWorkflowRefs,
      githubProtectedEnvironmentSubjects,
      evidenceObjectLockMode,
      evidenceRetentionDays,
      acknowledgeObjectLockIsIrreversible: _acknowledgment,
      acknowledgeProductionSigningKeyCustodyApproved: _keyCustodyAcknowledgment,
      alarmNotificationTopicArn: _alarmNotificationTopicArn,
      signingBroker: _signingBroker,
      publisherCloudflareToken: _publisherCloudflareToken,
      ...stackProps
    } = props;

    super(scope, id, {
      ...stackProps,
      env: { account: approvedAccount, region: approvedRegion },
      terminationProtection: true,
    });

    for (const [key, value] of Object.entries({
      Project: 'HID',
      Environment: environmentName,
      Service: 'release-trust',
      ManagedBy: 'CDK',
    })) {
      Tags.of(this).add(key, value);
    }

    const repositoryEncryptionKey = this.storageKey('RepositoryEncryptionKey');
    const evidenceEncryptionKey = this.storageKey('EvidenceArchiveEncryptionKey');
    const auditEncryptionKey = this.storageKey('AuditLogEncryptionKey');
    const brokerImageEncryptionKey = this.storageKey('BrokerImageEncryptionKey');

    this.brokerImageRepository = new ecr.Repository(
      this,
      'BrokerImageRepository',
      {
        repositoryName: `hid-${environmentName}-tuf-signing-broker`,
        encryption: ecr.RepositoryEncryption.KMS,
        encryptionKey: brokerImageEncryptionKey,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        removalPolicy: RemovalPolicy.RETAIN,
      },
    );

    const defaultRetention =
      evidenceObjectLockMode === 'COMPLIANCE'
        ? s3.ObjectLockRetention.compliance(Duration.days(evidenceRetentionDays))
        : s3.ObjectLockRetention.governance(Duration.days(evidenceRetentionDays));
    const objectLockProps = {
      objectLockEnabled: true,
      objectLockDefaultRetention: defaultRetention,
    } as const;
    this.repositoryBucket = this.privateRetainedBucket(
      'ReleaseRepository',
      repositoryEncryptionKey,
      objectLockProps,
    );
    this.evidenceArchiveBucket = this.privateRetainedBucket(
      'EvidenceArchive',
      evidenceEncryptionKey,
      objectLockProps,
    );
    this.enforceKmsObjectUploads(this.repositoryBucket, repositoryEncryptionKey);
    this.enforceKmsObjectUploads(this.evidenceArchiveBucket, evidenceEncryptionKey);
    this.enforceMinimumObjectLockRetention(
      this.evidenceArchiveBucket,
      '*',
      // A 730-day bucket default must not override the immutable writers'
      // 729-day IAM floor for request-transit rounding.
      Math.min(evidenceRetentionDays, 729),
      'DenyEvidenceRetentionBelowEnvironmentMinimum',
    );
    this.enforceMinimumObjectLockRetention(
      this.evidenceArchiveBucket,
      'tuf-signing-broker/state/*',
      // The writer sets an exact 730-day lifetime; request transit can cross a
      // remaining-day boundary before S3 evaluates the retention condition.
      729,
      'DenyBrokerStateRetentionBelowTwoYears',
    );
    this.evidenceArchiveBucket.addToResourcePolicy(new iam.PolicyStatement({
      sid: 'DenyBrokerStateRetentionAboveTwoYears',
      effect: iam.Effect.DENY,
      principals: [new iam.AnyPrincipal()],
      actions: ['s3:PutObjectRetention'],
      resources: [this.evidenceArchiveBucket.arnForObjects('tuf-signing-broker/state/*')],
      conditions: { NumericGreaterThan: { 's3:object-lock-remaining-retention-days': '730' } },
    }));

    this.auditLogBucket = this.privateRetainedBucket(
      'AuditLogArchive',
      auditEncryptionKey,
      objectLockProps,
    );

    const auditTrailName = `hid-${environmentName}-release-trust-audit`;
    const auditTrailArn = this.formatArn({
      service: 'cloudtrail',
      resource: 'trail',
      resourceName: auditTrailName,
    });
    const auditTrailEncryptionContextArn =
      `arn:${this.partition}:cloudtrail:*:${this.account}:trail/${auditTrailName}`;
    let auditLogGroup: logs.LogGroup | undefined;
    if (validated.signingBroker !== undefined) {
      const auditLogGroupName = `/aws/cloudtrail/${auditTrailName}`;
      auditLogGroup = new logs.LogGroup(this, 'ReleaseTrustAuditLogGroup', {
        logGroupName: auditLogGroupName,
        encryptionKey: auditEncryptionKey,
        retention: logs.RetentionDays.TEN_YEARS,
        removalPolicy: RemovalPolicy.RETAIN,
      });
      this.authorizeCloudWatchLogsEncryption(
        auditEncryptionKey,
        this.formatArn({
          service: 'logs',
          resource: 'log-group',
          resourceName: auditLogGroupName,
          arnFormat: ArnFormat.COLON_RESOURCE_NAME,
        }),
        approvedAccount,
        approvedRegion,
      );
    }
    const auditTrail = new cloudtrail.Trail(this, 'ReleaseTrustAuditTrail', {
      bucket: this.auditLogBucket,
      encryptionKey: auditEncryptionKey,
      enableFileValidation: true,
      includeGlobalServiceEvents: true,
      isMultiRegionTrail: true,
      managementEvents: cloudtrail.ReadWriteType.ALL,
      trailName: auditTrailName,
      sendToCloudWatchLogs: auditLogGroup !== undefined,
      ...(auditLogGroup === undefined ? {} : { cloudWatchLogGroup: auditLogGroup }),
    });
    this.authorizeCloudTrailAuditArchive(
      this.auditLogBucket,
      auditEncryptionKey,
      auditTrailArn,
      auditTrailEncryptionContextArn,
    );
    auditTrail.addS3EventSelector(
      [{ bucket: this.repositoryBucket }, { bucket: this.evidenceArchiveBucket }],
      {
        includeManagementEvents: false,
        readWriteType: cloudtrail.ReadWriteType.ALL,
      },
    );

    this.snapshotSigningCandidates = [
      this.signingKey('SnapshotSigningCandidateOne'),
      this.signingKey('SnapshotSigningCandidateTwo'),
    ];
    this.timestampSigningCandidates = [
      this.signingKey('TimestampSigningCandidateOne'),
      this.signingKey('TimestampSigningCandidateTwo'),
    ];

    const oidcProvider = iam.OpenIdConnectProvider.fromOpenIdConnectProviderArn(
      this,
      'GitHubOidcProvider',
      githubOidcProviderArn,
    );
    const trustedGitHubPrincipal = (
      capability: ReleaseTrustCapability,
    ): iam.OpenIdConnectPrincipal =>
      new iam.OpenIdConnectPrincipal(oidcProvider, {
        StringEquals: {
          'token.actions.githubusercontent.com:aud': githubAudience,
          'token.actions.githubusercontent.com:sub':
            githubProtectedEnvironmentSubjects[capability],
          'token.actions.githubusercontent.com:repository': props.approvedGithubRepository,
          'token.actions.githubusercontent.com:repository_id': approvedGithubRepositoryId,
          'token.actions.githubusercontent.com:repository_owner_id': approvedGithubRepositoryOwnerId,
          'token.actions.githubusercontent.com:ref': approvedGithubRef,
          'token.actions.githubusercontent.com:environment':
            `${environmentName}-${capabilityEnvironmentLabels[capability]}`,
          'token.actions.githubusercontent.com:job_workflow_ref': githubWorkflowRefs[capability],
        },
      });
    const githubRole = (
      id: string,
      description: string,
      capability: ReleaseTrustCapability,
    ): iam.Role =>
      new iam.Role(this, id, {
        assumedBy: trustedGitHubPrincipal(capability),
        description,
        maxSessionDuration: Duration.hours(1),
      });

    const buildRole = githubRole(
      'BuildRole',
      `Build-only role for ${environmentName}; it cannot sign or publish`,
      'build',
    );
    this.brokerImageRepository.grantPullPush(buildRole);
    const publisherRole = githubRole(
      'PublisherRole',
      `TUF repository publisher for ${environmentName}; it cannot sign or write general evidence`,
      'publisher',
    );
    const evidenceWriterRole = githubRole(
      'EvidenceWriterRole',
      `Append-only release evidence writer for ${environmentName}`,
      'evidenceWriter',
    );
    const auditorRole = githubRole(
      'AuditorRole',
      `Read-only release trust auditor for ${environmentName}`,
      'auditor',
    );

    const signingKeys = [...this.snapshotSigningCandidates, ...this.timestampSigningCandidates];
    this.addPublicKeyRead(buildRole, signingKeys);
    this.addRepositoryPublisherAccess(publisherRole, repositoryEncryptionKey);
    this.addEvidenceWriterAccess(evidenceWriterRole, evidenceEncryptionKey);
    this.reserveBrokerNamespaceFromEvidenceWriter(evidenceWriterRole);
    this.addAuditorAccess(
      auditorRole,
      [
        {
          key: repositoryEncryptionKey,
          bucket: this.repositoryBucket,
          kmsConditions: this.s3EncryptionContext(this.repositoryBucket),
        },
        {
          key: evidenceEncryptionKey,
          bucket: this.evidenceArchiveBucket,
          kmsConditions: this.s3EncryptionContext(this.evidenceArchiveBucket),
        },
        {
          key: auditEncryptionKey,
          bucket: this.auditLogBucket,
          kmsConditions: this.cloudTrailDecryptionContext(
            auditTrailEncryptionContextArn,
          ),
        },
      ],
      signingKeys,
    );

    const signerRoles = [
      githubRole(
        'SnapshotSignerOneRole',
        `Snapshot signing-request submitter for candidate one in ${environmentName}; it cannot call KMS Sign directly`,
        'snapshotSignerOne',
      ),
      githubRole(
        'SnapshotSignerTwoRole',
        `Snapshot signing-request submitter for candidate two in ${environmentName}; it cannot call KMS Sign directly`,
        'snapshotSignerTwo',
      ),
      githubRole(
        'TimestampSignerOneRole',
        `Timestamp signing-request submitter for candidate one in ${environmentName}; it cannot call KMS Sign directly`,
        'timestampSignerOne',
      ),
      githubRole(
        'TimestampSignerTwoRole',
        `Timestamp signing-request submitter for candidate two in ${environmentName}; it cannot call KMS Sign directly`,
        'timestampSignerTwo',
      ),
    ];
    for (const [index, role] of signerRoles.entries()) {
      const signingKey = signingKeys[index];
      if (signingKey === undefined) {
        throw new Error('Each signer role must have exactly one signing candidate');
      }
      // GitHub-hosted workflow code must never receive an identity that can
      // invoke KMS Sign. Once all immutable broker pins are supplied, these
      // roles may submit only candidate-specific immutable requests and invoke
      // one exact Lambda version. Public-key inspection proves which candidate
      // a protected job intends to request while the unconfigured path remains
      // fail closed.
      this.addPublicKeyRead(role, [signingKey]);
    }

    if (validated.signingBroker !== undefined) {
      if (auditLogGroup === undefined) {
        throw new Error('Signing broker audit log group was not created');
      }
      if (validated.alarmNotificationTopicArn === undefined) {
        throw new Error('Signing broker alarm notification topic was not validated');
      }
      const alarmTopic = sns.Topic.fromTopicArn(
        this,
        'ReleaseTrustAlarmTopic',
        validated.alarmNotificationTopicArn,
      );
      const [snapshotOneKey, snapshotTwoKey] = this.snapshotSigningCandidates;
      const [timestampOneKey, timestampTwoKey] = this.timestampSigningCandidates;
      const [snapshotOneRole, snapshotTwoRole, timestampOneRole, timestampTwoRole] = signerRoles;
      if (
        snapshotOneRole === undefined || snapshotTwoRole === undefined ||
        timestampOneRole === undefined || timestampTwoRole === undefined
      ) {
        throw new Error('Signing broker requires all four request submitter roles');
      }
      this.signingBroker = new TufSigningBroker(this, 'TufSigningBroker', {
        environmentName,
        approvedAccount,
        approvedRegion,
        config: validated.signingBroker,
        imageRepository: this.brokerImageRepository,
        evidenceBucket: this.evidenceArchiveBucket,
        evidenceEncryptionKey,
        evidenceObjectLockMode,
        evidenceRetentionDays,
        auditTrail,
        auditLogGroup,
        alarmTopic,
        publisherRole,
        signingCandidates: [
          { name: 'snapshotOne', role: 'snapshot', ordinal: 'one', signingKey: snapshotOneKey, requestSubmitterRole: snapshotOneRole },
          { name: 'snapshotTwo', role: 'snapshot', ordinal: 'two', signingKey: snapshotTwoKey, requestSubmitterRole: snapshotTwoRole },
          { name: 'timestampOne', role: 'timestamp', ordinal: 'one', signingKey: timestampOneKey, requestSubmitterRole: timestampOneRole },
          { name: 'timestampTwo', role: 'timestamp', ordinal: 'two', signingKey: timestampTwoKey, requestSubmitterRole: timestampTwoRole },
        ],
      });
      this.authorizePublisherCloudflareToken(publisherRole, validated.publisherCloudflareToken);
    }

    new CfnOutput(this, 'ReleaseRepositoryBucketName', {
      value: this.repositoryBucket.bucketName,
    });
    new CfnOutput(this, 'EvidenceArchiveBucketName', {
      value: this.evidenceArchiveBucket.bucketName,
    });
    new CfnOutput(this, 'BrokerImageRepositoryUri', {
      value: this.brokerImageRepository.repositoryUri,
    });
    new CfnOutput(this, 'AuditTrailArn', { value: auditTrail.trailArn });
    for (const [name, role] of Object.entries({
      BuildRole: buildRole,
      PublisherRole: publisherRole,
      EvidenceWriterRole: evidenceWriterRole,
      AuditorRole: auditorRole,
    })) {
      new CfnOutput(this, `${name}Arn`, { value: role.roleArn });
    }
    for (const [index, role] of signerRoles.entries()) {
      const signingKey = signingKeys[index];
      if (signingKey !== undefined) {
        new CfnOutput(this, `SigningRequestSubmitterCandidate${index + 1}RoleArn`, {
          value: role.roleArn,
        });
        new CfnOutput(this, `SignerCandidate${index + 1}KeyArn`, { value: signingKey.keyArn });
      }
    }
  }

  private storageKey(id: string): kms.Key {
    return new kms.Key(this, id, {
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  private authorizePublisherCloudflareToken(
    publisherRole: iam.Role,
    token: PublisherCloudflareToken | undefined,
  ): void {
    if (token === undefined) return;
    // Import only the reviewed ARN/version as policy data. Never resolve a
    // dynamic reference: CloudFormation and build jobs must not receive values.
    publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PublisherReadExactCloudflareTokenVersion',
      actions: ['secretsmanager:GetSecretValue'],
      resources: [token.secretArn],
      conditions: { StringEquals: { 'secretsmanager:VersionId': token.versionId } },
    }));
    if (token.encryptionKeyArn !== undefined) {
      publisherRole.addToPrincipalPolicy(new iam.PolicyStatement({
        sid: 'PublisherDecryptExactCloudflareTokenThroughSecretsManager',
        actions: ['kms:Decrypt'],
        resources: [token.encryptionKeyArn],
        conditions: {
          StringEquals: {
            'kms:CallerAccount': this.account,
            'kms:ViaService': `secretsmanager.${this.region}.amazonaws.com`,
            'kms:EncryptionContext:SecretARN': token.secretArn,
          },
        },
      }));
    }
    new CfnOutput(this, 'PublisherCloudflareTokenConfiguration', {
      description: 'Value-free existing secret pins; only the immutable protected publisher may retrieve this version',
      value: JSON.stringify({ secret_arn: token.secretArn, version_id: token.versionId }),
    });
  }

  private signingKey(id: string): kms.Key {
    return new kms.Key(this, id, {
      keySpec: kms.KeySpec.ECC_NIST_P256,
      keyUsage: kms.KeyUsage.SIGN_VERIFY,
      removalPolicy: RemovalPolicy.RETAIN,
    });
  }

  private authorizeCloudWatchLogsEncryption(
    encryptionKey: kms.Key,
    logGroupArn: string,
    account: string,
    region: string,
  ): void {
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
          StringEquals: {
            'kms:CallerAccount': account,
            'kms:EncryptionContext:aws:logs:arn': logGroupArn,
          },
        },
      }),
    );
  }

  private privateRetainedBucket(
    id: string,
    encryptionKey: kms.IKey,
    additionalProps: Pick<s3.BucketProps, 'objectLockEnabled' | 'objectLockDefaultRetention'> = {},
  ): s3.Bucket {
    return new s3.Bucket(this, id, {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey,
      bucketKeyEnabled: false,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      removalPolicy: RemovalPolicy.RETAIN,
      versioned: true,
      ...additionalProps,
    });
  }

  private enforceKmsObjectUploads(bucket: s3.Bucket, encryptionKey: kms.IKey): void {
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyUploadsWithoutKmsEncryption',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('*')],
        conditions: {
          StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
        },
      }),
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyUploadsWithWrongKmsKey',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObject'],
        resources: [bucket.arnForObjects('*')],
        conditions: {
          StringNotEquals: {
            's3:x-amz-server-side-encryption-aws-kms-key-id': encryptionKey.keyArn,
          },
        },
      }),
    );
  }

  private enforceMinimumObjectLockRetention(
    bucket: s3.Bucket,
    objectPattern: string,
    minimumDays: number,
    sid: string,
  ): void {
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid,
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:PutObjectRetention'],
        resources: [bucket.arnForObjects(objectPattern)],
        conditions: {
          NumericLessThan: {
            's3:object-lock-remaining-retention-days': String(minimumDays),
          },
        },
      }),
    );
  }

  private authorizeCloudTrailAuditArchive(
    bucket: s3.Bucket,
    encryptionKey: kms.Key,
    auditTrailArn: string,
    auditTrailEncryptionContextArn: string,
  ): void {
    const cloudTrailPrincipal = new iam.ServicePrincipal('cloudtrail.amazonaws.com');
    const cloudTrailObjects = bucket.arnForObjects(`AWSLogs/${this.account}/*`);

    // The L2 Trail adds service-principal allows without a source constraint.
    // These explicit denies make those generated allows usable only by this
    // environment's named trail; the exact allows document the intended path.
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyCloudTrailAclCheckFromUnexpectedTrail',
        effect: iam.Effect.DENY,
        principals: [cloudTrailPrincipal],
        actions: ['s3:GetBucketAcl'],
        resources: [bucket.bucketArn],
        conditions: {
          StringNotEquals: { 'aws:SourceArn': auditTrailArn },
        },
      }),
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyCloudTrailWriteFromUnexpectedTrail',
        effect: iam.Effect.DENY,
        principals: [cloudTrailPrincipal],
        actions: ['s3:PutObject'],
        resources: [cloudTrailObjects],
        conditions: {
          StringNotEquals: { 'aws:SourceArn': auditTrailArn },
        },
      }),
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowExactCloudTrailAclCheck',
        principals: [cloudTrailPrincipal],
        actions: ['s3:GetBucketAcl'],
        resources: [bucket.bucketArn],
        conditions: {
          StringEquals: { 'aws:SourceArn': auditTrailArn },
        },
      }),
    );
    bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowExactCloudTrailWrite',
        principals: [cloudTrailPrincipal],
        actions: ['s3:PutObject'],
        resources: [cloudTrailObjects],
        conditions: {
          StringEquals: {
            'aws:SourceArn': auditTrailArn,
            's3:x-amz-acl': 'bucket-owner-full-control',
          },
        },
      }),
    );

    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowExactCloudTrailEncrypt',
        principals: [cloudTrailPrincipal],
        actions: ['kms:GenerateDataKey*'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:SourceArn': auditTrailArn },
          StringLike: {
            'kms:EncryptionContext:aws:cloudtrail:arn':
              auditTrailEncryptionContextArn,
          },
        },
      }),
    );
    encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowExactCloudTrailDescribeKey',
        principals: [cloudTrailPrincipal],
        actions: ['kms:DescribeKey'],
        resources: ['*'],
        conditions: {
          StringEquals: { 'aws:SourceArn': auditTrailArn },
        },
      }),
    );
  }

  private addPublicKeyRead(role: iam.Role, signingKeys: readonly kms.IKey[]): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadSigningPublicKeys',
        actions: ['kms:DescribeKey', 'kms:GetPublicKey'],
        resources: signingKeys.map((key) => key.keyArn),
      }),
    );
  }

  private addRepositoryPublisherAccess(role: iam.Role, encryptionKey: kms.IKey): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'InspectReleaseRepository',
        actions: ['s3:GetBucketLocation', 's3:GetBucketVersioning', 's3:ListBucket'],
        resources: [this.repositoryBucket.bucketArn],
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'PublishWithoutDelete',
        actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
        resources: [this.repositoryBucket.arnForObjects('*')],
      }),
    );
    this.addS3KeyAccess(role, encryptionKey, this.repositoryBucket, true);
  }

  private addEvidenceWriterAccess(role: iam.Role, encryptionKey: kms.IKey): void {
    const releaseEvidenceObjects = this.evidenceArchiveBucket.arnForObjects(
      'release-evidence/*',
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'InspectEvidenceRetention',
        actions: ['s3:GetBucketObjectLockConfiguration', 's3:GetBucketVersioning'],
        resources: [this.evidenceArchiveBucket.bucketArn],
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'AppendEvidenceWithoutDelete',
        actions: ['s3:PutObject'],
        resources: [releaseEvidenceObjects],
      }),
    );
    this.addS3KeyAccess(
      role,
      encryptionKey,
      this.evidenceArchiveBucket,
      false,
      'release-evidence/*',
    );
  }

  private reserveBrokerNamespaceFromEvidenceWriter(role: iam.Role): void {
    this.evidenceArchiveBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'DenyGeneralEvidenceWriterInBrokerNamespace',
        effect: iam.Effect.DENY,
        principals: [role],
        actions: ['s3:PutObject', 's3:PutObjectRetention'],
        resources: [
          this.evidenceArchiveBucket.arnForObjects('tuf-signing-broker/*'),
        ],
      }),
    );
  }

  private addAuditorAccess(
    role: iam.Role,
    storageBoundaries: readonly {
      readonly key: kms.IKey;
      readonly bucket: s3.IBucket;
      readonly kmsConditions: Record<string, Record<string, string>>;
    }[],
    signingKeys: readonly kms.IKey[],
  ): void {
    const buckets = [this.repositoryBucket, this.evidenceArchiveBucket, this.auditLogBucket];
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ListReleaseTrustArchives',
        actions: [
          's3:GetBucketLocation',
          's3:GetBucketObjectLockConfiguration',
          's3:GetBucketVersioning',
          's3:ListBucket',
          's3:ListBucketVersions',
        ],
        resources: buckets.map((bucket) => bucket.bucketArn),
      }),
    );
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'ReadReleaseTrustArchives',
        actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetObjectRetention'],
        resources: buckets.map((bucket) => bucket.arnForObjects('*')),
      }),
    );
    for (const [index, boundary] of storageBoundaries.entries()) {
      role.addToPrincipalPolicy(
        new iam.PolicyStatement({
          sid: `DecryptReleaseTrustArchive${index + 1}`,
          actions: ['kms:Decrypt'],
          resources: [boundary.key.keyArn],
          conditions: boundary.kmsConditions,
        }),
      );
    }
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: 'DescribeStorageKeys',
        actions: ['kms:DescribeKey'],
        resources: storageBoundaries.map(({ key }) => key.keyArn),
      }),
    );
    this.addPublicKeyRead(role, signingKeys);
  }

  private addS3KeyAccess(
    role: iam.Role,
    encryptionKey: kms.IKey,
    bucket: s3.IBucket,
    allowDecrypt: boolean,
    objectPattern = '*',
  ): void {
    role.addToPrincipalPolicy(
      new iam.PolicyStatement({
        sid: allowDecrypt ? 'UseRepositoryEncryptionKey' : 'EncryptEvidenceOnly',
        actions: [
          'kms:GenerateDataKey',
          ...(allowDecrypt ? ['kms:Decrypt'] : []),
        ],
        resources: [encryptionKey.keyArn],
        conditions: this.s3EncryptionContext(bucket, objectPattern),
      }),
    );
  }

  private s3EncryptionContext(
    bucket: s3.IBucket,
    objectPattern = '*',
  ): Record<string, Record<string, string>> {
    return {
      StringEquals: {
        'kms:CallerAccount': this.account,
        'kms:ViaService': `s3.${this.region}.amazonaws.com`,
      },
      ArnLike: {
        'kms:EncryptionContext:aws:s3:arn': bucket.arnForObjects(objectPattern),
      },
    };
  }

  private cloudTrailDecryptionContext(
    auditTrailEncryptionContextArn: string,
  ): Record<string, Record<string, string>> {
    return {
      StringEquals: {
        'kms:CallerAccount': this.account,
        'kms:ViaService': `s3.${this.region}.amazonaws.com`,
      },
      ArnLike: {
        'kms:EncryptionContext:aws:cloudtrail:arn': auditTrailEncryptionContextArn,
      },
    };
  }
}
