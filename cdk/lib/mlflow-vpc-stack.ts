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

import { NagSuppressions } from 'cdk-nag'
import {Platform} from "aws-cdk-lib/aws-ecr-assets";

const { Protocol } = elbv2;
const dbName = "mlflowdb"
const dbPort = 5432
const dbUsername = "master"
const clusterName = "mlflowCluster"
const mlflowServerServiceName = "mlflowServerService"
const mlflowGatewayServiceName = "mlflowGatewayService"
const cidr = "10.0.0.0/16"
const mlflowContainerPort = 5000
const gatewayContainerPort = 5001
const listenerMlflowPort= 8080
const listenerMlflowGatewayPort = 8081
const gatewayPrivateHostname = "mlflow-gateway"
const serverPrivateHostname = "mlflow-server"
const privateHostname = 'api.local'

export class MLflowVpcStack extends cdk.Stack {

  // Export Vpc, ALB Listener, and Mlflow secret ARN
  public readonly httpMlflowServerListener: elbv2.NetworkListener;
  public readonly httpMlflowGatewayListener: elbv2.NetworkListener;
  public readonly vpc: ec2.Vpc;
  public readonly httpApiInternalNLB: elbv2.NetworkLoadBalancer;
  public readonly accessLogs: s3.Bucket;

  readonly bucketName = `mlflow-${this.account}-${this.region}`
  readonly accesslogBucketName = `accesslogs-${this.account}-${this.region}`

  constructor(
    scope: Construct,
    id: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    const logGroup = new logs.LogGroup(this, 'MyVpcLogGroup');

    const flowLogsRole = new iam.Role(this, 'flowLogsRole', {
      assumedBy: new iam.ServicePrincipal('vpc-flow-logs.amazonaws.com')
    });

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
          mapPublicIpOnLaunch: false
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

    new ec2.FlowLog(this, 'FlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(this.vpc),
      destination: ec2.FlowLogDestination.toCloudWatchLogs(logGroup, flowLogsRole)
    });

    this.accessLogs = new s3.Bucket(this, "accessLogs", {
      versioned: false,
      bucketName: this.accesslogBucketName,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      enforceSSL: true,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED
    })

    // mlflow S3 bucket
    const mlFlowBucket = new s3.Bucket(this, "mlFlowBucket", {
      versioned: false,
      bucketName: this.bucketName,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      encryption: s3.BucketEncryption.KMS_MANAGED,
      enforceSSL: true,
      serverAccessLogsBucket: this.accessLogs,
      serverAccessLogsPrefix: 'mlflow-server'
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
    const dbClusterSecurityGroup = new ec2.SecurityGroup(this, 'DBClusterSecurityGroup',
      {
        vpc: this.vpc,
        allowAllOutbound: false
      }
    );

    dbClusterSecurityGroup.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(dbPort));

    const dbConfig = {
      dbClusterIdentifier: `${mlflowServerServiceName}-cluster`,
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
      storageEncrypted: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY // Delete everything
    };

    // 👇 RDS Cluster
    const rdsCluster = new CfnDBCluster(this, 'DBCluster', dbConfig);
    rdsCluster.addDependency(dbSubnetGroup)

    // 👇 ECS Cluster
    const cluster = new ecs.Cluster(this, "MLflowCluster", {
      vpc: this.vpc,
      clusterName: clusterName,
      containerInsights: true
    });

    // Network Load Balancer
    this.httpApiInternalNLB = new elbv2.NetworkLoadBalancer(
      this,
      "httpapiInternalALB",
      {
        vpc: this.vpc,
        internetFacing: false,
      }
    );

    // Security Group
    const mlflowSecGrp = new ec2.SecurityGroup(
      this,
      "mlflowServiceSecurityGroup",
      {
        vpc: this.vpc,
      }
    );

    mlflowSecGrp.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(mlflowContainerPort), 'Allow internal access to the mlflow server port');
    mlflowSecGrp.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(gatewayContainerPort), 'Allow internal access to the mlflow gateway port');
    mlflowSecGrp.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(listenerMlflowPort), 'Allow internal access to the container port');
    mlflowSecGrp.addIngressRule(ec2.Peer.ipv4(cidr), ec2.Port.tcp(listenerMlflowGatewayPort), 'Allow internal access to the container port');


    // 👇 Cloud Map Namespace
    const dnsNamespace = new servicediscovery.PrivateDnsNamespace(
      this,
      "DnsNamespace",
      {
        name: privateHostname,
        vpc: this.vpc,
        description: "Private DnsNamespace for Microservices",
      }
    );

    const withoutPolicyUpdatesOptions: iam.WithoutPolicyUpdatesOptions = {
      addGrantsToResources: false,
    };

    // 👇 Fargate Task Role
    const mlflowServertaskrole = new iam.Role(this, "ecsTaskExecutionRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")
      ],
      inlinePolicies: {
        s3Bucket: new iam.PolicyDocument({
          statements:[
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                `arn:aws:s3:::${this.bucketName}`,
                `arn:aws:s3:::${this.bucketName}/*`
              ],
              actions: [
                "s3:ListBucket",
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:PutObjectTagging",
                "s3:DeleteObjectTagging",
                "s3:GetBucketTagging",
                "s3:GetObjectTagging"
              ]
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
          ]
        })
      }
    });

    const mlflowGatewaytaskrole = new iam.Role(this, "mlflowGatewaytaskrole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName("service-role/AmazonECSTaskExecutionRolePolicy")
      ],
      inlinePolicies: {
        secretsManagerRestricted: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                "*" //TODO: Add ARNs of API keys
              ],
              actions: [
                "secretsmanager:GetResourcePolicy",
                "secretsmanager:GetSecretValue",
                "secretsmanager:DescribeSecret",
                "secretsmanager:ListSecretVersionIds"
              ]
            }),
          ]
        }),
        bedrock: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                "*"
              ],
              actions: [
                  "bedrock:InvokeModel",
                  "bedrock:InvokeModelWithResponseStream"
              ]
            }),
          ]
        })
      }
    });

    // MLflow server Task Definitions
    const mlflowServerTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "mlflowServerTaskDef",
      {
        taskRole: mlflowServertaskrole.withoutPolicyUpdates(withoutPolicyUpdatesOptions),
        executionRole: mlflowServertaskrole.withoutPolicyUpdates(withoutPolicyUpdatesOptions),
        family: "MlflowServerStack",
        cpu: 512,
        memoryLimitMiB: 1024
      },
    );

    // MLflow server Task Definitions
    const mlflowGatewayTaskDefinition = new ecs.FargateTaskDefinition(
      this,
      "mlflowGatewayTaskDef",
      {
        taskRole: mlflowGatewaytaskrole.withoutPolicyUpdates(withoutPolicyUpdatesOptions),
        executionRole: mlflowGatewaytaskrole.withoutPolicyUpdates(withoutPolicyUpdatesOptions),
        family: "MlflowGatewayStack",
        cpu: 512,
        memoryLimitMiB: 1024
      },
    );

    // 👇 Log Groups
    const mlflowServerServiceLogGroup = new logs.LogGroup(this, "mlflowServiceLogGroup", {
      logGroupName: "/ecs/mlflowServerService",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // 👇 Log Groups
    const mlflowGatewayServiceLogGroup = new logs.LogGroup(this, "mlflowGatewayLogGroup", {
      logGroupName: "/ecs/mlflowGatewayService",
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const mlflowServerServiceLogDriver = new ecs.AwsLogDriver({
      logGroup: mlflowServerServiceLogGroup,
      streamPrefix: "mlflowServerService",
    });

    const mlflowGatewayServiceLogDriver = new ecs.AwsLogDriver({
      logGroup: mlflowGatewayServiceLogGroup,
      streamPrefix: "mlflowGatewayService",
    });

    // MlFlow Task Container
    const mlflowServerServiceContainer = mlflowServerTaskDefinition.addContainer(
      "mlflowServerContainer",
      {
        containerName: "mlflowServerContainer",
        essential: true,
        memoryReservationMiB: 1024,
        cpu: 512,
        portMappings: [{
          containerPort: mlflowContainerPort,
          protocol: ecs.Protocol.TCP,
        }],
        image: ecs.ContainerImage.fromAsset('../src/mlflow-server', {
          platform: Platform.LINUX_AMD64,
          buildArgs: {
            PORT: `${mlflowContainerPort}`
          }
        }),
        environment: {
          'PORT': `${mlflowContainerPort}`,
          'BUCKET': `s3://${mlFlowBucket.bucketName}`,
          'DBHOST': rdsCluster.attrEndpointAddress,
          'DBPORT': `${dbPort}`,
          'DATABASE': dbName,
          'MLFLOW_GATEWAY_URI': `http://${gatewayPrivateHostname}.${privateHostname}:${gatewayContainerPort}`
        },
        secrets: {
          USERNAME: ecs.Secret.fromSecretsManager(databaseCredentialsSecret, 'username'),
          PASSWORD: ecs.Secret.fromSecretsManager(databaseCredentialsSecret, 'password')
        },
        logging: mlflowServerServiceLogDriver,
      });

        // MlFlow Task Container
    const mlflowGatewayServiceContainer = mlflowGatewayTaskDefinition.addContainer(
      "mlflowGatewayContainer",
      {
        containerName: "mlflowGatewayContainer",
        essential: true,
        memoryReservationMiB: 1024,
        cpu: 512,
        portMappings: [{
          containerPort: gatewayContainerPort,
          protocol: ecs.Protocol.TCP,
        }],
        image: ecs.ContainerImage.fromAsset('../src/mlflow-gateway', {
          platform: Platform.LINUX_AMD64,
          buildArgs: {
            PORT: `${gatewayContainerPort}`
          }
        }),
        environment: {
          'PORT': `${gatewayContainerPort}`,
          'WORKERS': '5',
          'AWS_BEDROCK_REGION': `${process.env['AWS_BEDROCK_REGION'] || this.region}`
        },
        secrets: {
        },
        logging: mlflowGatewayServiceLogDriver,
      });

    // MLflow server Services
    const mlflowServerService = new ecs.FargateService(this, "mlflowServerService", {
      cluster: cluster,
      serviceName: mlflowServerServiceName,
      taskDefinition: mlflowServerTaskDefinition,
      assignPublicIp: false,
      desiredCount: 2,
      securityGroups: [mlflowSecGrp],
      cloudMapOptions: {
        name: serverPrivateHostname,
        cloudMapNamespace: dnsNamespace,
      },
    });

    // MLflow gateway Services
    const mlflowGatewayService = new ecs.FargateService(this, "mlflowGatewayService", {
      cluster: cluster,
      serviceName: mlflowGatewayServiceName,
      taskDefinition: mlflowGatewayTaskDefinition,
      assignPublicIp: false,
      desiredCount: 2,
      securityGroups: [mlflowSecGrp],
      cloudMapOptions: {
        name: gatewayPrivateHostname,
        cloudMapNamespace: dnsNamespace,
      },
    });

    // NLB MLflow server Listener
    this.httpMlflowServerListener = this.httpApiInternalNLB.addListener("httpMlflowServerListener", {
      port: listenerMlflowPort,
      protocol: Protocol.TCP
    });

    // NLB MLflow Gateway Listener
    this.httpMlflowGatewayListener = this.httpApiInternalNLB.addListener("httpMlflowGatewayListener", {
      port: listenerMlflowGatewayPort,
      protocol: Protocol.TCP
    });

    // MLflow server Target Groups
    const mlflowServiceTargetGroup = this.httpMlflowServerListener.addTargets(
      "mlflowServiceTargetGroup",
      {
        targets: [
          mlflowServerService.loadBalancerTarget(
            {
              containerName: 'mlflowServerContainer',
              containerPort: mlflowContainerPort
            }
          )
        ],
        port: listenerMlflowPort,
      }
    );

    // MLflow gateway Target Groups
    const mlflowGatewayTargetGroup = this.httpMlflowGatewayListener.addTargets(
      "mlflowGatewayTargetGroup",
      {
        targets: [
          mlflowGatewayService.loadBalancerTarget(
            {
              containerName: 'mlflowGatewayContainer',
              containerPort: gatewayContainerPort
            }
          )
        ],
        port: listenerMlflowGatewayPort,
      }
    );
    // MLflow server Task Auto Scaling
    const mlflowServerAutoScaling = mlflowServerService.autoScaleTaskCount({ maxCapacity: 6 });
    mlflowServerAutoScaling.scaleOnCpuUtilization('MlflowServerCpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    // MLflow gateway Task Auto Scaling
    const mlflowGatewayAutoScaling = mlflowGatewayService.autoScaleTaskCount({ maxCapacity: 6 });
    mlflowGatewayAutoScaling.scaleOnCpuUtilization('MlflowGatewayCpuScaling', {
      targetUtilizationPercent: 70,
      scaleInCooldown: cdk.Duration.seconds(60),
      scaleOutCooldown: cdk.Duration.seconds(60),
    });

    NagSuppressions.addResourceSuppressions(mlflowServerTaskDefinition, [
      {
        id: 'AwsSolutions-ECS2',
        reason: 'ENV variables passed do not contain secrets'
      },
    ])

    NagSuppressions.addResourceSuppressions(mlflowGatewayTaskDefinition, [
      {
        id: 'AwsSolutions-ECS2',
        reason: 'ENV variables passed do not contain secrets'
      },
    ])

    NagSuppressions.addResourceSuppressions(mlflowServertaskrole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The task owns this bucket and it should have full permissions on the objects',
        appliesTo: [`Resource::arn:aws:s3:::${this.bucketName}/*`]
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'The task needs access to this managed policy',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy']
      }
    ]
    )

        NagSuppressions.addResourceSuppressions(mlflowGatewaytaskrole, [
      {
        id: 'AwsSolutions-IAM5',
        reason: 'The task owns this bucket and it should have full permissions on the objects',
        appliesTo: [`Resource::*`]
      },
      {
        id: 'AwsSolutions-IAM4',
        reason: 'The task needs access to this managed policy',
        appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy']
      }
    ]
    )

    NagSuppressions.addResourceSuppressions(databaseCredentialsSecret, [
      {
        id: 'AwsSolutions-SMG4',
        reason: 'MLflow does not support database credentials rotation'
      }
    ])

    NagSuppressions.addResourceSuppressions(this.accessLogs, [
      {
        id: 'AwsSolutions-S1',
        reason: 'This is a already an access log bucket'
      }
    ])

    NagSuppressions.addResourceSuppressions(rdsCluster, [
      {
        id: 'AwsSolutions-RDS11',
        reason: 'We want to avoid creating confusion by obfuscating the standard Postgres port'
      },
      {
        id: 'AwsSolutions-RDS10',
        reason: 'This is a sample and we encourage users to clean up after trying the solution'
      },
      {
        id: 'AwsSolutions-RDS6',
        reason: 'MLflow does not support IAM authentication for the DB layer'
      }
    ])

    NagSuppressions.addResourceSuppressions(this.httpApiInternalNLB, [
      {
        id: 'AwsSolutions-ELB2',
        reason: 'This is an internal-only NLB listening on port 80. Access logs for NLB only works for a TLS listener as per documentation in https://docs.aws.amazon.com/elasticloadbalancing/latest/network/load-balancer-access-logs.html'
      }]
    )

    new cdk.CfnOutput(this, "ALB Dns Name : ", {
      value: this.httpApiInternalNLB.loadBalancerDnsName,
    });
  }
}
