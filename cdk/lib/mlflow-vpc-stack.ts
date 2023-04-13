import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as servicediscovery from "aws-cdk-lib/aws-servicediscovery";
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { CfnDBCluster, CfnDBSubnetGroup } from 'aws-cdk-lib/aws-rds';

const { Protocol } = elbv2;
const dbName = "mlflowdb"
const dbPort = 5432
const dbUsername = "master"
const clusterName = "mlflowCluster"
const serviceName = "mlflowService"
const cidr = "10.0.0.0/16"
const containerPort = 5000

export class MLflowVpcStack extends cdk.Stack {

  // Export Vpc, ALB Listener, and Mlflow secret ARN
  public readonly httpApiListener: elbv2.NetworkListener;
  public readonly vpc: ec2.Vpc;
  public readonly httpApiInternalNLB: elbv2.NetworkLoadBalancer;

  readonly bucketName = `mlflow-${this.account}-${this.region}`

  constructor(
    scope: Construct, 
    id: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    // VPC
    this.vpc = new ec2.Vpc(this, 'MLFlowVPC', {
      ipAddresses: ec2.IpAddresses.cidr(cidr),
      natGateways: 1,
      maxAzs: 2,
      subnetConfiguration: [
        {
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 26,
        },
        {
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 28,
        },
      ],
    });

    // S3 bucket
    const mlFlowBucket = new s3.Bucket(this, "mlFlowBucket", {
      versioned: false,
      bucketName: this.bucketName,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.KMS_MANAGED
    })

    // DB SubnetGroup
    const subnetIds: string[] = [];
    this.vpc.isolatedSubnets.forEach((subnet, index) => {
      subnetIds.push(subnet.subnetId);
    });

    const dbSubnetGroup: CfnDBSubnetGroup = new CfnDBSubnetGroup(this, 'AuroraSubnetGroup', {
      dbSubnetGroupDescription: 'Subnet group to access aurora',
      dbSubnetGroupName: 'aurora-serverless-subnet-group',
      subnetIds
    });

    // DB Credentials
    const databaseCredentialsSecret = new secretsmanager.Secret(this, 'DBCredentialsSecret', {
      secretName: `mlflow-database-credentials`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({
          username: dbUsername,
        }),
        excludePunctuation: true,
        includeSpace: false,
        generateStringKey: 'password'
      }
    });

    // DB SecurityGroup
    const dbClusterSecurityGroup = new ec2.SecurityGroup(this, 'DBClusterSecurityGroup', { vpc: this.vpc });
    dbClusterSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(dbPort));

    const dbConfig = {
      dbClusterIdentifier: `${serviceName}-cluster`,
      engineMode: 'serverless',
      engine: 'aurora-postgresql',
      engineVersion: '11.16',
      databaseName: dbName,
      deletionProtection: false,
      masterUsername: databaseCredentialsSecret.secretValueFromJson('username').toString(),
      masterUserPassword: databaseCredentialsSecret.secretValueFromJson('password').toString(),
      dbSubnetGroupName: dbSubnetGroup.dbSubnetGroupName,
      scalingConfiguration: {
        autoPause: true,
        maxCapacity: 2,
        minCapacity: 2,
        secondsUntilAutoPause: 3600,
      },
      vpcSecurityGroupIds: [
        dbClusterSecurityGroup.securityGroupId
      ],
      removalPolicy: cdk.RemovalPolicy.DESTROY // Delete everything
    };

    // 👇 RDS Cluster 
    const rdsCluster = new CfnDBCluster(this, 'DBCluster', dbConfig);
    rdsCluster.addDependency(dbSubnetGroup)

    // 👇 ECS Cluster
    const cluster = new ecs.Cluster(this, "Fargate Cluster", {
      vpc: this.vpc,
      clusterName: clusterName,
      containerInsights: true
    });

    // 👇 Cloud Map Namespace
    const dnsNamespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "DnsNamespace",
      {
        name: "http-api.local",
        vpc: this.vpc,
        description: "Private DnsNamespace for Microservices",
      }
    );

    // 👇 Fargate Task Role
    const taskrole = new iam.Role(this, "ecsTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")
      ],
      inlinePolicies: {
        s3Bucket: new iam.PolicyDocument({
          statements:[
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [`arn:aws:s3:::${this.bucketName}`,`arn:aws:s3:::${this.bucketName}/*`],
              actions: ["s3:*"]
            })
          ]
        }),
        secretsManagerRestricted: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                databaseCredentialsSecret.secretArn
              ],
              actions: [
                "secretsmanager:GetResourcePolicy",
                "secretsmanager:GetSecretValue",
                "secretsmanager:DescribeSecret",
                "secretsmanager:ListSecretVersionIds"
              ]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: ["*"],
              actions: ["secretsmanager:ListSecrets"]
            })
          ]
        })
      }
    });

    // 👇 Task Definitions
    const mlflowTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "mlflowTaskDef",
      {
        taskRole: taskrole,
        family: "mlFlowStack",
        cpu: 512,
        memoryLimitMiB: 1024
      },
    );

    // 👇 Log Groups
    const mlflowServiceLogGroup = new logs.LogGroup(this, "mlflowServiceLogGroup", {
      logGroupName: "/ecs/mlflowService",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const mlflowServiceLogDriver = new ecs.AwsLogDriver({
      logGroup: mlflowServiceLogGroup,
      streamPrefix: "mlflowService",
    });
    
    // 👇 MlFlow Task Container
    const mlflowServiceContainer = mlflowTaskDefinition.addContainer(
      "mlflowContainer",
      {
        containerName: "mlflowContainer",
        essential: true,
        memoryReservationMiB: 1024,
        cpu: 512,
        portMappings: [{
          containerPort: containerPort,
          protocol: ecs.Protocol.TCP,
        }],
        image: ecs.ContainerImage.fromAsset('../src/mlflow', {}),
        environment: {
          'BUCKET': `s3://${mlFlowBucket.bucketName}`,
          'HOST': rdsCluster.attrEndpointAddress,
          'PORT': `${dbPort}`,
          'DATABASE': dbName
        },
        secrets: {
          USERNAME: ecs.Secret.fromSecretsManager(databaseCredentialsSecret, 'username'),
          PASSWORD: ecs.Secret.fromSecretsManager(databaseCredentialsSecret, 'password')
        },
        logging: mlflowServiceLogDriver,
      });

    // 👇 Security Group
    const mlflowServiceSecGrp = new ec2.SecurityGroup(
      this,
      "mlflowServiceSecurityGroup",
      {
        allowAllOutbound: true,
        securityGroupName: "mlflowServiceSecurityGroup",
        vpc: this.vpc,
      }
    );
    mlflowServiceSecGrp.connections.allowFromAnyIpv4(ec2.Port.tcp(containerPort));
    mlflowServiceSecGrp.connections.allowFromAnyIpv4(ec2.Port.tcp(80));

    // 👇 Fargate Services
    const mlflowService = new ecs.FargateService(this, "mlflowService", {
      cluster: cluster,
      serviceName: serviceName,
      taskDefinition: mlflowTaskDefinition,
      assignPublicIp: false,
      desiredCount: 2,
      securityGroups: [mlflowServiceSecGrp],
      cloudMapOptions: {
        name: "mlflowService",
        cloudMapNamespace: dnsNamespace,
      },
    });

    // 👇 NLB
    this.httpApiInternalNLB = new elbv2.NetworkLoadBalancer(
      this,
      "httpapiInternalALB",
      {
        vpc: this.vpc,
        internetFacing: false,
      }
    );

    // 👇 ALB Listener
    this.httpApiListener = this.httpApiInternalNLB.addListener("httpapiListener", {
      port: 80,
      protocol: Protocol.TCP,

    });
    
    // 👇 Target Groups
    const mlflowServiceTargetGroup = this.httpApiListener.addTargets(
      "mlflowServiceTargetGroup",
      {
        targets: [
          mlflowService.loadBalancerTarget(
            {
              containerName: 'mlflowContainer',
              containerPort: 5000
            }
          )
        ],
        port: 80,
      }
    );

    // 👇 Task Auto Scaling
    const autoScaling = mlflowService.autoScaleTaskCount({ maxCapacity: 6 });
    autoScaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    new cdk.CfnOutput(this, "ALB Dns Name : ", {
      value: this.httpApiInternalNLB.loadBalancerDnsName,
    });
  }
}
