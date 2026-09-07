import assert from 'node:assert/strict';
import test from 'node:test';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import {
  HidReleaseTrustStack,
  capabilityWorkflowNames,
  releaseTrustCapabilities,
  type GitHubImmutableWorkflowRefs,
  type GitHubProtectedEnvironmentSubjects,
  type HidReleaseTrustStackProps,
  type ReleaseTrustCapability,
  type ReleaseTrustEnvironment,
} from '../src/hid-release-trust-stack.js';
import type { TufSigningBrokerConfig } from '../src/tuf-signing-broker.js';

interface Resource {
  readonly Type: string;
  readonly Properties?: Record<string, unknown>;
  readonly DeletionPolicy?: string;
  readonly UpdateReplacePolicy?: string;
}

interface SynthesizedTemplate {
  readonly Resources: Record<string, Resource>;
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

function protectedEnvironmentSubjects(
  environmentName: ReleaseTrustEnvironment,
  repository = 'D-Eminence/hid-system',
): GitHubProtectedEnvironmentSubjects {
  return Object.fromEntries(
    releaseTrustCapabilities.map((capability) => [
      capability,
      `repo:${repository}:environment:${environmentName}-${capabilityEnvironmentLabels[capability]}`,
    ]),
  ) as unknown as GitHubProtectedEnvironmentSubjects;
}

const baseProps: HidReleaseTrustStackProps = {
  environmentName: 'production',
  approvedAccount: '111122223333',
  approvedRegion: 'eu-west-1',
  githubOidcProviderArn:
    'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com',
  githubAudience: 'sts.amazonaws.com',
  approvedGithubRepository: 'D-Eminence/hid-system',
  approvedGithubRepositoryId: '12345678',
  approvedGithubRepositoryOwnerId: '87654321',
  approvedGithubRef: 'refs/heads/main',
  githubWorkflowRefs: Object.fromEntries(releaseTrustCapabilities.map((capability) => [
    capability,
    `D-Eminence/hid-system/.github/workflows/${capabilityWorkflowNames[capability]}@${'a'.repeat(40)}`,
  ])) as unknown as GitHubImmutableWorkflowRefs,
  githubProtectedEnvironmentSubjects: protectedEnvironmentSubjects('production'),
  evidenceObjectLockMode: 'COMPLIANCE',
  evidenceRetentionDays: 365,
  acknowledgeObjectLockIsIrreversible: true,
  acknowledgeProductionSigningKeyCustodyApproved: true,
  alarmNotificationTopicArn:
    'arn:aws:sns:eu-west-1:111122223333:hid-production-release-trust-alerts',
};

const signingBrokerConfig: TufSigningBrokerConfig = {
  repositoryId: 'hid-production-v1',
  stateId: 'hid-production-broker-v1',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  publicRepositoryUrl: 'https://updates.healthidentitydirectory.com/',
  bootstrapRootSha256: 'b'.repeat(64),
  bootstrapRootObjectVersionId: 'bootstrap-root-version-1',
  candidatePublicKeySpkiSha256: {
    snapshotOne: 'c'.repeat(64),
    snapshotTwo: 'd'.repeat(64),
    timestampOne: 'e'.repeat(64),
    timestampTwo: 'f'.repeat(64),
  },
  acknowledgeCeremonyApprovedImmutablePins: true,
};

const exactBrokerFunctionArns = [
  'arn:aws:lambda:eu-west-1:111122223333:function:hid-production-tuf-broker-snapshot-one',
  'arn:aws:lambda:eu-west-1:111122223333:function:hid-production-tuf-broker-snapshot-two',
  'arn:aws:lambda:eu-west-1:111122223333:function:hid-production-tuf-broker-timestamp-one',
  'arn:aws:lambda:eu-west-1:111122223333:function:hid-production-tuf-broker-timestamp-two',
  'arn:aws:lambda:eu-west-1:111122223333:function:hid-production-tuf-broker-checkpoint',
] as const;

function synthesize(
  overrides: Partial<HidReleaseTrustStackProps> = {},
): { readonly stack: HidReleaseTrustStack; readonly template: SynthesizedTemplate } {
  const app = new App();
  const stack = new HidReleaseTrustStack(app, 'ReleaseTrustTest', {
    ...baseProps,
    ...overrides,
  });
  const template = Template.fromStack(stack).toJSON() as SynthesizedTemplate;
  return { stack, template };
}

function resources(
  template: SynthesizedTemplate,
  type: string,
): Array<[string, Resource]> {
  return Object.entries(template.Resources).filter(([, resource]) => resource.Type === type);
}

function properties(
  template: SynthesizedTemplate,
  type: string,
): Array<Record<string, unknown>> {
  return resources(template, type).map(([, resource]) => resource.Properties ?? {});
}

function statementsFromDocument(document: unknown): Array<Record<string, unknown>> {
  if (document === null || typeof document !== 'object') {
    return [];
  }
  const statements = (document as { readonly Statement?: unknown }).Statement;
  if (statements === undefined) {
    return [];
  }
  return Array.isArray(statements)
    ? (statements as Array<Record<string, unknown>>)
    : [statements as Record<string, unknown>];
}

function policyStatements(policy: Record<string, unknown>): Array<Record<string, unknown>> {
  return statementsFromDocument(policy.PolicyDocument);
}

function iamStatements(template: SynthesizedTemplate): Array<Record<string, unknown>> {
  return properties(template, 'AWS::IAM::Policy').flatMap(policyStatements);
}

function actionList(statement: Record<string, unknown>): string[] {
  return Array.isArray(statement.Action)
    ? statement.Action.map(String)
    : statement.Action === undefined
      ? []
      : [String(statement.Action)];
}

function valueList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function literalArn(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const join = (value as { readonly 'Fn::Join'?: unknown })?.['Fn::Join'];
  assert.ok(Array.isArray(join) && join.length === 2, 'ARN is not a literal partition join');
  const [separator, rawParts] = join;
  assert.equal(typeof separator, 'string');
  assert.ok(Array.isArray(rawParts));
  return rawParts
    .map((part) => {
      if (typeof part === 'string') {
        return part;
      }
      assert.deepEqual(part, { Ref: 'AWS::Partition' });
      return 'aws';
    })
    .join(separator);
}

function roleByDescription(
  template: SynthesizedTemplate,
  descriptionFragment: string,
): readonly [string, Resource] {
  const role = resources(template, 'AWS::IAM::Role').find(([, resource]) =>
    String(resource.Properties?.Description ?? '').includes(descriptionFragment),
  );
  assert.ok(role, `missing role with description containing ${descriptionFragment}`);
  return role;
}

function policyForRoleDescription(
  template: SynthesizedTemplate,
  descriptionFragment: string,
): Record<string, unknown> {
  const [roleLogicalId] = roleByDescription(template, descriptionFragment);
  const policy = properties(template, 'AWS::IAM::Policy').find((candidate) =>
    JSON.stringify(candidate.Roles).includes(roleLogicalId),
  );
  assert.ok(policy, `missing policy for ${descriptionFragment}`);
  return policy;
}

function bucketPolicyStatements(
  template: SynthesizedTemplate,
  logicalIdFragment: string,
): Array<Record<string, unknown>> {
  const policy = resources(template, 'AWS::S3::BucketPolicy').find(([logicalId]) =>
    logicalId.includes(logicalIdFragment),
  );
  assert.ok(policy, `missing bucket policy containing ${logicalIdFragment}`);
  return statementsFromDocument(policy[1].Properties?.PolicyDocument);
}

function statementBySid(
  statements: readonly Record<string, unknown>[],
  sid: string,
): Record<string, unknown> {
  const statement = statements.find((candidate) => candidate.Sid === sid);
  assert.ok(statement, `missing statement ${sid}`);
  return statement;
}

test('each release capability trusts one exact environment-bound GitHub subject', () => {
  const { stack, template } = synthesize();
  assert.equal(stack.account, baseProps.approvedAccount);
  assert.equal(stack.region, baseProps.approvedRegion);

  const roleCapabilities: ReadonlyArray<readonly [string, ReleaseTrustCapability]> = [
    ['Build-only role', 'build'],
    ['repository publisher', 'publisher'],
    ['Append-only', 'evidenceWriter'],
    ['Read-only release trust auditor', 'auditor'],
    ['Snapshot signing-request submitter for candidate one', 'snapshotSignerOne'],
    ['Snapshot signing-request submitter for candidate two', 'snapshotSignerTwo'],
    ['Timestamp signing-request submitter for candidate one', 'timestampSignerOne'],
    ['Timestamp signing-request submitter for candidate two', 'timestampSignerTwo'],
  ];
  assert.equal(properties(template, 'AWS::IAM::Role').length, roleCapabilities.length);

  const trustedSubjects = new Set<string>();
  for (const [description, capability] of roleCapabilities) {
    const [, role] = roleByDescription(template, description);
    const assumeRolePolicy = role.Properties?.AssumeRolePolicyDocument as {
      readonly Statement: Array<Record<string, unknown>>;
    };
    assert.equal(assumeRolePolicy.Statement.length, 1);
    const [statement] = assumeRolePolicy.Statement;
    assert.ok(statement);
    assert.equal(statement.Action, 'sts:AssumeRoleWithWebIdentity');
    assert.equal(statement.Effect, 'Allow');
    assert.deepEqual(statement.Principal, {
      Federated: baseProps.githubOidcProviderArn,
    });
    assert.deepEqual(statement.Condition, {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': baseProps.githubAudience,
        'token.actions.githubusercontent.com:sub':
          baseProps.githubProtectedEnvironmentSubjects[capability],
        'token.actions.githubusercontent.com:repository': baseProps.approvedGithubRepository,
        'token.actions.githubusercontent.com:repository_id': baseProps.approvedGithubRepositoryId,
        'token.actions.githubusercontent.com:repository_owner_id': baseProps.approvedGithubRepositoryOwnerId,
        'token.actions.githubusercontent.com:ref': baseProps.approvedGithubRef,
        'token.actions.githubusercontent.com:environment': `production-${capabilityEnvironmentLabels[capability]}`,
        'token.actions.githubusercontent.com:job_workflow_ref': baseProps.githubWorkflowRefs[capability],
      },
    });
    assert.doesNotMatch(JSON.stringify(statement.Condition), /[*?]/u);
    trustedSubjects.add(baseProps.githubProtectedEnvironmentSubjects[capability]);
  }
  assert.equal(trustedSubjects.size, releaseTrustCapabilities.length);
});

test('ambiguous identity, cross-environment subjects, and weak retention fail closed', () => {
  assert.throws(
    () => synthesize({ approvedAccount: '1234' }),
    /exact 12-digit AWS account ID/u,
  );
  assert.throws(
    () => synthesize({ approvedRegion: 'EU-WEST-1' }),
    /exact AWS region/u,
  );
  assert.throws(
    () =>
      synthesize({
        githubOidcProviderArn:
          'arn:aws:iam::999900001111:oidc-provider/token.actions.githubusercontent.com',
      }),
    /approvedAccount/u,
  );
  assert.throws(
    () => synthesize({ githubAudience: '*' }),
    /exact, non-wildcard audience/u,
  );
  assert.throws(
    () => synthesize({ approvedGithubRepository: 'D-Eminence/*' }),
    /exact owner\/repository name/u,
  );

  const missingCapability = {
    ...baseProps.githubProtectedEnvironmentSubjects,
  } as Partial<Record<ReleaseTrustCapability, string>>;
  delete missingCapability.publisher;
  assert.throws(
    () =>
      synthesize({
        githubProtectedEnvironmentSubjects:
          missingCapability as GitHubProtectedEnvironmentSubjects,
      }),
    /exactly every release capability/u,
  );

  const refSubject = {
    ...baseProps.githubProtectedEnvironmentSubjects,
    publisher: 'repo:D-Eminence/hid-system:ref:refs/heads/main',
  };
  assert.throws(
    () => synthesize({ githubProtectedEnvironmentSubjects: refSubject }),
    /production-publisher protected-environment subject/u,
  );

  const stagingSubject = {
    ...baseProps.githubProtectedEnvironmentSubjects,
    publisher:
      'repo:D-Eminence/hid-system:environment:staging-publisher',
  };
  assert.throws(
    () => synthesize({ githubProtectedEnvironmentSubjects: stagingSubject }),
    /production-publisher protected-environment subject/u,
  );

  const otherRepository = {
    ...baseProps.githubProtectedEnvironmentSubjects,
    publisher: 'repo:someone-else/hid-system:environment:production-publisher',
  };
  assert.throws(
    () => synthesize({ githubProtectedEnvironmentSubjects: otherRepository }),
    /approvedGithubRepository/u,
  );

  assert.throws(
    () => synthesize({ evidenceRetentionDays: 179 }),
    /from 180 through 730 for production/u,
  );
  assert.throws(
    () =>
      synthesize({
        environmentName: 'staging',
        githubProtectedEnvironmentSubjects: protectedEnvironmentSubjects('staging'),
        evidenceRetentionDays: 89,
      }),
    /from 90 through 730 for staging/u,
  );
  assert.throws(
    () => synthesize({ evidenceRetentionDays: 365.5 }),
    /must be an integer/u,
  );
  assert.doesNotThrow(() => synthesize({ evidenceRetentionDays: 730 }));
  assert.throws(
    () => synthesize({ evidenceRetentionDays: 731 }),
    /from 180 through 730 for production/u,
  );
  assert.throws(
    () => synthesize({ evidenceObjectLockMode: 'GOVERNANCE' }),
    /production evidenceObjectLockMode must be COMPLIANCE/u,
  );
  assert.throws(
    () =>
      synthesize({
        acknowledgeObjectLockIsIrreversible: false as unknown as true,
      }),
    /must be true/u,
  );
  assert.throws(
    () => synthesize({
      acknowledgeProductionSigningKeyCustodyApproved:
        false as unknown as true,
    }),
    /must be true before production signing keys are created/u,
  );
});

test('immutable workflow trust excludes direct developers, tags, PRs, transfers and capability reuse', () => {
  const { template } = synthesize();
  const [, role] = roleByDescription(template, 'repository publisher');
  const statement = statementsFromDocument(role.Properties?.AssumeRolePolicyDocument)[0];
  assert.ok(statement);
  const conditions = (statement.Condition as { StringEquals: Record<string, string> }).StringEquals;
  const allows = (claims: Record<string, string>) => Object.entries(conditions).every(([key, expected]) => claims[key] === expected);
  assert.equal(allows({ ...conditions }), true);
  assert.equal(allows({}), false, 'ordinary developer credentials are not web identity claims');
  for (const [key, value] of Object.entries({
    'ref': 'refs/tags/v1.0.0',
    'job_workflow_ref': 'D-Eminence/hid-system/.github/workflows/developer.yml@' + 'a'.repeat(40),
    'repository_id': '999999', 'repository_owner_id': '999999',
    'environment': 'production-build', 'sub': 'repo:D-Eminence/hid-system:pull_request',
    'repository': 'attacker/hid-system', 'aud': 'another-service',
  })) {
    assert.equal(allows({ ...conditions, [`token.actions.githubusercontent.com:${key}`]: value }), false, key);
  }
  for (const invalid of ['', '*', 'refs/heads/main', 'a'.repeat(39), 'A'.repeat(40)]) {
    assert.throws(() => synthesize({ githubWorkflowRefs: { ...baseProps.githubWorkflowRefs, publisher: `D-Eminence/hid-system/.github/workflows/tuf-publish.yml@${invalid}` } }));
  }
  for (const invalid of ['', '0', '01', '*', 'id-name']) assert.throws(() => synthesize({ approvedGithubRepositoryId: invalid }));
  for (const invalid of ['refs/tags/v1', 'refs/pull/1/merge', 'refs/heads/*', 'refs/heads/a..b']) assert.throws(() => synthesize({ approvedGithubRef: invalid }));
  const subjects = Object.fromEntries(releaseTrustCapabilities.map((capability) => [capability,
    baseProps.githubProtectedEnvironmentSubjects[capability].replace('D-Eminence/hid-system', 'D-Eminence@87654321/hid-system@12345678'),
  ])) as unknown as GitHubProtectedEnvironmentSubjects;
  assert.doesNotThrow(() => synthesize({ githubProtectedEnvironmentSubjects: subjects }));
  assert.throws(() => synthesize({ githubProtectedEnvironmentSubjects: { ...subjects, publisher: subjects.publisher.replace('@12345678', '@99999999') } }));
});

test('publication history reuses existing storage with conditional writes and no deletion or checkpoint authority', () => {
  const { stack, template } = synthesize({ signingBroker: signingBrokerConfig });
  assert.equal(properties(template, 'AWS::DynamoDB::Table').length, 1);
  const publisher = policyStatements(policyForRoleDescription(template, 'repository publisher'));
  const append = statementBySid(publisher, 'PublicationJournalAppendConditionalLockedSlots');
  assert.deepEqual(append.Condition, { StringEquals: { 's3:if-none-match': '*', 's3:object-lock-mode': 'COMPLIANCE' }, Null: { 's3:object-lock-retain-until-date': 'false' } });
  assert.match(JSON.stringify(append.Resource), /tuf-publication-journal\/hid-production-publication-v1/u);
  const versions = statementBySid(publisher, 'PublicationJournalInspectOnlyExactSlotVersions');
  assert.deepEqual(actionList(versions), ['s3:ListBucketVersions']);
  assert.deepEqual((versions.Condition as Record<string, unknown>).NumericEquals, { 's3:max-keys': '2' });
  const retention = statementBySid(publisher, 'PublicationJournalRequireExactLongTermRetention');
  assert.deepEqual(actionList(retention), ['s3:PutObjectRetention']);
  assert.deepEqual(retention.Condition, {
    StringEquals: { 's3:object-lock-mode': 'COMPLIANCE' },
    NumericGreaterThanEquals: { 's3:object-lock-remaining-retention-days': '729' },
    NumericLessThanEquals: { 's3:object-lock-remaining-retention-days': '730' },
  });
  const journalOutputs = Object.values(Template.fromStack(stack).findOutputs('*'))
    .filter((output) => output.Description === 'Separate append-only publication lineage in existing broker storage; no checkpoint mutation authority');
  assert.equal(journalOutputs.length, 1);
  const journalOutput = journalOutputs[0]?.Value as { 'Fn::Join': [string, unknown[]] };
  const publicJournalConfiguration = JSON.parse(journalOutput['Fn::Join'][1]
    .filter((part) => typeof part === 'string').join('')) as { retention_days: number };
  assert.equal(publicJournalConfiguration.retention_days, 730);
  const bucketPolicy = bucketPolicyStatements(template, 'EvidenceArchivePolicy');
  for (const sid of ['DenyPublicationJournalWritesFromEveryOtherPrincipal', 'DenyPublicationJournalDeletionAndRetentionBypass',
    'DenyPublicationJournalNonConditionalWrites', 'DenyPublicationJournalMissingExplicitRetention', 'DenyPublicationJournalWrongRetentionMode',
    'DenyPublicationJournalRetentionBelowTwoYears', 'DenyPublicationJournalRetentionAboveTwoYears']) {
    const deny = statementBySid(bucketPolicy, sid);
    assert.equal(deny.Effect, 'Deny');
    assert.deepEqual(deny.Principal, { AWS: '*' });
  }
  assert.deepEqual(statementBySid(bucketPolicy, 'DenyPublicationJournalRetentionBelowTwoYears').Condition, {
    NumericLessThan: { 's3:object-lock-remaining-retention-days': '729' },
  });
  assert.deepEqual(statementBySid(bucketPolicy, 'DenyPublicationJournalRetentionAboveTwoYears').Condition, {
    NumericGreaterThan: { 's3:object-lock-remaining-retention-days': '730' },
  });
  assert.deepEqual(actionList(statementBySid(bucketPolicy, 'DenyPublicationJournalDeletionAndRetentionBypass')).sort(), ['s3:BypassGovernanceRetention', 's3:DeleteObject', 's3:DeleteObjectVersion']);
  const table = properties(template, 'AWS::DynamoDB::Table')[0];
  const resourcePolicy = statementsFromDocument((table?.ResourcePolicy as { PolicyDocument: unknown }).PolicyDocument);
  const denied = statementBySid(resourcePolicy, 'DenyPublicationJournalUpdateFromEveryOtherPrincipal');
  assert.deepEqual((denied.Condition as Record<string, unknown>)['ForAnyValue:StringEquals'], { 'dynamodb:LeadingKeys': ['hid-production-publication-v1'] });
  const checkpointDeny = statementBySid(resourcePolicy, 'DenyStateUpdateFromEveryOtherPrincipal');
  assert.deepEqual((checkpointDeny.Condition as Record<string, unknown>)['ForAnyValue:StringEquals'], { 'dynamodb:LeadingKeys': ['hid-production-broker-v1'] });
  assert.doesNotMatch(JSON.stringify((checkpointDeny.Condition as Record<string, unknown>).ArnNotEquals), /PublisherRole/u);
  for (const description of ['Build-only role', 'Append-only', 'Snapshot signing-request submitter for candidate one']) {
    const policy = policyStatements(policyForRoleDescription(template, description));
    assert.doesNotMatch(JSON.stringify(policy.filter((entry) => entry.Effect === 'Allow')), /tuf-publication-journal/u);
  }
});

test('a 730-day bucket default preserves the immutable writer request-transit allowance', () => {
  const { template } = synthesize({ signingBroker: signingBrokerConfig, evidenceRetentionDays: 730 });
  const bucketPolicy = bucketPolicyStatements(template, 'EvidenceArchivePolicy');
  assert.deepEqual(statementBySid(bucketPolicy, 'DenyEvidenceRetentionBelowEnvironmentMinimum').Condition, {
    NumericLessThan: { 's3:object-lock-remaining-retention-days': '729' },
  });
  for (const [sid, limit] of [
    ['DenyBrokerStateRetentionAboveTwoYears', '730'],
    ['DenyPublicationJournalRetentionAboveTwoYears', '730'],
  ]) {
    assert.deepEqual(statementBySid(bucketPolicy, sid as string).Condition, {
      NumericGreaterThan: { 's3:object-lock-remaining-retention-days': limit },
    });
  }
});

test('only the immutable publisher receives the existing exact-version Cloudflare credential reference', () => {
  const token = { secretArn: 'arn:aws:secretsmanager:eu-west-1:111122223333:secret:hid-production-cloudflare-publisher-token-AbCd12',
    versionId: '12345678-1234-1234-1234-123456789012', encryptionKeyArn: 'arn:aws:kms:eu-west-1:111122223333:key/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' };
  const { template } = synthesize({ signingBroker: signingBrokerConfig, publisherCloudflareToken: token });
  assert.equal(properties(template, 'AWS::SecretsManager::Secret').length, 0);
  const publisher = policyStatements(policyForRoleDescription(template, 'repository publisher'));
  const read = statementBySid(publisher, 'PublisherReadExactCloudflareTokenVersion');
  assert.deepEqual(actionList(read), ['secretsmanager:GetSecretValue']);
  assert.equal(read.Resource, token.secretArn);
  assert.deepEqual(read.Condition, { StringEquals: { 'secretsmanager:VersionId': token.versionId } });
  const decrypt = statementBySid(publisher, 'PublisherDecryptExactCloudflareTokenThroughSecretsManager');
  assert.deepEqual((decrypt.Condition as Record<string, unknown>).StringEquals, {
    'kms:CallerAccount': baseProps.approvedAccount, 'kms:ViaService': 'secretsmanager.eu-west-1.amazonaws.com', 'kms:EncryptionContext:SecretARN': token.secretArn,
  });
  for (const description of ['Build-only role', 'Append-only', 'Read-only release trust auditor', 'Snapshot signing-request submitter for candidate one']) {
    assert.equal(policyStatements(policyForRoleDescription(template, description)).flatMap(actionList).includes('secretsmanager:GetSecretValue'), false);
  }
  assert.throws(() => synthesize({ publisherCloudflareToken: token }), /requires the durable signing broker/u);
  for (const mutation of [{ secretArn: token.secretArn.replace('production', 'staging') }, { secretArn: token.secretArn + '*' },
    { versionId: 'AWSCURRENT' }, { encryptionKeyArn: token.encryptionKeyArn.replace('eu-west-1', 'us-east-1') }]) {
    assert.throws(() => synthesize({ signingBroker: signingBrokerConfig, publisherCloudflareToken: { ...token, ...mutation } }));
  }
});

test('repository, evidence, and audit archives are private, retained, KMS-bound, and object-locked', () => {
  const { template } = synthesize();
  const buckets = resources(template, 'AWS::S3::Bucket');
  assert.equal(buckets.length, 3);
  assert.equal(resources(template, 'AWS::ECS::Service').length, 0);
  assert.equal(resources(template, 'AWS::ECS::TaskDefinition').length, 0);

  const encryptionKeyLogicalIds = new Set<string>();
  for (const [, bucket] of buckets) {
    assert.equal(bucket.DeletionPolicy, 'Retain');
    assert.equal(bucket.UpdateReplacePolicy, 'Retain');
    assert.equal(bucket.Properties?.ObjectLockEnabled, true);
    assert.deepEqual(bucket.Properties?.ObjectLockConfiguration, {
      ObjectLockEnabled: 'Enabled',
      Rule: { DefaultRetention: { Days: 365, Mode: 'COMPLIANCE' } },
    });
    assert.deepEqual(bucket.Properties?.VersioningConfiguration, { Status: 'Enabled' });
    assert.deepEqual(bucket.Properties?.PublicAccessBlockConfiguration, {
      BlockPublicAcls: true,
      BlockPublicPolicy: true,
      IgnorePublicAcls: true,
      RestrictPublicBuckets: true,
    });
    assert.deepEqual(bucket.Properties?.OwnershipControls, {
      Rules: [{ ObjectOwnership: 'BucketOwnerEnforced' }],
    });

    const encryption = bucket.Properties?.BucketEncryption as {
      readonly ServerSideEncryptionConfiguration: Array<{
        readonly BucketKeyEnabled: boolean;
        readonly ServerSideEncryptionByDefault: {
          readonly KMSMasterKeyID: { readonly 'Fn::GetAtt': readonly [string, string] };
          readonly SSEAlgorithm: string;
        };
      }>;
    };
    assert.equal(encryption.ServerSideEncryptionConfiguration.length, 1);
    const [rule] = encryption.ServerSideEncryptionConfiguration;
    assert.ok(rule);
    assert.equal(rule.BucketKeyEnabled, false);
    assert.equal(rule.ServerSideEncryptionByDefault.SSEAlgorithm, 'aws:kms');
    const [keyLogicalId, attribute] =
      rule.ServerSideEncryptionByDefault.KMSMasterKeyID['Fn::GetAtt'];
    assert.equal(attribute, 'Arn');
    encryptionKeyLogicalIds.add(keyLogicalId);
  }
  assert.equal(encryptionKeyLogicalIds.size, 3);

  for (const policyFragment of ['ReleaseRepositoryPolicy', 'EvidenceArchivePolicy']) {
    const statements = bucketPolicyStatements(template, policyFragment);
    const transportDeny = statements.find(
      (statement) =>
        statement.Effect === 'Deny' &&
        JSON.stringify(statement.Condition).includes('aws:SecureTransport'),
    );
    assert.ok(transportDeny, `${policyFragment} must deny insecure transport`);

    const algorithmDeny = statementBySid(statements, 'DenyUploadsWithoutKmsEncryption');
    assert.deepEqual(algorithmDeny.Condition, {
      StringNotEquals: { 's3:x-amz-server-side-encryption': 'aws:kms' },
    });
    const keyDeny = statementBySid(statements, 'DenyUploadsWithWrongKmsKey');
    assert.match(
      JSON.stringify(keyDeny.Condition),
      /s3:x-amz-server-side-encryption-aws-kms-key-id/u,
    );
    assert.match(JSON.stringify(keyDeny.Condition), /EncryptionKey/u);
  }
});

test('snapshot and timestamp each have two retained, independent P-256 signing candidates', () => {
  const { template } = synthesize();
  const keyEntries = resources(template, 'AWS::KMS::Key');
  assert.equal(keyEntries.length, 8);
  const signingKeys = keyEntries.filter(
    ([, resource]) => resource.Properties?.KeyUsage === 'SIGN_VERIFY',
  );
  assert.equal(signingKeys.length, 4);
  assert.equal(signingKeys.filter(([logicalId]) => logicalId.includes('Snapshot')).length, 2);
  assert.equal(signingKeys.filter(([logicalId]) => logicalId.includes('Timestamp')).length, 2);
  for (const [, key] of signingKeys) {
    assert.equal(key.Properties?.KeySpec, 'ECC_NIST_P256');
    assert.equal(key.Properties?.EnableKeyRotation, undefined);
    assert.equal(key.DeletionPolicy, 'Retain');
    assert.equal(key.UpdateReplacePolicy, 'Retain');
  }

  const storageKeys = keyEntries.filter(([, resource]) => resource.Properties?.EnableKeyRotation);
  assert.equal(storageKeys.length, 4);
  for (const [, key] of storageKeys) {
    assert.equal(key.DeletionPolicy, 'Retain');
    assert.equal(key.UpdateReplacePolicy, 'Retain');
  }
});

test('role policies preserve build, publish, evidence, audit, and signer separation', () => {
  const { template } = synthesize();
  const forbiddenActions = new Set([
    's3:BypassGovernanceRetention',
    's3:DeleteObject',
    's3:DeleteObjectVersion',
    's3:PutObjectLegalHold',
    's3:PutObjectRetention',
    'kms:ScheduleKeyDeletion',
  ]);
  for (const statement of iamStatements(template)) {
    for (const action of actionList(statement)) {
      assert.equal(forbiddenActions.has(action), false, `forbidden role action ${action}`);
    }
    if (statement.Resource === '*') {
      assert.deepEqual(actionList(statement), ['ecr:GetAuthorizationToken']);
    }
  }

  const build = policyStatements(policyForRoleDescription(template, 'Build-only role'));
  assert.deepEqual(
    [...new Set(build.flatMap(actionList))].sort(),
    [
      'ecr:BatchCheckLayerAvailability',
      'ecr:BatchGetImage',
      'ecr:CompleteLayerUpload',
      'ecr:GetAuthorizationToken',
      'ecr:GetDownloadUrlForLayer',
      'ecr:InitiateLayerUpload',
      'ecr:PutImage',
      'ecr:UploadLayerPart',
      'kms:DescribeKey',
      'kms:GetPublicKey',
    ],
  );

  const publisher = policyStatements(policyForRoleDescription(template, 'repository publisher'));
  assert.deepEqual(
    [...new Set(publisher.flatMap(actionList))].sort(),
    [
      'kms:Decrypt',
      'kms:GenerateDataKey',
      's3:GetBucketLocation',
      's3:GetBucketVersioning',
      's3:GetObject',
      's3:GetObjectVersion',
      's3:ListBucket',
      's3:PutObject',
    ],
  );
  assert.equal(JSON.stringify(publisher).includes('EvidenceArchive'), false);

  const evidence = policyStatements(policyForRoleDescription(template, 'Append-only'));
  assert.deepEqual(
    [...new Set(evidence.flatMap(actionList))].sort(),
    [
      'kms:GenerateDataKey',
      's3:GetBucketObjectLockConfiguration',
      's3:GetBucketVersioning',
      's3:PutObject',
    ],
  );
  assert.equal(JSON.stringify(evidence).includes('ReleaseRepository'), false);
  const appendEvidence = statementBySid(evidence, 'AppendEvidenceWithoutDelete');
  assert.match(JSON.stringify(appendEvidence.Resource), /release-evidence\/\*/u);
  assert.doesNotMatch(JSON.stringify(appendEvidence.Resource), /tuf-signing-broker/u);
  const encryptEvidence = statementBySid(evidence, 'EncryptEvidenceOnly');
  assert.match(
    JSON.stringify(encryptEvidence.Condition),
    /release-evidence\/\*/u,
  );

  const evidenceBucketPolicy = bucketPolicyStatements(
    template,
    'EvidenceArchivePolicy',
  );
  const brokerNamespaceDeny = statementBySid(
    evidenceBucketPolicy,
    'DenyGeneralEvidenceWriterInBrokerNamespace',
  );
  assert.deepEqual(actionList(brokerNamespaceDeny).sort(), [
    's3:PutObject',
    's3:PutObjectRetention',
  ]);
  assert.match(
    JSON.stringify(brokerNamespaceDeny.Resource),
    /tuf-signing-broker\/\*/u,
  );

  const auditor = policyStatements(
    policyForRoleDescription(template, 'Read-only release trust auditor'),
  );
  assert.equal(auditor.some((statement) => actionList(statement).includes('s3:PutObject')), false);
  assert.equal(auditor.some((statement) => actionList(statement).includes('kms:Sign')), false);

  const s3KmsStatements = [...publisher, ...evidence, ...auditor].filter((statement) =>
    actionList(statement).some((action) =>
      ['kms:Decrypt', 'kms:GenerateDataKey'].includes(action),
    ),
  );
  assert.equal(s3KmsStatements.length, 5);
  for (const statement of s3KmsStatements) {
    const serializedCondition = JSON.stringify(statement.Condition);
    assert.match(serializedCondition, /"kms:CallerAccount":"111122223333"/u);
    assert.match(serializedCondition, /"kms:ViaService":"s3\.eu-west-1\.amazonaws\.com"/u);
  }
  const ordinaryS3Contexts = s3KmsStatements.filter((statement) =>
    JSON.stringify(statement.Condition).includes('kms:EncryptionContext:aws:s3:arn'),
  );
  assert.equal(ordinaryS3Contexts.length, 4);
  for (const statement of ordinaryS3Contexts) {
    assert.match(JSON.stringify(statement.Condition), /\/\*/u);
  }
  const cloudTrailContexts = s3KmsStatements.filter((statement) =>
    JSON.stringify(statement.Condition).includes(
      'kms:EncryptionContext:aws:cloudtrail:arn',
    ),
  );
  assert.equal(cloudTrailContexts.length, 1);
  assert.match(
    JSON.stringify(cloudTrailContexts[0]?.Condition),
    /cloudtrail:\*:111122223333:trail\/hid-production-release-trust-audit/u,
  );

  const signerDescriptions = [
    'Snapshot signing-request submitter for candidate one',
    'Snapshot signing-request submitter for candidate two',
    'Timestamp signing-request submitter for candidate one',
    'Timestamp signing-request submitter for candidate two',
  ];
  const assignedPublicKeyResources = new Set<string>();
  for (const description of signerDescriptions) {
    const statements = policyStatements(policyForRoleDescription(template, description));
    assert.deepEqual(
      [...new Set(statements.flatMap(actionList))].sort(),
      ['kms:DescribeKey', 'kms:GetPublicKey'],
    );
    assert.equal(
      statements.some((statement) => actionList(statement).includes('kms:Sign')),
      false,
    );
    const read = statements.find((statement) =>
      actionList(statement).includes('kms:GetPublicKey'),
    );
    assert.ok(read);
    const serializedResource = JSON.stringify(read.Resource);
    assert.match(serializedResource, /SigningCandidate/u);
    assignedPublicKeyResources.add(serializedResource);
  }
  assert.equal(assignedPublicKeyResources.size, 4);
  assert.equal(
    iamStatements(template).some((statement) => actionList(statement).includes('kms:Sign')),
    false,
    'no GitHub-assumable role may receive direct KMS signing permission',
  );
});

test('CloudTrail archive delivery and KMS use are source-bound to the exact trail', () => {
  const { template } = synthesize();
  const trails = properties(template, 'AWS::CloudTrail::Trail');
  assert.equal(trails.length, 1);
  const [trail] = trails;
  assert.ok(trail);
  assert.equal(trail.TrailName, 'hid-production-release-trust-audit');
  assert.equal(trail.EnableLogFileValidation, true);
  assert.equal(trail.IncludeGlobalServiceEvents, true);
  assert.equal(trail.IsMultiRegionTrail, true);
  assert.match(JSON.stringify(trail.KMSKeyId), /AuditLogEncryptionKey/u);
  assert.match(JSON.stringify(trail.S3BucketName), /AuditLogArchive/u);

  const selectors = trail.EventSelectors as Array<Record<string, unknown>>;
  assert.ok(
    selectors.some(
      (selector) => selector.IncludeManagementEvents === true && selector.ReadWriteType === 'All',
    ),
  );
  const dataSelector = selectors.find((selector) => selector.DataResources !== undefined);
  assert.ok(dataSelector);
  assert.equal(dataSelector.IncludeManagementEvents, false);
  assert.equal(dataSelector.ReadWriteType, 'All');
  const serializedResources = JSON.stringify(dataSelector.DataResources);
  assert.match(serializedResources, /ReleaseRepository/u);
  assert.match(serializedResources, /EvidenceArchive/u);
  assert.doesNotMatch(serializedResources, /AuditLogArchive/u);

  const auditBucketStatements = bucketPolicyStatements(template, 'AuditLogArchivePolicy');
  for (const sid of [
    'DenyCloudTrailAclCheckFromUnexpectedTrail',
    'DenyCloudTrailWriteFromUnexpectedTrail',
    'AllowExactCloudTrailAclCheck',
    'AllowExactCloudTrailWrite',
  ]) {
    const statement = statementBySid(auditBucketStatements, sid);
    assert.deepEqual(statement.Principal, { Service: 'cloudtrail.amazonaws.com' });
    assert.match(
      JSON.stringify(statement.Condition),
      /hid-production-release-trust-audit/u,
    );
  }
  assert.match(
    JSON.stringify(statementBySid(auditBucketStatements, 'AllowExactCloudTrailWrite').Resource),
    /AWSLogs\/111122223333\/\*/u,
  );

  const auditKey = resources(template, 'AWS::KMS::Key').find(([logicalId]) =>
    logicalId.includes('AuditLogEncryptionKey'),
  );
  assert.ok(auditKey);
  const keyStatements = statementsFromDocument(auditKey[1].Properties?.KeyPolicy);
  const encrypt = statementBySid(keyStatements, 'AllowExactCloudTrailEncrypt');
  assert.deepEqual(encrypt.Principal, { Service: 'cloudtrail.amazonaws.com' });
  assert.deepEqual(encrypt.Action, 'kms:GenerateDataKey*');
  assert.match(JSON.stringify(encrypt.Condition), /hid-production-release-trust-audit/u);
  assert.match(
    JSON.stringify(encrypt.Condition),
    /kms:EncryptionContext:aws:cloudtrail:arn/u,
  );
  assert.match(
    JSON.stringify(encrypt.Condition),
    /cloudtrail:\*:111122223333:trail\/hid-production-release-trust-audit/u,
  );

  const describe = statementBySid(keyStatements, 'AllowExactCloudTrailDescribeKey');
  assert.equal(describe.Action, 'kms:DescribeKey');
  assert.match(JSON.stringify(describe.Condition), /hid-production-release-trust-audit/u);
});

test('signing broker remains absent until every immutable ceremony pin is supplied', () => {
  const { template } = synthesize();
  const [imageRepositoryEntry] = resources(template, 'AWS::ECR::Repository');
  assert.ok(imageRepositoryEntry);
  const [, imageRepository] = imageRepositoryEntry;
  assert.ok(imageRepository);
  assert.equal(imageRepository.DeletionPolicy, 'Retain');
  assert.equal(imageRepository.UpdateReplacePolicy, 'Retain');
  assert.equal(imageRepository.Properties?.RepositoryName, 'hid-production-tuf-signing-broker');
  assert.equal(imageRepository.Properties?.ImageTagMutability, 'IMMUTABLE');
  assert.deepEqual(imageRepository.Properties?.ImageScanningConfiguration, {
    ScanOnPush: true,
  });
  assert.equal(
    (imageRepository.Properties?.EncryptionConfiguration as { readonly EncryptionType?: string })
      .EncryptionType,
    'KMS',
  );
  assert.equal(resources(template, 'AWS::Lambda::Function').length, 0);
  assert.equal(resources(template, 'AWS::Lambda::Version').length, 0);
  assert.equal(resources(template, 'AWS::DynamoDB::Table').length, 0);
  assert.equal(resources(template, 'AWS::Events::Rule').length, 0);
  assert.equal(resources(template, 'AWS::Logs::MetricFilter').length, 0);
  assert.equal(
    iamStatements(template).filter((statement) =>
      actionList(statement).some((action) =>
        action === 'kms:Sign' || action === 'lambda:InvokeFunction',
      ),
    ).length,
    0,
  );
});

test('partial, mutable, cross-environment, or ambiguous broker configuration fails closed', () => {
  assert.throws(
    () => synthesize({
      signingBroker: signingBrokerConfig,
      alarmNotificationTopicArn: undefined,
    }),
    /alarmNotificationTopicArn is required/u,
  );
  assert.throws(
    () => synthesize({
      signingBroker: signingBrokerConfig,
      alarmNotificationTopicArn:
        'arn:aws:sns:eu-west-1:111122223333:hid-staging-release-trust-alerts',
    }),
    /exact governed environment alert topic/u,
  );
  assert.throws(
    () => synthesize({
      signingBroker: {
        ...signingBrokerConfig,
        stateId: 'hid.production_broker-v1',
      },
    }),
    /exact lowercase identifier/u,
  );
  assert.throws(
    () => synthesize({
      signingBroker: {
        ...signingBrokerConfig,
        stateId: 'hid-staging-production-broker-v1',
      },
    }),
    /governed release-trust broker state ID/u,
  );
  assert.throws(
    () => synthesize({
      signingBroker: {
        ...signingBrokerConfig,
        bootstrapRootObjectVersionId: 'quoted"version',
      },
    }),
    /exact non-null immutable S3 VersionId/u,
  );
  assert.throws(
    () => synthesize({
      signingBroker: {
        ...signingBrokerConfig,
        bootstrapRootObjectVersionId: 'unicode-λ',
      },
    }),
    /exact non-null immutable S3 VersionId/u,
  );
  assert.throws(
    () => synthesize({
      signingBroker: {
        ...signingBrokerConfig,
        imageDigest: 'latest',
      },
    }),
    /content digest/u,
  );
  assert.throws(
    () => synthesize({
      signingBroker: {
        ...signingBrokerConfig,
        publicRepositoryUrl:
          'https://updates.staging.healthidentitydirectory.com/',
      },
    }),
    /governed environment repository origin/u,
  );
  assert.throws(
    () => synthesize({
      signingBroker: {
        ...signingBrokerConfig,
        candidatePublicKeySpkiSha256: {
          ...signingBrokerConfig.candidatePublicKeySpkiSha256,
          snapshotTwo:
            signingBrokerConfig.candidatePublicKeySpkiSha256.snapshotOne,
        },
      },
    }),
    /must be distinct/u,
  );
  const missingPin = {
    ...signingBrokerConfig,
    candidatePublicKeySpkiSha256: {
      snapshotOne: 'c'.repeat(64),
      snapshotTwo: 'd'.repeat(64),
      timestampOne: 'e'.repeat(64),
    },
  } as unknown as TufSigningBrokerConfig;
  assert.throws(
    () => synthesize({ signingBroker: missingPin }),
    /exactly all four candidate pins/u,
  );
  assert.throws(
    () => synthesize({
      signingBroker: {
        ...signingBrokerConfig,
        acknowledgeCeremonyApprovedImmutablePins: false,
      } as unknown as TufSigningBrokerConfig,
    }),
    /must be true/u,
  );
});

test('publisher reads only its exact broker state without acquiring signing or checkpoint writes', () => {
  const { template } = synthesize({ signingBroker: signingBrokerConfig });
  const publisher = policyStatements(policyForRoleDescription(template, 'repository publisher'));
  const reads = publisher.filter((statement) => String(statement.Sid).startsWith('Publisher'));
  assert.equal(reads.length, 3);
  const checkpoint = reads.find((statement) => statement.Sid === 'PublisherReadExactBrokerCheckpoint');
  assert.ok(checkpoint);
  assert.deepEqual(actionList(checkpoint), ['dynamodb:GetItem']);
  assert.deepEqual(checkpoint.Condition, {
    'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['hid-production-broker-v1'] },
  });
  assert.match(JSON.stringify(checkpoint.Resource), /TufSigningBrokerStateTable/u);
  const objects = reads.find((statement) => statement.Sid === 'PublisherReadOnlyLockedBrokerStateVersions');
  assert.ok(objects);
  assert.deepEqual(actionList(objects).sort(), ['s3:GetObjectRetention', 's3:GetObjectVersion']);
  assert.match(JSON.stringify(objects.Resource), /tuf-signing-broker\/state\/hid-production-broker-v1\/\*/u);
  assert.doesNotMatch(JSON.stringify(objects.Resource), /requests|bootstrap/u);
  const decrypt = reads.find((statement) => statement.Sid === 'PublisherDecryptOnlyBrokerStateThroughS3');
  assert.ok(decrypt);
  assert.deepEqual(actionList(decrypt), ['kms:Decrypt']);
  assert.deepEqual((decrypt.Condition as Record<string, unknown>).StringEquals, {
    'kms:CallerAccount': baseProps.approvedAccount,
    'kms:ViaService': 's3.eu-west-1.amazonaws.com',
  });
  assert.match(JSON.stringify(decrypt.Condition), /kms:EncryptionContext:aws:s3:arn/u);
  assert.match(JSON.stringify(decrypt.Condition), /tuf-signing-broker\/state\/hid-production-broker-v1\/\*/u);
  assert.equal(publisher.flatMap(actionList).some((action) =>
    ['kms:Sign', 'lambda:InvokeFunction', 'dynamodb:PutItem'].includes(action)), false);
  const journalWrites = publisher.filter((statement) => actionList(statement).includes('dynamodb:UpdateItem'));
  assert.equal(journalWrites.length, 1);
  assert.deepEqual(journalWrites[0]?.Condition, {
    'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': ['hid-production-publication-v1'] },
    Null: { 'dynamodb:LeadingKeys': 'false' },
  });
  const stateWrites = publisher.filter((statement) =>
    actionList(statement).some((action) => ['s3:PutObject', 's3:PutObjectRetention'].includes(action)));
  assert.doesNotMatch(JSON.stringify(stateWrites), /tuf-signing-broker/u);
  assert.match(JSON.stringify(stateWrites), /tuf-publication-journal\/hid-production-publication-v1/u);
});

test('enabled broker pins five immutable Lambda versions and durable CAS state', () => {
  const { template } = synthesize({ signingBroker: signingBrokerConfig });
  assert.equal(resources(template, 'AWS::Lambda::Function').length, 5);
  assert.equal(resources(template, 'AWS::Lambda::Version').length, 5);
  assert.equal(resources(template, 'AWS::DynamoDB::Table').length, 1);
  assert.equal(resources(template, 'AWS::Events::Rule').length, 1);
  assert.equal(resources(template, 'AWS::Logs::MetricFilter').length, 4);
  assert.equal(resources(template, 'AWS::CloudWatch::Alarm').length, 18);
  for (const alarm of properties(template, 'AWS::CloudWatch::Alarm')) {
    assert.deepEqual(alarm.AlarmActions, [baseProps.alarmNotificationTopicArn]);
  }

  const [table] = properties(template, 'AWS::DynamoDB::Table');
  assert.ok(table);
  assert.equal(table.TableName, 'hid-production-tuf-broker-state');
  assert.equal(table.DeletionProtectionEnabled, true);
  assert.deepEqual(table.PointInTimeRecoverySpecification, {
    PointInTimeRecoveryEnabled: true,
    RecoveryPeriodInDays: 35,
  });
  assert.equal(
    (table.SSESpecification as { readonly SSEEnabled?: boolean }).SSEEnabled,
    true,
  );
  const tableResourcePolicy = statementsFromDocument(
    (table.ResourcePolicy as { readonly PolicyDocument?: unknown }).PolicyDocument,
  );
  assert.deepEqual(
    actionList(statementBySid(tableResourcePolicy, 'DenyEveryNonCasStateMutation')).sort(),
    [
      'dynamodb:BatchWriteItem',
      'dynamodb:DeleteItem',
      'dynamodb:PartiQLDelete',
      'dynamodb:PartiQLInsert',
      'dynamodb:PartiQLUpdate',
      'dynamodb:PutItem',
      'dynamodb:TransactWriteItems',
    ],
  );
  const exactWriterDeny = statementBySid(
    tableResourcePolicy,
    'DenyStateUpdateFromEveryOtherPrincipal',
  );
  assert.deepEqual(actionList(exactWriterDeny), ['dynamodb:UpdateItem']);
  assert.match(JSON.stringify(exactWriterDeny.Condition), /ArnNotEquals/u);
  assert.equal(
    (JSON.stringify(exactWriterDeny.Condition).match(/hid-production-tuf-broker-/g) ?? [])
      .length,
    5,
  );

  for (const fn of properties(template, 'AWS::Lambda::Function')) {
    assert.match(JSON.stringify(fn.Code), /@sha256:aaaaaaaaaaaaaaaa/u);
    assert.equal(fn.PackageType, 'Image');
    assert.equal(fn.ReservedConcurrentExecutions, 1);
    assert.equal(fn.Timeout, 30);
    const variables = (fn.Environment as {
      readonly Variables: Record<string, unknown>;
    }).Variables;
    assert.equal(variables.HID_BROKER_ENVIRONMENT, 'production');
    assert.equal(variables.HID_REPOSITORY_ID, 'hid-production-v1');
    assert.equal(variables.HID_STATE_ID, 'hid-production-broker-v1');
    assert.equal(
      variables.HID_BOOTSTRAP_ROOT_SHA256,
      signingBrokerConfig.bootstrapRootSha256,
    );
    assert.match(JSON.stringify(variables.HID_STATE_BUCKET_NAME), /EvidenceArchive/u);
    assert.equal(
      variables.HID_STATE_OBJECT_PREFIX,
      'tuf-signing-broker/state/hid-production-broker-v1/',
    );
    assert.match(
      JSON.stringify(variables.HID_STORAGE_KMS_KEY_ARN),
      /EvidenceArchiveEncryptionKey/u,
    );
    assert.equal(variables.HID_OBJECT_LOCK_MODE, 'COMPLIANCE');
    assert.equal(variables.HID_STATE_RETENTION_DAYS, '730');
    assert.equal(variables.HID_EVIDENCE_RETENTION_DAYS, '365');
    assert.equal(variables.HID_EXPECTED_AWS_ACCOUNT_ID, '111122223333');
    assert.equal(variables.HID_EXPECTED_AWS_REGION, 'eu-west-1');
  }

  const logWrites = iamStatements(template).filter(
    (statement) => statement.Sid === 'WriteOnlyExactBrokerFunctionLogs',
  );
  assert.equal(logWrites.length, 5);
  for (const statement of logWrites) {
    assert.deepEqual(actionList(statement).sort(), [
      'logs:CreateLogStream',
      'logs:PutLogEvents',
    ]);
    assert.match(JSON.stringify(statement.Resource), /LogGroup/u);
    assert.match(JSON.stringify(statement.Resource), /:\*/u);
  }

  const [checkpointRule] = properties(template, 'AWS::Events::Rule');
  assert.ok(checkpointRule);
  assert.equal(checkpointRule.Name, 'hid-production-tuf-broker-checkpoint');
  assert.equal(
    iamStatements(template).filter(
      (statement) => statement.Sid === 'ReadExactImmutableBrokerStateObjects',
    ).length,
    5,
  );
  const stateWrites = iamStatements(template).filter(
    (statement) => statement.Sid === 'AppendLockedBrokerStateObjects',
  );
  assert.equal(stateWrites.length, 5);
  for (const statement of stateWrites) {
    assert.deepEqual(actionList(statement).sort(), [
      's3:PutObject',
      's3:PutObjectRetention',
    ]);
    assert.match(
      JSON.stringify(statement.Resource),
      /tuf-signing-broker\/state\/hid-production-broker-v1\//u,
    );
  }
  assert.equal(
    iamStatements(template).filter(
      (statement) => statement.Sid === 'UseEvidenceKeyOnlyForBrokerStateThroughS3',
    ).length,
    5,
  );
  const stateAdvances = iamStatements(template).filter(
    (statement) => statement.Sid === 'ConditionallyAdvanceExactBrokerStatePartition',
  );
  assert.equal(stateAdvances.length, 5);
  for (const statement of stateAdvances) {
    assert.deepEqual(actionList(statement), ['dynamodb:UpdateItem']);
  }
  assert.equal(
    iamStatements(template).filter(
      (statement) => statement.Sid === 'UseStateKeyOnlyThroughExactDynamoDBTable',
    ).length,
    0,
    'DynamoDB encryption at rest must not grant caller roles unnecessary KMS access',
  );
  for (const statement of [...stateWrites, ...stateAdvances]) {
    assert.match(
      JSON.stringify(statement.Condition),
      /lambda:SourceFunctionArn/u,
    );
  }
  const sourceBoundGrantCounts = new Map<string, number>([
    ['SignOnlyFromExactBrokerFunction', 4],
    ['ReadExactBrokerStatePartition', 5],
    ['ConditionallyAdvanceExactBrokerStatePartition', 5],
    ['ReadExactImmutableBrokerStateObjects', 5],
    ['AppendLockedBrokerStateObjects', 5],
    ['UseEvidenceKeyOnlyForBrokerStateThroughS3', 5],
    ['ReadOnlyImmutableVersionedSigningRequests', 4],
    ['DecryptOnlyCandidateSigningRequestsThroughS3', 4],
    ['ReadExactBootstrapRootRetention', 1],
    ['ReadOnlyExactImmutableBootstrapRoot', 1],
    ['DecryptOnlyBootstrapRootThroughS3', 1],
  ]);
  for (const [sid, expectedCount] of sourceBoundGrantCounts) {
    const grants = iamStatements(template).filter((statement) => statement.Sid === sid);
    assert.equal(grants.length, expectedCount, `${sid} count`);
    for (const grant of grants) {
      const condition = grant.Condition as {
        readonly ArnEquals?: Record<string, unknown>;
      };
      const sourceFunctionArn = literalArn(
        condition.ArnEquals?.['lambda:SourceFunctionArn'],
      );
      assert.ok(
        exactBrokerFunctionArns.includes(
          sourceFunctionArn as (typeof exactBrokerFunctionArns)[number],
        ),
        `${sid} used an unexpected source function ARN`,
      );
    }
  }
  const stateReadSources = iamStatements(template)
    .filter((statement) => statement.Sid === 'ReadExactBrokerStatePartition')
    .map(
      (statement) =>
        literalArn(
          ((statement.Condition as { readonly ArnEquals: Record<string, unknown> })
            .ArnEquals)['lambda:SourceFunctionArn'],
        ),
    )
    .sort();
  assert.deepEqual(stateReadSources, [...exactBrokerFunctionArns].sort());

  const [trail] = properties(template, 'AWS::CloudTrail::Trail');
  assert.ok(trail);
  assert.ok(trail.CloudWatchLogsLogGroupArn);
  const selectors = trail.EventSelectors as Array<Record<string, unknown>>;
  assert.match(JSON.stringify(selectors), /AWS::Lambda::Function/u);
  assert.match(JSON.stringify(selectors), /AWS::DynamoDB::Table/u);
  assert.match(JSON.stringify(selectors), /AWS::S3::Object/u);
  const lambdaSelector = selectors.find((selector) =>
    String(JSON.stringify(selector.DataResources)).includes('AWS::Lambda::Function'),
  );
  assert.ok(lambdaSelector);
  assert.doesNotMatch(JSON.stringify(lambdaSelector), /CurrentVersion/u);
  const lambdaDataResources = lambdaSelector.DataResources as Array<{
    readonly Type: string;
    readonly Values: Array<{ readonly 'Fn::GetAtt': readonly [string, string] }>;
  }>;
  assert.equal(lambdaDataResources.length, 1);
  const [lambdaDataResource] = lambdaDataResources;
  assert.ok(lambdaDataResource);
  assert.equal(lambdaDataResource.Type, 'AWS::Lambda::Function');
  const selectedFunctionLogicalIds = lambdaDataResource.Values.map((value) => {
    const [logicalId, attribute] = value['Fn::GetAtt'];
    assert.equal(attribute, 'Arn');
    return logicalId;
  }).sort();
  const brokerFunctionLogicalIds = resources(template, 'AWS::Lambda::Function')
    .map(([logicalId]) => logicalId)
    .sort();
  assert.deepEqual(selectedFunctionLogicalIds, brokerFunctionLogicalIds);
  assert.equal(selectedFunctionLogicalIds.length, 5);

  const [imageRepositoryEntry] = resources(template, 'AWS::ECR::Repository');
  assert.ok(imageRepositoryEntry);
  const [, imageRepository] = imageRepositoryEntry;
  assert.ok(imageRepository);
  const imagePolicy = statementsFromDocument(
    imageRepository.Properties?.RepositoryPolicyText,
  );
  const exactImagePull = statementBySid(
    imagePolicy,
    'AllowExactBrokerFunctionsToRetrievePinnedImage',
  );
  assert.deepEqual(exactImagePull.Principal, { Service: 'lambda.amazonaws.com' });
  assert.deepEqual(actionList(exactImagePull).sort(), [
    'ecr:BatchCheckLayerAvailability',
    'ecr:BatchGetImage',
    'ecr:GetDownloadUrlForLayer',
  ]);
  const exactImagePullCondition = exactImagePull.Condition as {
    readonly StringEquals: Record<string, unknown>;
    readonly ArnEquals: Record<string, unknown>;
  };
  assert.deepEqual(exactImagePullCondition.StringEquals, {
    'aws:SourceAccount': '111122223333',
  });
  assert.deepEqual(
    valueList(exactImagePullCondition.ArnEquals['aws:SourceArn'])
      .map(literalArn)
      .sort(),
    [...exactBrokerFunctionArns].sort(),
  );
  const foreignFunctionDeny = statementBySid(
    imagePolicy,
    'DenyLambdaImageRetrievalOutsideExactBrokerFunctions',
  );
  assert.equal(foreignFunctionDeny.Effect, 'Deny');
  assert.deepEqual(foreignFunctionDeny.Principal, {
    Service: 'lambda.amazonaws.com',
  });
  const foreignFunctionCondition = foreignFunctionDeny.Condition as {
    readonly ArnNotEquals: Record<string, unknown>;
  };
  assert.deepEqual(
    valueList(foreignFunctionCondition.ArnNotEquals['aws:SourceArn'])
      .map(literalArn)
      .sort(),
    [...exactBrokerFunctionArns].sort(),
  );
  const foreignAccountDeny = statementBySid(
    imagePolicy,
    'DenyLambdaImageRetrievalFromUnexpectedSourceAccount',
  );
  assert.equal(foreignAccountDeny.Effect, 'Deny');
  assert.deepEqual(foreignAccountDeny.Condition, {
    Null: { 'aws:SourceAccount': 'false' },
    StringNotEquals: { 'aws:SourceAccount': '111122223333' },
  });

  const evidencePolicy = bucketPolicyStatements(template, 'EvidenceArchivePolicy');
  assert.deepEqual(
    statementBySid(
      evidencePolicy,
      'DenyEvidenceRetentionBelowEnvironmentMinimum',
    ).Condition,
    {
      NumericLessThan: {
        's3:object-lock-remaining-retention-days': '365',
      },
    },
  );
  const stateRetention = statementBySid(
    evidencePolicy,
    'DenyBrokerStateRetentionBelowTwoYears',
  );
  assert.deepEqual(stateRetention.Condition, {
    NumericLessThan: {
      's3:object-lock-remaining-retention-days': '729',
    },
  });
  assert.match(JSON.stringify(stateRetention.Resource), /tuf-signing-broker\/state/u);
  const maximumStateRetention = statementBySid(evidencePolicy, 'DenyBrokerStateRetentionAboveTwoYears');
  assert.equal(maximumStateRetention.Effect, 'Deny');
  assert.deepEqual(maximumStateRetention.Resource, stateRetention.Resource);
  assert.deepEqual(maximumStateRetention.Condition, {
    NumericGreaterThan: { 's3:object-lock-remaining-retention-days': '730' },
  });

  const stateWriterBoundary = statementBySid(
    evidencePolicy,
    'DenyBrokerStateWritesFromEveryOtherPrincipal',
  );
  assert.deepEqual(actionList(stateWriterBoundary).sort(), [
    's3:PutObject',
    's3:PutObjectRetention',
  ]);
  const exactStateWriters = ((stateWriterBoundary.Condition as {
    readonly ArnNotEquals?: Record<string, unknown>;
  }).ArnNotEquals?.['aws:PrincipalArn']);
  assert.ok(Array.isArray(exactStateWriters));
  assert.equal(exactStateWriters.length, 5);
  const requestWriterBoundaries = evidencePolicy.filter((statement) =>
    /^Deny(?:Snapshot|Timestamp)(?:One|Two)RequestWritesFromEveryOtherPrincipal$/u
      .test(String(statement.Sid)),
  );
  assert.equal(requestWriterBoundaries.length, 4);
  assert.equal(
    new Set(requestWriterBoundaries.map((statement) => JSON.stringify(statement.Resource)))
      .size,
    4,
  );
  assert.equal(
    new Set(requestWriterBoundaries.map((statement) => JSON.stringify(statement.Condition)))
      .size,
    4,
  );
  assert.deepEqual(
    actionList(statementBySid(evidencePolicy, 'DenyPinnedBootstrapRootMutation')).sort(),
    ['s3:PutObject', 's3:PutObjectRetention'],
  );
  assert.deepEqual(
    actionList(
      statementBySid(evidencePolicy, 'DenyBrokerObjectDeletionAndRetentionBypass'),
    ).sort(),
    [
      's3:BypassGovernanceRetention',
      's3:DeleteObject',
      's3:DeleteObjectVersion',
    ],
  );

  const auditPatterns = properties(template, 'AWS::Logs::MetricFilter')
    .map((filter) => JSON.stringify(filter.FilterPattern))
    .join('\n');
  assert.match(auditPatterns, /ExecuteStatement/u);
  assert.match(auditPatterns, /BatchExecuteStatement/u);
  assert.match(auditPatterns, /requestParameters\.keyId/u);
  assert.match(auditPatterns, /SigningCandidate/u);

  const alarms = properties(template, 'AWS::CloudWatch::Alarm');
  const eventBridgeFailure = alarms.find(
    (alarm) => alarm.Namespace === 'AWS/Events' && alarm.MetricName === 'FailedInvocations',
  );
  assert.ok(eventBridgeFailure);
  assert.deepEqual(eventBridgeFailure.Dimensions, [
    { Name: 'RuleName', Value: 'hid-production-tuf-broker-checkpoint' },
  ]);
  const heartbeat = alarms.find(
    (alarm) => alarm.ComparisonOperator === 'LessThanThreshold',
  );
  assert.ok(heartbeat);
  assert.equal(heartbeat.TreatMissingData, 'breaching');
});

test('only fixed broker functions can sign and GitHub can submit to one exact version', () => {
  const { template } = synthesize({ signingBroker: signingBrokerConfig });

  const functionBoundSign = iamStatements(template).filter(
    (statement) => statement.Sid === 'SignOnlyFromExactBrokerFunction',
  );
  assert.equal(functionBoundSign.length, 4);
  const signSourceFunctionArns: string[] = [];
  const signKeyResources = new Set<string>();
  for (const statement of functionBoundSign) {
    assert.deepEqual(actionList(statement), ['kms:Sign']);
    assert.match(JSON.stringify(statement.Resource), /SigningCandidate/u);
    signKeyResources.add(JSON.stringify(statement.Resource));
    assert.deepEqual(
      (statement.Condition as Record<string, unknown>).StringEquals,
      {
        'kms:MessageType': 'DIGEST',
        'kms:SigningAlgorithm': 'ECDSA_SHA_256',
      },
    );
    assert.match(
      JSON.stringify((statement.Condition as Record<string, unknown>).ArnEquals),
      /lambda:SourceFunctionArn/u,
    );
    assert.match(
      JSON.stringify((statement.Condition as Record<string, unknown>).ArnEquals),
      /:lambda:eu-west-1:111122223333:function:hid-production-tuf-broker-(?:snapshot|timestamp)-(?:one|two)/u,
    );
    const sourceFunctionArn = literalArn(
      ((statement.Condition as {
        readonly ArnEquals: Record<string, unknown>;
      }).ArnEquals)['lambda:SourceFunctionArn'],
    );
    assert.ok(sourceFunctionArn);
    signSourceFunctionArns.push(sourceFunctionArn);
  }
  assert.equal(signKeyResources.size, 4);
  assert.deepEqual(
    signSourceFunctionArns.sort(),
    [...exactBrokerFunctionArns.slice(0, 4)].sort(),
  );

  const kmsStatements = properties(template, 'AWS::KMS::Key').flatMap((key) =>
    statementsFromDocument(
      (key.KeyPolicy as { readonly Statement?: unknown }),
    ),
  );
  const directKeyPolicySignAllow = kmsStatements.filter(
    (statement) =>
      statement.Effect === 'Allow' && actionList(statement).includes('kms:Sign'),
  );
  assert.equal(
    directKeyPolicySignAllow.length,
    0,
    'a key-policy allow must not bypass lambda:SourceFunctionArn',
  );
  assert.equal(
    kmsStatements.filter(
      (statement) =>
        statement.Effect === 'Deny' &&
        actionList(statement).includes('kms:Sign') &&
        statement.Sid === 'DenySigningFromEveryOtherPrincipal',
    ).length,
    4,
  );
  assert.equal(
    kmsStatements.filter(
      (statement) =>
        statement.Effect === 'Deny' &&
        actionList(statement).includes('kms:Sign') &&
        statement.Sid === 'DenyEveryOtherMessageType' &&
        JSON.stringify(statement.Condition).includes('DIGEST'),
    ).length,
    4,
  );

  for (const description of [
    'Snapshot signing-request submitter for candidate one',
    'Snapshot signing-request submitter for candidate two',
    'Timestamp signing-request submitter for candidate one',
    'Timestamp signing-request submitter for candidate two',
  ]) {
    const statements = policyStatements(
      policyForRoleDescription(template, description),
    );
    const invoke = statements.find((statement) =>
      actionList(statement).includes('lambda:InvokeFunction'),
    );
    assert.ok(invoke);
    assert.match(JSON.stringify(invoke.Resource), /CurrentVersion/u);
    assert.equal(
      statements.some((statement) =>
        actionList(statement).some((action) =>
          action.startsWith('dynamodb:') || action === 'kms:Sign',
        ),
      ),
      false,
    );
    const requestWrite = statements.find((statement) =>
      statement.Sid === 'WriteOnlyCandidateSigningRequests',
    );
    assert.ok(requestWrite);
    assert.deepEqual(actionList(requestWrite), ['s3:PutObject']);
    assert.match(
      JSON.stringify(requestWrite.Resource),
      /tuf-signing-broker\/requests\/hid-production-broker-v1\//u,
    );
  }

  const checkpointPolicy = policyStatements(
    policyForRoleDescription(template, 'Non-signing TUF public-repository checkpoint'),
  );
  assert.equal(
    checkpointPolicy.some((statement) =>
      actionList(statement).some((action) => action === 'kms:Sign'),
    ),
    false,
  );
  const bootstrapRead = statementBySid(
    checkpointPolicy,
    'ReadOnlyExactImmutableBootstrapRoot',
  );
  assert.deepEqual(
    (bootstrapRead.Condition as Record<string, unknown>).StringEquals,
    {
      's3:VersionId': signingBrokerConfig.bootstrapRootObjectVersionId,
    },
  );
  assert.match(
    JSON.stringify((bootstrapRead.Condition as Record<string, unknown>).ArnEquals),
    /:lambda:eu-west-1:111122223333:function:hid-production-tuf-broker-checkpoint/u,
  );
  assert.deepEqual(actionList(bootstrapRead), ['s3:GetObjectVersion']);
  const bootstrapRetention = statementBySid(
    checkpointPolicy,
    'ReadExactBootstrapRootRetention',
  );
  assert.deepEqual(actionList(bootstrapRetention), ['s3:GetObjectRetention']);
  assert.match(
    JSON.stringify(bootstrapRetention.Condition),
    /:lambda:eu-west-1:111122223333:function:hid-production-tuf-broker-checkpoint/u,
  );
});
