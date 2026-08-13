import {
  ArnFormat,
  Aws,
  CfnOutput,
  CfnParameter,
  Duration,
  Fn,
  RemovalPolicy,
  Stack,
  type StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudmap from 'aws-cdk-lib/aws-servicediscovery';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elasticloadbalancingv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as route53 from 'aws-cdk-lib/aws-route53';
import * as route53Targets from 'aws-cdk-lib/aws-route53-targets';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
import type { Construct } from 'constructs';
import type { HidEnvironmentConfig } from './config.js';
import {
  serviceHostLabels,
  tokenRoot,
  validateDatabaseConnectionBudget,
  workloadNames,
  workloadScale,
  workloads,
  type WorkloadDefinition,
  type WorkloadName,
} from './workloads.js';

export interface HidRegionalStackProps extends StackProps {
  readonly configuration: HidEnvironmentConfig;
}

type ParameterMap = Record<string, CfnParameter>;
type SecretMap = Record<string, secretsmanager.ISecret>;

interface RuntimeResource {
  readonly definition: WorkloadDefinition;
  readonly taskDefinition: ecs.FargateTaskDefinition;
  readonly service: ecs.FargateService;
  readonly container: ecs.ContainerDefinition;
  readonly logGroup: logs.LogGroup;
  readonly securityGroup: ec2.SecurityGroup;
}

const databaseSecretFields: Partial<Record<WorkloadName, string>> = {
  'identity-api': 'DATABASE_URL',
  'ehr-api': 'DATABASE_URL',
  'lab-api': 'LAB_DATABASE_URL',
  'pharmacy-api': 'PHARMACY_DATABASE_URL',
  'ocr-api': 'OCR_DATABASE_URL',
  'ocr-worker': 'OCR_WORKER_DATABASE_URL',
  'outreach-api': 'OUTREACH_DATABASE_URL',
  'event-dispatcher': 'EVENT_DISPATCHER_DATABASE_URL',
  'notification-worker': 'NOTIFICATION_WORKER_DATABASE_URL',
};

const apiNames = workloadNames.filter((name) => workloads[name].browserRouted && name !== 'gateway');

export class HidRegionalStack extends Stack {
  public readonly applicationLoadBalancer?: elasticloadbalancingv2.ApplicationLoadBalancer;
  public readonly eventBus: events.EventBus;
  public readonly notificationQueue: sqs.Queue;
  public readonly documentBucket: s3.Bucket;
  public readonly cluster: ecs.Cluster;

  private readonly configuration: HidEnvironmentConfig;
  private readonly parameters: ParameterMap = {};

  public constructor(scope: Construct, id: string, props: HidRegionalStackProps) {
    super(scope, id, props);
    this.configuration = props.configuration;

    validateDatabaseConnectionBudget(
      this.configuration.profile,
      this.configuration.databaseConnectionBudget,
      this.configuration.reviewedEmergencyConnectionBudget,
    );
    for (const [key, value] of Object.entries({
      Project: 'HID',
      Environment: this.configuration.name,
      Service: 'platform-shared',
      ManagedBy: 'CDK',
      Owner: 'HID',
      CostCenter: 'HID',
      DataClassification: 'healthcare-restricted',
    })) Tags.of(this).add(key, value);

    this.addParameterContract();

    const vpc = new ec2.Vpc(this, 'Vpc', {
      ipAddresses: ec2.IpAddresses.cidr(this.configuration.vpcCidr),
      maxAzs: this.configuration.availabilityZones,
      natGateways: this.configuration.natGateways,
      subnetConfiguration: [
        { name: 'edge', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'application', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'database', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    const endpointSecurityGroup = new ec2.SecurityGroup(this, 'AwsEndpointSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'TLS endpoints used by private HID tasks',
    });
    this.createAwsEndpoints(vpc, endpointSecurityGroup);

    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'RDS accepts PostgreSQL only from explicitly registered HID tasks',
    });

    const databaseKey = new kms.Key(this, 'DatabaseKey', {
      enableKeyRotation: true,
      description: `HID ${this.configuration.name} RDS encryption`,
      removalPolicy: this.configuration.removalPolicy,
    });
    const databaseParameterGroup = new rds.ParameterGroup(this, 'DatabaseParameterGroup', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      parameters: { 'rds.force_ssl': '1' },
      description: 'PostgreSQL 16 family with TLS required',
    });
    const databaseLogGroup = new logs.LogGroup(this, 'DatabaseLogGroup', {
      logGroupName: `/aws/rds/instance/hid-${this.configuration.name}-postgres/postgresql`,
      retention: this.configuration.logRetention,
      removalPolicy: this.configuration.removalPolicy,
    });
    const database = new rds.DatabaseInstance(this, 'Database', {
      instanceIdentifier: `hid-${this.configuration.name}-postgres`,
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: this.configuration.databaseInstanceType,
      credentials: rds.Credentials.fromGeneratedSecret('hid_platform_bootstrap'),
      databaseName: 'hid',
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      publiclyAccessible: false,
      multiAz: this.configuration.databaseMultiAz,
      storageEncrypted: true,
      storageEncryptionKey: databaseKey,
      allocatedStorage: this.configuration.databaseAllocatedStorageGiB,
      maxAllocatedStorage: this.configuration.databaseMaxStorageGiB,
      storageType: rds.StorageType.GP3,
      backupRetention: this.configuration.databaseBackupRetention,
      deleteAutomatedBackups: this.configuration.name === 'development',
      deletionProtection: this.configuration.databaseDeletionProtection,
      monitoringInterval: Duration.seconds(60),
      enablePerformanceInsights: true,
      databaseInsightsMode: rds.DatabaseInsightsMode.STANDARD,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      parameterGroup: databaseParameterGroup,
      cloudwatchLogsExports: ['postgresql'],
      autoMinorVersionUpgrade: true,
      removalPolicy: this.configuration.name === 'development' ? RemovalPolicy.DESTROY : RemovalPolicy.SNAPSHOT,
    });
    database.node.addDependency(databaseLogGroup);

    const documentKey = new kms.Key(this, 'DocumentKey', {
      enableKeyRotation: true,
      description: `HID ${this.configuration.name} document/OCR object encryption`,
      removalPolicy: this.configuration.removalPolicy,
    });
    this.documentBucket = new s3.Bucket(this, 'DocumentBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: documentKey,
      bucketKeyEnabled: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_ENFORCED,
      lifecycleRules: [
        {
          id: 'clinical-records-never-expire-by-generic-lifecycle',
          enabled: true,
          prefix: 'clinical/',
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        {
          id: 'legacy-clinical-records-never-expire-by-generic-lifecycle',
          enabled: true,
          prefix: 'objects/',
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        {
          id: 'temporary-object-cleanup',
          enabled: true,
          prefix: 'temporary/',
          expiration: Duration.days(30),
          noncurrentVersionExpiration: Duration.days(7),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        {
          id: 'release-evidence-lower-cost-storage',
          enabled: true,
          prefix: 'release-evidence/',
          transitions: [{ storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
            transitionAfter: Duration.days(90) }],
          noncurrentVersionTransitions: [{ storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
            transitionAfter: Duration.days(90) }],
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
        {
          id: 'nonclinical-test-staging-cleanup',
          enabled: true,
          prefix: 'test-staging/',
          expiration: Duration.days(this.configuration.name === 'production' ? 90 : 30),
          noncurrentVersionExpiration: Duration.days(30),
          abortIncompleteMultipartUploadAfter: Duration.days(7),
        },
      ],
      removalPolicy: this.configuration.removalPolicy,
    });

    this.eventBus = new events.EventBus(this, 'PlatformEventBus', {
      eventBusName: `hid-${this.configuration.name}`,
    });
    const notificationQueueKey = new kms.Key(this, 'NotificationQueueKey', {
      enableKeyRotation: true,
      description: `HID ${this.configuration.name} ordinary notification queue encryption`,
      removalPolicy: this.configuration.removalPolicy,
    });
    const notificationDeadLetterQueue = new sqs.Queue(this, 'NotificationDeadLetterQueue', {
      queueName: `hid-${this.configuration.name}-notification-dead-letter`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: notificationQueueKey,
      enforceSSL: true,
      retentionPeriod: Duration.days(14),
      removalPolicy: this.configuration.removalPolicy,
    });
    this.notificationQueue = new sqs.Queue(this, 'NotificationQueue', {
      queueName: `hid-${this.configuration.name}-notification`,
      encryption: sqs.QueueEncryption.KMS,
      encryptionMasterKey: notificationQueueKey,
      enforceSSL: true,
      visibilityTimeout: Duration.seconds(90),
      retentionPeriod: Duration.days(4),
      deadLetterQueue: { queue: notificationDeadLetterQueue, maxReceiveCount: 8 },
      removalPolicy: this.configuration.removalPolicy,
    });
    this.tagService(notificationDeadLetterQueue, 'notification-worker');
    this.tagService(this.notificationQueue, 'notification-worker');
    new events.Rule(this, 'OrdinaryNotificationEvents', {
      eventBus: this.eventBus,
      description: 'Minimum-necessary ordinary notification events; authentication OTP never enters this rule',
      eventPattern: {
        source: ['ng.hid.identity', 'ng.hid.ocr', 'ng.hid.lab', 'ng.hid.pharmacy', 'ng.hid.outreach'],
        detailType: [
          'PatientRegistered.v1', 'PatientIdentityResolved.v1', 'OcrPublicationSucceeded.v1',
          'LabResultReleased.v1', 'MedicationDispensed.v1', 'OutreachPatientResolved.v1',
        ],
      },
      targets: [new eventTargets.SqsQueue(this.notificationQueue, {
        deadLetterQueue: notificationDeadLetterQueue,
        retryAttempts: 8,
        maxEventAge: Duration.hours(24),
      })],
    });

    this.createRepositories();
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `hid-${this.configuration.name}`,
      containerInsightsV2: ecs.ContainerInsights.ENABLED,
      enableFargateCapacityProviders: true,
    });
    const namespace = new cloudmap.PrivateDnsNamespace(this, 'ServiceNamespace', {
      name: `services.${this.configuration.name}.hid`,
      vpc,
      description: 'Gateway-only discovery for private HID API tasks',
    });

    const runtimeSecrets = this.importRuntimeSecrets();
    const securityGroups = this.createRuntimeSecurityGroups(vpc);
    if (this.configuration.interfaceEndpoints.length > 0) {
      for (const securityGroup of Object.values(securityGroups)) {
        endpointSecurityGroup.addIngressRule(securityGroup, ec2.Port.tcp(443), 'Private tasks use approved AWS interface endpoints');
      }
    }

    const privateZone = new route53.PrivateHostedZone(this, 'InternalServiceZone', {
      zoneName: `internal.${this.configuration.name}.${this.parameter('RootDomainName').valueAsString}`,
      vpc,
      comment: 'Private TLS service names; never browser-addressable',
    });
    let internalLoadBalancerSecurityGroup: ec2.SecurityGroup | undefined;
    let internalLoadBalancer: elasticloadbalancingv2.ApplicationLoadBalancer | undefined;
    let internalListener: elasticloadbalancingv2.ApplicationListener | undefined;
    if (this.configuration.runtimeIngressEnabled) {
      internalLoadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'InternalLoadBalancerSecurityGroup', {
        vpc,
        allowAllOutbound: false,
        description: 'Internal HTTPS service boundary for server-to-server calls',
      });
      internalLoadBalancer = new elasticloadbalancingv2.ApplicationLoadBalancer(this, 'InternalLoadBalancer', {
        vpc,
        internetFacing: false,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroup: internalLoadBalancerSecurityGroup,
        deletionProtection: this.configuration.name === 'production',
      });
      const internalCertificate = acm.Certificate.fromCertificateArn(
        this,
        'InternalCertificate',
        this.parameter('InternalCertificateArn').valueAsString,
      );
      internalListener = internalLoadBalancer.addListener('InternalHttpsListener', {
        port: 443,
        protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
        certificates: [internalCertificate],
        sslPolicy: elasticloadbalancingv2.SslPolicy.RECOMMENDED_TLS,
        defaultAction: elasticloadbalancingv2.ListenerAction.fixedResponse(404, {
          contentType: 'application/problem+json',
          messageBody: '{"title":"Not found","status":404}',
        }),
      });
    }

    const apiServiceUrls = Object.fromEntries(Object.entries(serviceHostLabels).map(([name, label]) => [
      name,
      `https://${label}.${privateZone.zoneName}`,
    ])) as Partial<Record<WorkloadName, string>>;

    const resources = new Map<WorkloadName, RuntimeResource>();
    for (const name of workloadNames) {
      const definition = workloads[name];
      const resource = this.createRuntime({
        definition,
        vpc,
        namespace,
        securityGroup: securityGroups[name],
        endpointSecurityGroup,
        runtimeSecrets,
        apiServiceUrls,
        documentKey,
      });
      resources.set(name, resource);
      if (definition.hasDatabase) {
        resource.securityGroup.addEgressRule(databaseSecurityGroup, ec2.Port.tcp(5432), 'PostgreSQL only');
        databaseSecurityGroup.addIngressRule(resource.securityGroup, ec2.Port.tcp(5432), `${name} database login`);
      }
    }

    this.attachBusinessIam(resources, documentKey);
    this.connectRuntimeNetwork(resources, endpointSecurityGroup, internalLoadBalancerSecurityGroup);
    const internalTargetGroups = internalLoadBalancer && internalListener
      ? this.attachInternalTlsRoutes(resources, privateZone, internalLoadBalancer, internalListener)
      : new Map<WorkloadName, elasticloadbalancingv2.ApplicationTargetGroup>();

    const migration = this.createMigrationTask(runtimeSecrets, securityGroups, documentKey);
    migration.securityGroup.addEgressRule(databaseSecurityGroup, ec2.Port.tcp(5432), 'Migration PostgreSQL only');
    databaseSecurityGroup.addIngressRule(migration.securityGroup, ec2.Port.tcp(5432), 'Migration administrator only');
    if (this.configuration.interfaceEndpoints.length > 0) {
      endpointSecurityGroup.addIngressRule(migration.securityGroup, ec2.Port.tcp(443), 'Migration image, logs, and secret endpoints');
    }

    const publicEntry = this.configuration.runtimeIngressEnabled
      ? this.createPublicEntry(vpc, resources.get('gateway')!) : undefined;
    this.applicationLoadBalancer = publicEntry?.loadBalancer;
    this.configureRuntimeScaling(resources, internalTargetGroups, publicEntry?.targetGroup);
    if (this.configuration.profile === 'sleep') this.createStagingRdsRestopSchedule(database);
    this.createDatabaseAlarms(database);
    this.createRuntimeAlarms(resources);

    new CfnOutput(this, 'OriginDomainNameOutput', { value: this.publicApiHostname() });
    if (this.applicationLoadBalancer) {
      new CfnOutput(this, 'ApplicationLoadBalancerDnsName', { value: this.applicationLoadBalancer.loadBalancerDnsName });
    }
    new CfnOutput(this, 'DatabaseEndpoint', { value: database.dbInstanceEndpointAddress });
    if (database.secret) new CfnOutput(this, 'BootstrapDatabaseSecretArn', { value: database.secret.secretArn });
    new CfnOutput(this, 'DocumentBucketName', { value: this.documentBucket.bucketName });
    new CfnOutput(this, 'EventBusArn', { value: this.eventBus.eventBusArn });
    new CfnOutput(this, 'NotificationQueueArn', { value: this.notificationQueue.queueArn });
    new CfnOutput(this, 'MigrationTaskDefinitionArn', { value: migration.taskDefinition.taskDefinitionArn });
    new CfnOutput(this, 'MigrationSecurityGroupId', { value: migration.securityGroup.securityGroupId });
    new CfnOutput(this, 'ApplicationSubnetIds', {
      value: Fn.join(',', vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds),
    });

  }

  private addParameterContract(): void {
    const domainPattern = '^(?=.{1,253}$)(?!-)(?:[A-Za-z0-9-]+\\.)+[A-Za-z]{2,63}$';
    this.requiredParameter('RootDomainName', 'HID root domain used only for private service naming; Cloudflare owns public DNS', domainPattern);
    if (this.configuration.runtimeIngressEnabled) {
      this.requiredParameter('RegionalCertificateArn', `Regional ACM certificate ARN covering ${this.configuration.publicApiSubdomain}.<root-domain>`);
      this.requiredParameter('InternalCertificateArn', 'Regional ACM certificate ARN covering *.internal.<environment>.<root-domain>');
      this.requiredSecretParameter(
        this.configuration.originAuthorizationSecretParameter,
        `Independent ${this.configuration.name} Cloudflare origin authorization secret; never shared with another environment`,
      );
    }
    this.requiredParameter('S3PrefixListId', 'Region-specific Amazon S3 managed prefix list ID', '^pl-[a-f0-9]+$');
    this.requiredParameter('RdsCaBundleBase64', 'Base64-encoded current AWS RDS trust bundle; public certificate material, not a secret');
    this.requiredParameter('WorkloadIssuerUrl', 'Approved HTTPS workload issuer; external prerequisite', '^https://');
    this.requiredParameter('WorkloadJwksUrl', 'Approved HTTPS workload JWKS endpoint; external prerequisite', '^https://');
    this.requiredParameter('EhrWorkloadSubject', 'Exact deployment subject for EHR API');
    this.requiredParameter('LabWorkloadSubject', 'Exact deployment subject for Lab API');
    this.requiredParameter('PharmacyWorkloadSubject', 'Exact deployment subject for Pharmacy API');
    this.requiredParameter('OcrWorkloadSubject', 'Exact deployment subject for OCR API');
    this.requiredParameter('OutreachWorkloadSubject', 'Exact deployment subject for Outreach API');
    this.requiredParameter('IdentityWorkloadSubject', 'Exact deployment subject for Identity API');
    this.requiredParameter('AuthSecretArn', 'Secrets Manager JSON secret containing authSigningSecret and authLoginPepper');
    this.requiredParameter('IdentitySensitiveSecretArn', 'Secrets Manager JSON secret containing NIN keys, OTP HMAC key, and Turnstile secret');
    this.requiredParameter('NotificationProviderSecretArn', 'Secrets Manager JSON secret containing Novu, SES sender, Termii, Meta, and Infobip configuration');
    if (this.configuration.profile !== 'sleep') {
      for (const name of workloadNames) {
        const id = pascal(name);
        const scale = workloadScale(this.configuration.profile, name);
        this.numberParameter(`${id}DesiredCount`,
          `${name} task count after prerequisites pass; live minimum ${scale.minimumLiveTasks}, recommended ${scale.recommendedTasks}`,
          scale.recommendedTasks, scale.normalMaxTasks);
        this.boundedNumberParameter(`${id}ScalingCeiling`,
          `${name} autoscaling ceiling; values above ${scale.normalMaxTasks} require externally recorded emergency approval`,
          scale.normalMaxTasks, scale.normalMaxTasks, scale.reviewedEmergencyMaxTasks);
      }
    }

    for (const name of workloadNames.filter((item) => workloads[item].hasDatabase)) {
      this.requiredParameter(`${pascal(name)}DatabaseSecretArn`, `Secrets Manager JSON secret containing url for the ${name} non-owner LOGIN`);
    }
    this.requiredParameter('MigrationDatabaseSecretArn', 'Secrets Manager JSON secret containing url for the deployment-only migration administrator');

    for (const name of workloadNames) {
      this.requiredParameter(`${pascal(name)}ImageUri`, `Immutable ${name} image URI in repository@sha256:digest form`, '.+@sha256:[a-f0-9]{64}$');
    }
    this.requiredParameter('MigrationImageUri', 'Immutable EHR migration-target image URI in repository@sha256:digest form', '.+@sha256:[a-f0-9]{64}$');
  }

  private requiredParameter(id: string, description: string, allowedPattern?: string): CfnParameter {
    const parameter = new CfnParameter(this, id, {
      type: 'String',
      description,
      noEcho: id.endsWith('SecretArn'),
      ...(allowedPattern ? { allowedPattern } : {}),
    });
    this.parameters[id] = parameter;
    return parameter;
  }

  private requiredSecretParameter(id: string, description: string): CfnParameter {
    const parameter = new CfnParameter(this, id, {
      type: 'String', description, noEcho: true, minLength: 32, maxLength: 256,
      allowedPattern: '^[A-Za-z0-9._~+/-]{32,256}$',
    });
    this.parameters[id] = parameter;
    return parameter;
  }

  private numberParameter(id: string, description: string, defaultValue: number,
    maximum: number): CfnParameter {
    const parameter = new CfnParameter(this, id, {
      type: 'Number',
      description,
      default: defaultValue,
      minValue: 0,
      maxValue: maximum,
    });
    this.parameters[id] = parameter;
    return parameter;
  }

  private boundedNumberParameter(id: string, description: string, defaultValue: number,
    minimum: number, maximum: number): CfnParameter {
    const parameter = new CfnParameter(this, id, {
      type: 'Number', description, default: defaultValue, minValue: minimum, maxValue: maximum,
    });
    this.parameters[id] = parameter;
    return parameter;
  }

  private parameter(id: string): CfnParameter {
    const value = this.parameters[id];
    if (!value) throw new Error(`Missing infrastructure parameter ${id}`);
    return value;
  }

  private publicApiHostname(): string {
    return `${this.configuration.publicApiSubdomain}.${this.parameter('RootDomainName').valueAsString}`;
  }

  private createAwsEndpoints(vpc: ec2.Vpc, securityGroup: ec2.SecurityGroup): void {
    vpc.addGatewayEndpoint('S3GatewayEndpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });
    const services = {
      'ecr-api': ['EcrApi', ec2.InterfaceVpcEndpointAwsService.ECR],
      'ecr-docker': ['EcrDocker', ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER],
      logs: ['CloudWatchLogs', ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS],
      'secrets-manager': ['SecretsManager', ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER],
      kms: ['Kms', ec2.InterfaceVpcEndpointAwsService.KMS],
      eventbridge: ['EventBridge', new ec2.InterfaceVpcEndpointService(`com.amazonaws.${Aws.REGION}.events`, 443)],
      sqs: ['Sqs', ec2.InterfaceVpcEndpointAwsService.SQS],
      textract: ['Textract', new ec2.InterfaceVpcEndpointService(`com.amazonaws.${Aws.REGION}.textract`, 443)],
    } as const;
    for (const endpointName of this.configuration.interfaceEndpoints) {
      const [id, service] = services[endpointName];
      vpc.addInterfaceEndpoint(`${id}Endpoint`, {
        service,
        privateDnsEnabled: true,
        securityGroups: [securityGroup],
        subnets: this.configuration.interfaceEndpointAzCount === 1
          ? { subnets: [vpc.privateSubnets[0]!] }
          : { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      });
    }
  }

  private createRepositories(): void {
    for (const name of workloadNames) {
      const repository = new ecr.Repository(this, `${pascal(name)}Repository`, {
        repositoryName: `${this.configuration.name}/hid/${workloads[name].repository}`,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        encryption: ecr.RepositoryEncryption.AES_256,
        removalPolicy: this.configuration.removalPolicy,
        emptyOnDelete: this.configuration.name === 'development',
        lifecycleRules: [
          { description: 'Expire untagged build residue', tagStatus: ecr.TagStatus.UNTAGGED, maxImageAge: Duration.days(7) },
          { description: 'Bound retained immutable releases', maxImageCount: this.configuration.repositoryImageCount },
        ],
      });
      this.tagService(repository, name);
      new CfnOutput(this, `${pascal(name)}RepositoryUri`, { value: repository.repositoryUri });
    }
  }

  private importRuntimeSecrets(): SecretMap {
    const imported: SecretMap = {
      auth: this.importSecret('AuthSecret', 'AuthSecretArn'),
      identitySensitive: this.importSecret('IdentitySensitiveSecret', 'IdentitySensitiveSecretArn'),
      notificationProvider: this.importSecret('NotificationProviderSecret', 'NotificationProviderSecretArn'),
      migrationDatabase: this.importSecret('MigrationDatabaseSecret', 'MigrationDatabaseSecretArn'),
    };
    for (const name of workloadNames.filter((item) => workloads[item].hasDatabase)) {
      imported[`${name}Database`] = this.importSecret(`${pascal(name)}DatabaseSecret`, `${pascal(name)}DatabaseSecretArn`);
    }
    return imported;
  }

  private importSecret(id: string, parameterId: string): secretsmanager.ISecret {
    return secretsmanager.Secret.fromSecretAttributes(this, id, {
      secretCompleteArn: this.parameter(parameterId).valueAsString,
    });
  }

  private createRuntimeSecurityGroups(vpc: ec2.Vpc): Record<WorkloadName, ec2.SecurityGroup> {
    return Object.fromEntries(workloadNames.map((name) => [name, new ec2.SecurityGroup(this, `${pascal(name)}SecurityGroup`, {
      vpc,
      allowAllOutbound: false,
      description: `Network boundary for ${name}`,
    })])) as Record<WorkloadName, ec2.SecurityGroup>;
  }

  private createRuntime(input: {
    readonly definition: WorkloadDefinition;
    readonly vpc: ec2.Vpc;
    readonly namespace: cloudmap.PrivateDnsNamespace;
    readonly securityGroup: ec2.SecurityGroup;
    readonly endpointSecurityGroup: ec2.SecurityGroup;
    readonly runtimeSecrets: SecretMap;
    readonly apiServiceUrls: Partial<Record<WorkloadName, string>>;
    readonly documentKey: kms.Key;
  }): RuntimeResource {
    const { definition } = input;
    const id = pascal(definition.name);
    const executionRole = new iam.Role(this, `${id}ExecutionRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Image, log, and secret bootstrap role for ${definition.name}; not business AWS access`,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });
    const taskRole = new iam.Role(this, `${id}TaskRole`, {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Runtime business permissions for ${definition.name}`,
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, `${id}TaskDefinition`, {
      family: `hid-${this.configuration.name}-${definition.name}`,
      cpu: definition.cpu,
      memoryLimitMiB: definition.memoryMiB,
      executionRole,
      taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    const logGroup = new logs.LogGroup(this, `${id}LogGroup`, {
      logGroupName: `/hid/${this.configuration.name}/${definition.name}`,
      retention: this.configuration.logRetention,
      removalPolicy: this.configuration.removalPolicy,
    });
    this.tagService(taskDefinition, definition.name);
    this.tagService(logGroup, definition.name);
    const environment = this.environmentFor(definition.name, input.apiServiceUrls, input.documentKey);
    const secrets = this.secretsFor(definition.name, input.runtimeSecrets);
    const container = taskDefinition.addContainer(`${id}Container`, {
      containerName: definition.name,
      image: ecs.ContainerImage.fromRegistry(this.parameter(`${id}ImageUri`).valueAsString),
      environment,
      secrets,
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: definition.name }),
      readonlyRootFilesystem: definition.name !== 'gateway',
      healthCheck: definition.healthPath ? {
        command: definition.name === 'gateway'
          ? ['CMD-SHELL', `wget -q -O /dev/null http://127.0.0.1:${definition.port}${definition.healthPath} || exit 1`]
          : ['CMD-SHELL', `node -e "fetch('http://127.0.0.1:${definition.port}${definition.healthPath}').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"`],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(10),
        retries: 3,
        startPeriod: Duration.seconds(20),
      } : undefined,
    });
    if (definition.port) container.addPortMappings({ containerPort: definition.port, protocol: ecs.Protocol.TCP });
    if (Object.keys(definition.tokenFiles).length > 0) {
      taskDefinition.addVolume({ name: 'workload-tokens' });
      container.addMountPoints({ containerPath: tokenRoot, sourceVolume: 'workload-tokens', readOnly: true });
    }

    const desiredCount = this.configuration.profile === 'sleep'
      ? 0 : this.parameter(`${id}DesiredCount`).valueAsNumber;
    const service = new ecs.FargateService(this, `${id}Service`, {
      serviceName: `hid-${this.configuration.name}-${definition.name}`,
      cluster: this.cluster,
      taskDefinition,
      desiredCount,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [input.securityGroup],
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
      enableECSManagedTags: true,
      propagateTags: ecs.PropagatedTagSource.SERVICE,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      healthCheckGracePeriod: definition.port ? Duration.seconds(90) : undefined,
      cloudMapOptions: definition.name === 'gateway' || definition.name === 'ocr-worker'
        ? undefined
        : { cloudMapNamespace: input.namespace, name: definition.name, dnsRecordType: cloudmap.DnsRecordType.A },
    });
    this.tagService(service, definition.name);

    if (this.configuration.interfaceEndpoints.length > 0) {
      input.securityGroup.addEgressRule(input.endpointSecurityGroup, ec2.Port.tcp(443),
        'ECR, logs, Secrets Manager, KMS, and approved AWS APIs');
    }
    input.securityGroup.addEgressRule(ec2.Peer.prefixList(this.parameter('S3PrefixListId').valueAsString), ec2.Port.tcp(443), 'Amazon S3 only');
    if (this.configuration.natGateways > 0
        && !['gateway', 'ocr-worker', 'event-dispatcher'].includes(definition.name)) {
      input.securityGroup.addEgressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Approved HTTPS issuer/provider egress through NAT');
    }
    return { definition, taskDefinition, service, container, logGroup, securityGroup: input.securityGroup };
  }

  private environmentFor(
    name: WorkloadName,
    urls: Partial<Record<WorkloadName, string>>,
    documentKey: kms.Key,
  ): Record<string, string> {
    const commonApi = {
      NODE_ENV: 'production',
      HID_DEPLOYMENT_ENV: this.configuration.name === 'staging' ? 'staging' : 'production',
      DATABASE_SSL: 'true',
      DATABASE_SSL_ROOT_CERT_BASE64: this.parameter('RdsCaBundleBase64').valueAsString,
      DATABASE_POOL_MAX: String(name === 'ehr-api' ? 8 : workloads[name].databaseConnectionsPerTask),
      CORS_ORIGINS: this.configuration.browserSubdomains
        .map((subdomain) => `https://${subdomain}.${this.parameter('RootDomainName').valueAsString}`).join(','),
      TRUST_PROXY_CIDRS: this.configuration.vpcCidr,
    };
    const issuer = this.parameter('WorkloadIssuerUrl').valueAsString;
    const jwks = this.parameter('WorkloadJwksUrl').valueAsString;
    const subjects = {
      identity: this.parameter('IdentityWorkloadSubject').valueAsString,
      ehr: this.parameter('EhrWorkloadSubject').valueAsString,
      lab: this.parameter('LabWorkloadSubject').valueAsString,
      pharmacy: this.parameter('PharmacyWorkloadSubject').valueAsString,
      ocr: this.parameter('OcrWorkloadSubject').valueAsString,
      outreach: this.parameter('OutreachWorkloadSubject').valueAsString,
    };
    const base = { ...workloads[name].tokenFiles };
    switch (name) {
      case 'identity-api':
        return { ...commonApi, ...base, PORT: '3001', AUTH_MODE: 'local', AUTH_COOKIE_SECURE: 'true',
          AUTH_ISSUER: 'hid-identity', AUTH_AUDIENCE: 'hid-api',
          TURNSTILE_MODE: 'required', OTP_HMAC_KEY_VERSION: 'aws-v1',
          NOTIFICATION_API_URL: urls['notification-api']!, NOTIFICATION_SERVICE_IDENTITY_MODE: 'jwt',
          NIN_PROVIDER_MODE: 'unavailable', NIN_KEY_VERSION: 'aws-v1', IDENTITY_SERVICE_IDENTITY_MODE: 'jwt',
          WORKLOAD_ISSUER_URL: issuer, WORKLOAD_JWKS_URL: jwks, WORKLOAD_AUDIENCE: 'hid-identity-api',
          IDENTITY_EHR_CALLER_SUBJECT: subjects.ehr, IDENTITY_LAB_CALLER_SUBJECT: subjects.lab,
          IDENTITY_PHARMACY_CALLER_SUBJECT: subjects.pharmacy, IDENTITY_OCR_CALLER_SUBJECT: subjects.ocr,
          OUTREACH_CALLER_SUBJECT: subjects.outreach,
          ADMIN_IDENTITY_STATUS_URL: urls['identity-api']!, ADMIN_EHR_STATUS_URL: urls['ehr-api']!,
          ADMIN_LAB_STATUS_URL: urls['lab-api']!, ADMIN_PHARMACY_STATUS_URL: urls['pharmacy-api']!,
          ADMIN_OCR_STATUS_URL: urls['ocr-api']!, ADMIN_OUTREACH_STATUS_URL: urls['outreach-api']!,
          ADMIN_EVENT_DISPATCHER_STATUS_URL: urls['event-dispatcher']! };
      case 'ehr-api':
        return { ...commonApi, ...base, PORT: '3002',
          IDENTITY_API_URL: urls['identity-api']!, LAB_API_URL: urls['lab-api']!, PHARMACY_API_URL: urls['pharmacy-api']!,
          IDENTITY_SERVICE_IDENTITY_MODE: 'jwt', LAB_SERVICE_IDENTITY_MODE: 'jwt', PHARMACY_SERVICE_IDENTITY_MODE: 'jwt',
          EHR_SERVICE_IDENTITY_MODE: 'jwt', EHR_WORKLOAD_ISSUER_URL: issuer, EHR_WORKLOAD_JWKS_URL: jwks,
          EHR_WORKLOAD_AUDIENCE: 'hid-ehr-api', EHR_OCR_CALLER_SUBJECT: subjects.ocr,
          OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'jwt', OUTREACH_CALLER_SUBJECT: subjects.outreach,
          WORKLOAD_DATABASE_POOL_MAX: '3', STORAGE_MODE: 's3', S3_REGION: Aws.REGION, S3_BUCKET: this.documentBucket.bucketName,
          S3_FORCE_PATH_STYLE: 'false', S3_KMS_KEY_ID: documentKey.keyArn };
      case 'lab-api':
        return { ...commonApi, ...base, PORT: '3003', IDENTITY_API_URL: urls['identity-api']!,
          IDENTITY_SERVICE_IDENTITY_MODE: 'jwt', LAB_SERVICE_IDENTITY_MODE: 'jwt',
          LAB_WORKLOAD_ISSUER_URL: issuer, LAB_WORKLOAD_JWKS_URL: jwks, LAB_WORKLOAD_AUDIENCE: 'hid-lab-api',
          LAB_EHR_CALLER_SUBJECT: subjects.ehr, LAB_OCR_CALLER_SUBJECT: subjects.ocr };
      case 'pharmacy-api':
        return { ...commonApi, ...base, PORT: '3004', IDENTITY_API_URL: urls['identity-api']!,
          IDENTITY_SERVICE_IDENTITY_MODE: 'jwt', PHARMACY_SERVICE_IDENTITY_MODE: 'jwt',
          PHARMACY_WORKLOAD_ISSUER_URL: issuer, PHARMACY_WORKLOAD_JWKS_URL: jwks,
          PHARMACY_WORKLOAD_AUDIENCE: 'hid-pharmacy-api', PHARMACY_EHR_CALLER_SUBJECT: subjects.ehr,
          PHARMACY_OCR_CALLER_SUBJECT: subjects.ocr };
      case 'ocr-api':
        return { ...commonApi, ...base, PORT: '3005', IDENTITY_API_URL: urls['identity-api']!,
          EHR_API_URL: urls['ehr-api']!, LAB_API_URL: urls['lab-api']!, PHARMACY_API_URL: urls['pharmacy-api']!,
          IDENTITY_SERVICE_IDENTITY_MODE: 'jwt', EHR_SERVICE_IDENTITY_MODE: 'jwt',
          LAB_SERVICE_IDENTITY_MODE: 'jwt', PHARMACY_SERVICE_IDENTITY_MODE: 'jwt' };
      case 'outreach-api':
        return { ...commonApi, ...base, PORT: '3006', IDENTITY_API_URL: urls['identity-api']!,
          OUTREACH_IDENTITY_SERVICE_IDENTITY_MODE: 'jwt' };
      case 'notification-api':
        return { NODE_ENV: 'production', PORT: '3007', NOTIFICATION_PROVIDER_MODE: 'live',
          NOTIFICATION_WORKLOAD_IDENTITY_MODE: 'jwt', WORKLOAD_ISSUER_URL: issuer,
          WORKLOAD_JWKS_URL: jwks, WORKLOAD_AUDIENCE: 'hid-notification-api',
          IDENTITY_CALLER_SUBJECT: subjects.identity, AWS_REGION: Aws.REGION };
      case 'notification-worker':
        return { NODE_ENV: 'production', NOTIFICATION_WORKER_ENABLED: 'true',
          NOTIFICATION_WORKER_ID: `notification-worker-${this.configuration.name}`,
          NOTIFICATION_WORKER_STATUS_HOST: '0.0.0.0', NOTIFICATION_WORKER_STATUS_PORT: '3008',
          NOTIFICATION_WORKER_DATABASE_SSL: 'true',
          NOTIFICATION_WORKER_DATABASE_SSL_ROOT_CERT_BASE64: this.parameter('RdsCaBundleBase64').valueAsString,
          NOTIFICATION_WORKER_DATABASE_POOL_MAX: String(workloads[name].databaseConnectionsPerTask),
          NOTIFICATION_WORKER_QUEUE_URL: this.notificationQueue.queueUrl,
          NOVU_MODE: 'live', AWS_REGION: Aws.REGION };
      case 'ocr-worker':
        return { NODE_ENV: 'production', OCR_PROVIDER: 'textract', OCR_WORKER_SUBJECT: subjects.ocr,
          OCR_WORKER_DATABASE_SSL: 'true', OCR_WORKER_DATABASE_SSL_ROOT_CERT_BASE64: this.parameter('RdsCaBundleBase64').valueAsString,
          OCR_WORKER_POOL_MAX: String(workloads[name].databaseConnectionsPerTask), OCR_WORKER_CONCURRENCY: '2',
          AWS_REGION: Aws.REGION, S3_FORCE_PATH_STYLE: 'false' };
      case 'event-dispatcher':
        return { NODE_ENV: 'production', EVENT_DISPATCHER_ENABLED: 'true', EVENT_DISPATCHER_TRANSPORT: 'eventbridge',
          EVENT_DISPATCHER_DATABASE_SSL: 'true', EVENT_DISPATCHER_DATABASE_SSL_ROOT_CERT_BASE64: this.parameter('RdsCaBundleBase64').valueAsString,
          EVENT_DISPATCHER_POOL_MAX: String(workloads[name].databaseConnectionsPerTask),
          EVENT_DISPATCHER_STATUS_HOST: '0.0.0.0', EVENT_DISPATCHER_STATUS_PORT: '3010',
          EVENTBRIDGE_EVENT_BUS_NAME: this.eventBus.eventBusName, AWS_REGION: Aws.REGION };
      case 'gateway': {
        const namespace = `services.${this.configuration.name}.hid`;
        return { IDENTITY_API_UPSTREAM: `http://identity-api.${namespace}:3001`, EHR_API_UPSTREAM: `http://ehr-api.${namespace}:3002`,
          LAB_API_UPSTREAM: `http://lab-api.${namespace}:3003`, PHARMACY_API_UPSTREAM: `http://pharmacy-api.${namespace}:3004`,
          OCR_API_UPSTREAM: `http://ocr-api.${namespace}:3005`, OUTREACH_API_UPSTREAM: `http://outreach-api.${namespace}:3006` };
      }
    }
  }

  private secretsFor(name: WorkloadName, secrets: SecretMap): Record<string, ecs.Secret> {
    const output: Record<string, ecs.Secret> = {};
    const databaseField = databaseSecretFields[name];
    if (databaseField) output[databaseField] = ecs.Secret.fromSecretsManager(secrets[`${name}Database`]!, 'url');
    if (name === 'identity-api') {
      output.AUTH_SIGNING_SECRET = ecs.Secret.fromSecretsManager(secrets.auth!, 'authSigningSecret');
      output.AUTH_LOGIN_PEPPER = ecs.Secret.fromSecretsManager(secrets.auth!, 'authLoginPepper');
    }
    if (name === 'identity-api') {
      output.NIN_LOOKUP_HMAC_KEY_B64 = ecs.Secret.fromSecretsManager(secrets.identitySensitive!, 'ninLookupHmacKeyB64');
      output.NIN_ENCRYPTION_KEY_B64 = ecs.Secret.fromSecretsManager(secrets.identitySensitive!, 'ninEncryptionKeyB64');
      output.OTP_HMAC_KEY_B64 = ecs.Secret.fromSecretsManager(secrets.identitySensitive!, 'otpHmacKeyB64');
      output.TURNSTILE_SECRET_KEY = ecs.Secret.fromSecretsManager(secrets.identitySensitive!, 'turnstileSecretKey');
    }
    if (name === 'ehr-api') {
      output.WORKLOAD_DATABASE_URL = ecs.Secret.fromSecretsManager(secrets[`${name}Database`]!, 'scannerUrl');
    }
    if (name === 'notification-api') {
      for (const [environmentName, field] of Object.entries({
        SES_FROM_ADDRESS: 'sesFromAddress', TERMII_BASE_URL: 'termiiBaseUrl',
        TERMII_API_KEY: 'termiiApiKey', TERMII_SENDER_ID: 'termiiSenderId',
        META_PHONE_NUMBER_ID: 'metaPhoneNumberId', META_ACCESS_TOKEN: 'metaAccessToken',
        META_OTP_TEMPLATE_NAME: 'metaOtpTemplateName', INFOBIP_BASE_URL: 'infobipBaseUrl',
        INFOBIP_API_KEY: 'infobipApiKey', INFOBIP_EMAIL_FROM: 'infobipEmailFrom',
        INFOBIP_SMS_SENDER: 'infobipSmsSender', INFOBIP_WHATSAPP_SENDER: 'infobipWhatsAppSender',
        INFOBIP_WHATSAPP_OTP_TEMPLATE_ID: 'infobipWhatsAppOtpTemplateId',
      })) output[environmentName] = ecs.Secret.fromSecretsManager(secrets.notificationProvider!, field);
    }
    if (name === 'notification-worker') {
      output.NOVU_API_KEY = ecs.Secret.fromSecretsManager(secrets.notificationProvider!, 'novuApiKey');
    }
    return output;
  }

  private attachBusinessIam(resources: Map<WorkloadName, RuntimeResource>, documentKey: kms.Key): void {
    const ehr = resources.get('ehr-api')!;
    ehr.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'DocumentBucketMetadataAndObjects',
      actions: ['s3:HeadBucket', 's3:GetBucketVersioning'],
      resources: [this.documentBucket.bucketArn],
    }));
    ehr.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'DocumentObjectReadWrite',
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
      resources: [this.documentBucket.arnForObjects('*')],
    }));
    ehr.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'DocumentKeyUse', actions: ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey'], resources: [documentKey.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `s3.${Aws.REGION}.amazonaws.com` } },
    }));

    const worker = resources.get('ocr-worker')!;
    worker.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadExactDocumentVersions', actions: ['s3:HeadBucket'], resources: [this.documentBucket.bucketArn],
    }));
    worker.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'ReadExactDocumentObjects', actions: ['s3:GetObject', 's3:GetObjectVersion'], resources: [this.documentBucket.arnForObjects('*')],
    }));
    worker.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'DecryptDocumentObjects', actions: ['kms:Decrypt'], resources: [documentKey.keyArn],
      conditions: { StringEquals: { 'kms:ViaService': `s3.${Aws.REGION}.amazonaws.com` } },
    }));
    worker.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'UseTextractDocumentOperations',
      actions: ['textract:AnalyzeDocument', 'textract:StartDocumentTextDetection', 'textract:GetDocumentTextDetection'],
      resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': Aws.REGION } },
    }));

    resources.get('event-dispatcher')!.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'PutOnlyToHidEventBus', actions: ['events:PutEvents'], resources: [this.eventBus.eventBusArn],
    }));
    resources.get('notification-api')!.taskDefinition.taskRole.addToPrincipalPolicy(new iam.PolicyStatement({
      sid: 'SendOtpEmailWithSesV2', actions: ['ses:SendEmail'], resources: ['*'],
      conditions: { StringEquals: { 'aws:RequestedRegion': Aws.REGION } },
    }));
    this.notificationQueue.grantConsumeMessages(resources.get('notification-worker')!.taskDefinition.taskRole);
  }

  private connectRuntimeNetwork(
    resources: Map<WorkloadName, RuntimeResource>,
    endpointSecurityGroup: ec2.SecurityGroup,
    internalLoadBalancerSecurityGroup?: ec2.SecurityGroup,
  ): void {
    const gateway = resources.get('gateway')!;
    for (const name of apiNames.filter((item) => item !== 'event-dispatcher')) {
      const target = resources.get(name)!;
      target.securityGroup.addIngressRule(gateway.securityGroup, ec2.Port.tcp(target.definition.port!), 'Gateway API route only');
      gateway.securityGroup.addEgressRule(target.securityGroup, ec2.Port.tcp(target.definition.port!), `Route to ${name}`);
    }
    for (const resource of resources.values()) {
      if (internalLoadBalancerSecurityGroup && serviceHostLabels[resource.definition.name]) {
        resource.securityGroup.addIngressRule(internalLoadBalancerSecurityGroup, ec2.Port.tcp(resource.definition.port!), 'Internal TLS load balancer only');
        internalLoadBalancerSecurityGroup.addEgressRule(resource.securityGroup, ec2.Port.tcp(resource.definition.port!), `${resource.definition.name} target only`);
      }
      if (internalLoadBalancerSecurityGroup
          && !['gateway', 'ocr-worker', 'event-dispatcher'].includes(resource.definition.name)) {
        resource.securityGroup.addEgressRule(internalLoadBalancerSecurityGroup, ec2.Port.tcp(443), 'HTTPS owner-service calls');
        internalLoadBalancerSecurityGroup.addIngressRule(resource.securityGroup, ec2.Port.tcp(443), `${resource.definition.name} HTTPS calls`);
      }
    }
    if (this.configuration.interfaceEndpoints.length > 0) {
      for (const resource of resources.values()) {
        resource.securityGroup.addEgressRule(endpointSecurityGroup, ec2.Port.tcp(443), 'Operational AWS endpoints');
      }
    }
  }

  private attachInternalTlsRoutes(
    resources: Map<WorkloadName, RuntimeResource>,
    privateZone: route53.PrivateHostedZone,
    loadBalancer: elasticloadbalancingv2.ApplicationLoadBalancer,
    listener: elasticloadbalancingv2.ApplicationListener,
  ): Map<WorkloadName, elasticloadbalancingv2.ApplicationTargetGroup> {
    const targetGroups = new Map<WorkloadName, elasticloadbalancingv2.ApplicationTargetGroup>();
    let priority = 10;
    for (const [name, label] of Object.entries(serviceHostLabels) as Array<[WorkloadName, string]>) {
      const resource = resources.get(name)!;
      const hostName = `${label}.${privateZone.zoneName}`;
      const targetGroup = listener.addTargets(`${pascal(name)}InternalTarget`, {
        priority: priority++,
        conditions: [elasticloadbalancingv2.ListenerCondition.hostHeaders([hostName])],
        port: resource.definition.port!,
        protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
        targets: [resource.service],
        deregistrationDelay: Duration.seconds(name === 'event-dispatcher' ? 60 : 30),
        healthCheck: { path: resource.definition.healthPath, healthyHttpCodes: '200', interval: Duration.seconds(30) },
      });
      targetGroups.set(name, targetGroup);
      new route53.ARecord(this, `${pascal(name)}InternalAlias`, {
        zone: privateZone,
        recordName: label,
        target: route53.RecordTarget.fromAlias(new route53Targets.LoadBalancerTarget(loadBalancer)),
      });
    }
    return targetGroups;
  }

  private createMigrationTask(
    runtimeSecrets: SecretMap,
    securityGroups: Record<WorkloadName, ec2.SecurityGroup>,
    documentKey: kms.Key,
  ): { readonly taskDefinition: ecs.FargateTaskDefinition; readonly securityGroup: ec2.SecurityGroup } {
    void securityGroups;
    void documentKey;
    const executionRole = new iam.Role(this, 'MigrationExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'Image, log, and secret bootstrap for the controlled migration job',
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')],
    });
    const taskRole = new iam.Role(this, 'MigrationTaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: 'No business AWS API access; database authority is the deployment-only LOGIN secret',
    });
    const taskDefinition = new ecs.FargateTaskDefinition(this, 'MigrationTaskDefinition', {
      family: `hid-${this.configuration.name}-database-migration`,
      cpu: 512,
      memoryLimitMiB: 1_024,
      executionRole,
      taskRole,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64, operatingSystemFamily: ecs.OperatingSystemFamily.LINUX },
    });
    const logGroup = new logs.LogGroup(this, 'MigrationLogGroup', {
      logGroupName: `/hid/${this.configuration.name}/database-migration`,
      retention: this.configuration.logRetention,
      removalPolicy: this.configuration.removalPolicy,
    });
    this.tagService(taskDefinition, 'database-migration');
    this.tagService(logGroup, 'database-migration');
    taskDefinition.addContainer('MigrationContainer', {
      containerName: 'database-migration',
      image: ecs.ContainerImage.fromRegistry(this.parameter('MigrationImageUri').valueAsString),
      command: ['--plan'],
      environment: { NODE_ENV: 'production', DATABASE_SSL: 'true', DATABASE_SSL_ROOT_CERT_BASE64: this.parameter('RdsCaBundleBase64').valueAsString },
      secrets: { DATABASE_URL: ecs.Secret.fromSecretsManager(runtimeSecrets.migrationDatabase!, 'url') },
      logging: ecs.LogDrivers.awsLogs({ logGroup, streamPrefix: 'migration' }),
      readonlyRootFilesystem: true,
    });
    const securityGroup = new ec2.SecurityGroup(this, 'MigrationSecurityGroup', {
      vpc: this.cluster.vpc,
      allowAllOutbound: false,
      description: 'One-shot migration job: RDS and operational AWS endpoints only',
    });
    return { taskDefinition, securityGroup };
  }

  private configureRuntimeScaling(
    resources: Map<WorkloadName, RuntimeResource>,
    internalTargetGroups: Map<WorkloadName, elasticloadbalancingv2.ApplicationTargetGroup>,
    gatewayTargetGroup?: elasticloadbalancingv2.ApplicationTargetGroup,
  ): void {
    if (!this.configuration.autoscalingEnabled) return;
    for (const [name, resource] of resources) {
      const id = pascal(name);
      const definition = resource.definition;
      const desiredCount = this.parameter(`${id}DesiredCount`).valueAsNumber;
      const scaling = resource.service.autoScaleTaskCount({
        minCapacity: desiredCount,
        maxCapacity: this.parameter(`${id}ScalingCeiling`).valueAsNumber,
      });
      const cooldowns = {
        scaleInCooldown: Duration.seconds(definition.scaleInCooldownSeconds),
        scaleOutCooldown: Duration.seconds(definition.scaleOutCooldownSeconds),
      };
      scaling.scaleOnCpuUtilization(`${id}CpuScaling`, {
        targetUtilizationPercent: definition.cpuTargetPercent, ...cooldowns,
      });
      scaling.scaleOnMemoryUtilization(`${id}MemoryScaling`, {
        targetUtilizationPercent: definition.memoryTargetPercent, ...cooldowns,
      });

      if (definition.scalingKind === 'request') {
        const targetGroup = name === 'gateway' ? gatewayTargetGroup : internalTargetGroups.get(name);
        if (targetGroup && definition.requestTargetPerMinute) {
          scaling.scaleOnRequestCount(`${id}RequestScaling`, {
            requestsPerTarget: definition.requestTargetPerMinute, targetGroup, ...cooldowns,
          });
          this.createRequestSignalAlarms(name, targetGroup);
        }
      } else if (definition.scalingKind === 'notification-queue') {
        scaling.scaleToTrackCustomMetric(`${id}VisibleBacklogScaling`, {
          metric: this.notificationQueue.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(1) }),
          targetValue: 20,
          ...cooldowns,
        });
      } else if (definition.scalingKind === 'ocr-backlog') {
        scaling.scaleToTrackCustomMetric(`${id}QueueDepthScaling`, {
          metric: this.operationalMetric('HID/OCR', 'QueueDepth'), targetValue: 10, ...cooldowns,
        });
      } else {
        scaling.scaleToTrackCustomMetric(`${id}OutboxDepthScaling`, {
          metric: this.operationalMetric('HID/EventDelivery', 'PendingCount'), targetValue: 25, ...cooldowns,
        });
      }
    }
  }

  private createRequestSignalAlarms(name: WorkloadName,
    targetGroup: elasticloadbalancingv2.ApplicationTargetGroup): void {
    const latency = new cloudwatch.Alarm(this, `${pascal(name)}TargetLatencyAlarm`, {
      alarmDescription: `${name} p95 target latency requires review; dimensions are low-cardinality and PHI-free`,
      metric: targetGroup.metrics.targetResponseTime({ statistic: 'p95', period: Duration.minutes(5) }),
      threshold: 2,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const errors = new cloudwatch.Alarm(this, `${pascal(name)}TargetErrorAlarm`, {
      alarmDescription: `${name} safe aggregate target 5xx signal requires review`,
      metric: targetGroup.metrics.httpCodeTarget(elasticloadbalancingv2.HttpCodeTarget.TARGET_5XX_COUNT, {
        statistic: 'Sum', period: Duration.minutes(5),
      }),
      threshold: 5,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.tagService(latency, name);
    this.tagService(errors, name);
  }

  private operationalMetric(namespace: string, metricName: string): cloudwatch.Metric {
    return new cloudwatch.Metric({
      namespace,
      metricName,
      dimensionsMap: { Environment: this.configuration.name },
      statistic: 'Average',
      period: Duration.minutes(1),
    });
  }

  private createStagingRdsRestopSchedule(database: rds.DatabaseInstance): void {
    if (this.configuration.name !== 'staging') {
      throw new Error('The stopped-RDS re-stop guard is staging-only');
    }
    const role = new iam.Role(this, 'StagingRdsRestopRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Sleep-mode only: re-stop the exact staging RDS instance after AWS automatic restart',
    });
    role.addToPolicy(new iam.PolicyStatement({
      sid: 'StopExactStagingDatabaseOnly',
      actions: ['rds:StopDBInstance'],
      resources: [database.instanceArn],
    }));
    new scheduler.CfnSchedule(this, 'StagingRdsRestopSchedule', {
      name: 'hid-staging-sleep-rds-restop',
      description: 'One bounded daily attempt while the sleep profile is deployed; zero Scheduler retries',
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0 3 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      state: 'ENABLED',
      target: {
        arn: 'arn:aws:scheduler:::aws-sdk:rds:stopDBInstance',
        roleArn: role.roleArn,
        input: JSON.stringify({ DbInstanceIdentifier: `hid-${this.configuration.name}-postgres` }),
        retryPolicy: { maximumEventAgeInSeconds: 60, maximumRetryAttempts: 0 },
      },
    });
  }

  private createPublicEntry(vpc: ec2.Vpc, gateway: RuntimeResource): {
    readonly loadBalancer: elasticloadbalancingv2.ApplicationLoadBalancer;
    readonly targetGroup: elasticloadbalancingv2.ApplicationTargetGroup;
  } {
    const loadBalancerSecurityGroup = new ec2.SecurityGroup(this, 'PublicLoadBalancerSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'Cloudflare Worker API origin HTTPS; WAF requires the independent origin secret',
    });
    loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'Cloudflare API origin over HTTPS; WAF authenticates the request');
    loadBalancerSecurityGroup.addIngressRule(ec2.Peer.anyIpv6(), ec2.Port.tcp(443), 'Cloudflare API origin over HTTPS; WAF authenticates the request');
    loadBalancerSecurityGroup.addEgressRule(gateway.securityGroup, ec2.Port.tcp(3000), 'Gateway target only');
    gateway.securityGroup.addIngressRule(loadBalancerSecurityGroup, ec2.Port.tcp(3000), 'Public ALB only');

    const loadBalancer = new elasticloadbalancingv2.ApplicationLoadBalancer(this, 'PublicLoadBalancer', {
      vpc,
      internetFacing: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      securityGroup: loadBalancerSecurityGroup,
      deletionProtection: this.configuration.name === 'production',
      dropInvalidHeaderFields: true,
      ipAddressType: elasticloadbalancingv2.IpAddressType.DUAL_STACK,
    });
    const originWebAcl = new wafv2.CfnWebACL(this, 'ApiOriginWebAcl', {
      scope: 'REGIONAL',
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `hid-${this.configuration.name}-api-origin`,
        sampledRequestsEnabled: false,
      },
      rules: [
        {
          name: 'RequireCloudflareOriginSecret', priority: 0, action: { block: {} },
          statement: { notStatement: { statement: { byteMatchStatement: {
            fieldToMatch: { singleHeader: {
              Name: 'x-hid-origin-authorization',
            } as unknown as wafv2.CfnWebACL.SingleHeaderProperty },
            positionalConstraint: 'EXACTLY',
            searchString: this.parameter(this.configuration.originAuthorizationSecretParameter).valueAsString,
            textTransformations: [{ priority: 0, type: 'NONE' }],
          } } } },
          visibilityConfig: { cloudWatchMetricsEnabled: true,
            metricName: `hid-${this.configuration.name}-origin-auth`, sampledRequestsEnabled: false },
        },
        regionalManagedRule('AwsCommonRules', 10, 'AWSManagedRulesCommonRuleSet'),
        regionalManagedRule('AwsKnownBadInputs', 20, 'AWSManagedRulesKnownBadInputsRuleSet'),
        {
          name: 'ApiOriginRateLimit', priority: 30, action: { block: {} },
          statement: { rateBasedStatement: { aggregateKeyType: 'IP', limit: 2_000 } },
          visibilityConfig: { cloudWatchMetricsEnabled: true,
            metricName: `hid-${this.configuration.name}-origin-rate`, sampledRequestsEnabled: false },
        },
      ],
    });
    new wafv2.CfnWebACLAssociation(this, 'ApiOriginWebAclAssociation', {
      resourceArn: loadBalancer.loadBalancerArn,
      webAclArn: originWebAcl.attrArn,
    });
    const certificate = acm.Certificate.fromCertificateArn(this, 'RegionalCertificate', this.parameter('RegionalCertificateArn').valueAsString);
    const listener = loadBalancer.addListener('HttpsListener', {
      port: 443,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTPS,
      certificates: [certificate],
      sslPolicy: elasticloadbalancingv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: elasticloadbalancingv2.ListenerAction.fixedResponse(503, {
        contentType: 'application/problem+json',
        messageBody: '{"title":"Service unavailable","status":503}',
      }),
    });
    const targetGroup = listener.addTargets('GatewayTarget', {
      priority: 1,
      conditions: [elasticloadbalancingv2.ListenerCondition.pathPatterns(['/*'])],
      port: 3000,
      protocol: elasticloadbalancingv2.ApplicationProtocol.HTTP,
      targets: [gateway.service],
      deregistrationDelay: Duration.seconds(30),
      healthCheck: { path: '/gateway-health/ready', healthyHttpCodes: '200', interval: Duration.seconds(30) },
    });

    return { loadBalancer, targetGroup };
  }

  private createDatabaseAlarms(database: rds.DatabaseInstance): void {
    const missingData = this.configuration.profile === 'sleep'
      ? cloudwatch.TreatMissingData.NOT_BREACHING : cloudwatch.TreatMissingData.BREACHING;
    const cpu = new cloudwatch.Alarm(this, 'DatabaseCpuAlarm', {
      alarmDescription: 'Sustained RDS CPU requires investigation; no PHI is emitted',
      metric: database.metricCPUUtilization({ period: Duration.minutes(5) }),
      threshold: 80,
      evaluationPeriods: 3,
      datapointsToAlarm: 3,
      treatMissingData: missingData,
    });
    const storage = new cloudwatch.Alarm(this, 'DatabaseFreeStorageAlarm', {
      alarmDescription: 'RDS free storage below 20 GiB',
      metric: database.metricFreeStorageSpace({ period: Duration.minutes(5) }),
      threshold: 20 * 1_024 * 1_024 * 1_024,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 2,
      treatMissingData: missingData,
    });
    const connections = new cloudwatch.Alarm(this, 'DatabaseConnectionsAlarm', {
      alarmDescription: 'RDS connections approach the reviewed environment connection budget',
      metric: database.metricDatabaseConnections({ period: Duration.minutes(5), statistic: 'Maximum' }),
      threshold: Math.max(1, Math.floor(this.configuration.databaseConnectionBudget * 0.85)),
      evaluationPeriods: 3,
      treatMissingData: missingData,
    });
    const freeMemory = new cloudwatch.Alarm(this, 'DatabaseFreeMemoryAlarm', {
      alarmDescription: 'RDS free memory is below 256 MiB and requires capacity/query review',
      metric: database.metricFreeableMemory({ period: Duration.minutes(5), statistic: 'Minimum' }),
      threshold: 256 * 1_024 * 1_024,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: missingData,
    });
    for (const alarm of [cpu, storage, connections, freeMemory]) this.tagService(alarm, 'platform-database');
  }

  private createRuntimeAlarms(resources: Map<WorkloadName, RuntimeResource>): void {
    if (this.configuration.profile === 'sleep') return;
    for (const name of ['gateway', 'identity-api', 'ehr-api', 'ocr-worker',
      'notification-api', 'notification-worker', 'event-dispatcher'] as const) {
      const resource = resources.get(name)!;
      const metric = new cloudwatch.Metric({
        namespace: 'ECS/ContainerInsights',
        metricName: 'RunningTaskCount',
        dimensionsMap: { ClusterName: this.cluster.clusterName, ServiceName: resource.service.serviceName },
        statistic: 'Minimum',
        period: Duration.minutes(1),
      });
      const liveMinimum = workloadScale(this.configuration.profile, name).minimumLiveTasks;
      const alarm = new cloudwatch.Alarm(this, `${pascal(name)}RunningTaskAlarm`, {
        alarmDescription: `${name} running task count fell below its live-mode minimum`,
        metric,
        threshold: Math.max(1, liveMinimum),
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      });
      this.tagService(alarm, name);
    }
    const terminalMetric = new logs.MetricFilter(this, 'DispatcherTerminalFailureMetric', {
      logGroup: resources.get('event-dispatcher')!.logGroup,
      filterPattern: logs.FilterPattern.stringValue('$.event', '=', 'event_dispatcher.failed_terminal'),
      metricNamespace: 'HID/EventDelivery',
      metricName: 'TerminalFailures',
      metricValue: '1',
      defaultValue: 0,
    });
    const dispatcherTerminal = new cloudwatch.Alarm(this, 'DispatcherTerminalFailureAlarm', {
      alarmDescription: 'At least one event reached terminal delivery failure; payload is never a metric dimension',
      metric: terminalMetric.metric({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.tagService(dispatcherTerminal, 'event-dispatcher');
    const ocrFailureMetric = new logs.MetricFilter(this, 'OcrWorkerFailureMetric', {
      logGroup: resources.get('ocr-worker')!.logGroup,
      filterPattern: logs.FilterPattern.stringValue('$.event', '=', 'ocr.worker.loop_error'),
      metricNamespace: 'HID/OCR',
      metricName: 'WorkerLoopErrors',
      metricValue: '1',
      defaultValue: 0,
    });
    const ocrFailures = new cloudwatch.Alarm(this, 'OcrWorkerFailureAlarm', {
      alarmDescription: 'OCR worker loop failures exceed the bounded threshold; no OCR text is emitted',
      metric: ocrFailureMetric.metric({ statistic: 'Sum', period: Duration.minutes(5) }),
      threshold: 3,
      evaluationPeriods: 2,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.tagService(ocrFailures, 'ocr-worker');

    const structuredLogMetric = (id: string, logGroup: logs.ILogGroup, event: string,
      namespace: string, metricName: string, metricValue: string): logs.MetricFilter =>
      new logs.MetricFilter(this, id, {
        logGroup,
        filterPattern: logs.FilterPattern.stringValue('$.event', '=', event),
        metricNamespace: namespace,
        metricName,
        metricValue,
        dimensions: { Environment: this.configuration.name },
      });
    const ocrLogGroup = resources.get('ocr-worker')!.logGroup;
    const ocrApiLogGroup = resources.get('ocr-api')!.logGroup;
    structuredLogMetric('OcrQueueDepthMetric', ocrLogGroup, 'ocr.job.claimed',
      'HID/OCR', 'QueueDepth', '$.queueDepth');
    structuredLogMetric('OcrQueueAgeMetric', ocrLogGroup, 'ocr.job.claimed',
      'HID/OCR', 'OldestQueueAgeSeconds', '$.oldestQueueAgeSeconds');
    structuredLogMetric('OcrClaimThroughputMetric', ocrLogGroup, 'ocr.job.claimed',
      'HID/OCR', 'ClaimThroughput', '$.claimedJobs');
    structuredLogMetric('OcrPagesProcessedMetric', ocrLogGroup, 'ocr.job.completed',
      'HID/OCR', 'PagesProcessed', '$.pagesProcessed');
    structuredLogMetric('OcrCompletedRetryMetric', ocrLogGroup, 'ocr.job.completed',
      'HID/OCR', 'RetryCount', '$.retryCount');
    structuredLogMetric('OcrFailedRetryMetric', ocrLogGroup, 'ocr.job.failed',
      'HID/OCR', 'RetryCount', '$.retryCount');
    structuredLogMetric('OcrFailedPagesMetric', ocrLogGroup, 'ocr.job.failed',
      'HID/OCR', 'FailedPages', '$.failedPages');
    structuredLogMetric('OcrDuplicateAvoidedMetric', ocrApiLogGroup, 'ocr.job.duplicate_avoided',
      'HID/OCR', 'DuplicateAvoided', '$.duplicateAvoided');

    const dispatcherLogGroup = resources.get('event-dispatcher')!.logGroup;
    structuredLogMetric('DispatcherPendingMetric', dispatcherLogGroup, 'event_dispatcher.backlog',
      'HID/EventDelivery', 'PendingCount', '$.pendingCount');
    structuredLogMetric('DispatcherOldestPendingMetric', dispatcherLogGroup, 'event_dispatcher.backlog',
      'HID/EventDelivery', 'OldestPendingAgeSeconds', '$.oldestPendingAgeSeconds');
    structuredLogMetric('DispatcherDrainRateMetric', dispatcherLogGroup, 'event_dispatcher.backlog',
      'HID/EventDelivery', 'DrainRate', '$.drainRate');

    const notificationAge = new cloudwatch.Alarm(this, 'NotificationQueueAgeAlarm', {
      alarmDescription: 'Ordinary notification queue oldest message age exceeds the drain objective',
      metric: this.notificationQueue.metricApproximateAgeOfOldestMessage({ period: Duration.minutes(1) }),
      threshold: 300,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.tagService(notificationAge, 'notification-worker');
    const notificationVisible = this.notificationQueue.metricApproximateNumberOfMessagesVisible({
      period: Duration.minutes(5), statistic: 'Maximum',
    });
    const notificationDeleted = this.notificationQueue.metricNumberOfMessagesDeleted({
      period: Duration.minutes(5), statistic: 'Sum',
    });
    const notificationBacklog = new cloudwatch.Alarm(this, 'NotificationQueueBacklogAlarm', {
      alarmDescription: 'Ordinary notification visible backlog exceeds the reviewed operating boundary',
      metric: notificationVisible,
      threshold: 100,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    const notificationDrain = new cloudwatch.Alarm(this, 'NotificationQueueDrainAlarm', {
      alarmDescription: 'Ordinary notification backlog exists without message-deletion drain progress',
      metric: new cloudwatch.MathExpression({
        expression: 'IF(visible > 0, deleted, 1)',
        usingMetrics: { visible: notificationVisible, deleted: notificationDeleted },
        period: Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
      evaluationPeriods: 3,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    this.tagService(notificationBacklog, 'notification-worker');
    this.tagService(notificationDrain, 'notification-worker');
    for (const [id, namespace, metricName, threshold, service] of [
      ['OcrQueueAgeAlarm', 'HID/OCR', 'OldestQueueAgeSeconds', 300, 'ocr-worker'],
      ['OcrDrainRateAlarm', 'HID/OCR', 'ClaimThroughput', 1, 'ocr-worker'],
      ['DispatcherOutboxAgeAlarm', 'HID/EventDelivery', 'OldestPendingAgeSeconds', 300, 'event-dispatcher'],
      ['DispatcherDrainRateAlarm', 'HID/EventDelivery', 'DrainRate', 1, 'event-dispatcher'],
    ] as const) {
      const alarm = new cloudwatch.Alarm(this, id, {
        alarmDescription: `${service} PHI-free backlog/drain boundary requires operator review`,
        metric: this.operationalMetric(namespace, metricName),
        threshold,
        comparisonOperator: metricName.includes('Age')
          ? cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD
          : cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 3,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      this.tagService(alarm, service);
    }

    for (const [name, resource] of resources) {
      const alarm = new cloudwatch.Alarm(this, `${pascal(name)}LogVolumeAlarm`, {
        alarmDescription: `${name} log ingestion volume requires scan/retention review; logs must remain PHI-free`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/Logs', metricName: 'IncomingBytes', statistic: 'Sum',
          dimensionsMap: { LogGroupName: resource.logGroup.logGroupName }, period: Duration.minutes(5),
        }),
        threshold: this.configuration.name === 'production' ? 2_000_000_000 : 500_000_000,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      this.tagService(alarm, name);
    }
  }

  private tagService(resource: Construct, service: string): void {
    Tags.of(resource).add('Service', service, { priority: 200 });
  }
}

function pascal(value: string): string {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean).map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join('');
}

function regionalManagedRule(name: string, priority: number,
  managedRuleGroupName: string): wafv2.CfnWebACL.RuleProperty {
  return {
    name, priority, overrideAction: { none: {} },
    statement: { managedRuleGroupStatement: { name: managedRuleGroupName, vendorName: 'AWS' } },
    visibilityConfig: { cloudWatchMetricsEnabled: true, metricName: name, sampledRequestsEnabled: false },
  };
}

export function eventBusArnFor(stack: Stack, busName: string): string {
  return stack.formatArn({ service: 'events', resource: 'event-bus', resourceName: busName, arnFormat: ArnFormat.SLASH_RESOURCE_NAME });
}
