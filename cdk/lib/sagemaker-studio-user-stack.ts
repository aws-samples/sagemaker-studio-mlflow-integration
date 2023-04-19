import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from "aws-cdk-lib/aws-iam";
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';

import { NagSuppressions } from 'cdk-nag'

export class SageMakerStudioUserStack extends cdk.Stack {
  public readonly sagemakerStudioDomainId: string;
  
  readonly mlflowDeployBucketName = `mlflow-sagemaker-${this.region}-${this.account}`

    constructor(
        scope: Construct,
        id: string,
        httpGatewayStackName: string,
        restApiGateway: apigateway.RestApi,
        domainId: string,
        accessLogs: s3.Bucket,
        props?: cdk.StackProps
    ){
        super(scope, id, props);

        // mlflow deployment S3 bucket
        const mlFlowDeployBucket = new s3.Bucket(this, "mlFlowDeployBucket", {
          versioned: false,
          bucketName: this.mlflowDeployBucketName,
          publicReadAccess: false,
          blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
          removalPolicy: cdk.RemovalPolicy.DESTROY,
          autoDeleteObjects: true,
          encryption: s3.BucketEncryption.KMS_MANAGED,
          enforceSSL: true,
          serverAccessLogsBucket: accessLogs,
          serverAccessLogsPrefix: 'mlflow-deploy'
        })
        
        const mlflowDeployBucketParam = new ssm.StringParameter(this, 'mlflowRestApiId', {
          parameterName: 'mlflow-deploy-bucket',
          stringValue: this.mlflowDeployBucketName,
        });

        // Policy to access the parameters from the Notebook for lab setup
        const ssmPolicy = new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: ['*'],
              actions: ["ssm:DescribeParameters"]
            }),
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                `arn:aws:ssm:${this.region}:${this.account}:parameter/mlflow-restApiId`,
                `arn:aws:ssm:${this.region}:${this.account}:parameter/mlflow-restApiUrl`,
                `arn:aws:ssm:${this.region}:${this.account}:parameter/mlflow-deploy-bucket`,
                `arn:aws:ssm:${this.region}:${this.account}:parameter/mlflow-uiUrl`
              ],
              actions: [
                "ssm:GetParameters",
                "ssm:GetParameter",
              ]
            })
          ]
        })

        // Policy to have admin access to MLflow
        const restApiAdminPolicy = new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/*/*`
              ],
              actions: ["execute-api:Invoke"],
            })
          ],
        })

        const s3bucketPolicy = new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                `arn:aws:s3:::${this.mlflowDeployBucketName}`,
                `arn:aws:s3:::mlflow-${this.account}-${this.region}`,
                `arn:aws:s3:::${this.mlflowDeployBucketName}/*`,
                `arn:aws:s3:::mlflow-${this.account}-${this.region}/*`
              ],
              actions: ["s3:ListBucket","s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:PutObjectTagging"],
            })
          ],
        })

        // Policy to have read-only access to MLflow
        const restApiReaderPolicy =  new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/GET/*`,
                `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/POST/api/2.0/mlflow/runs/search`,
                `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/POST/api/2.0/mlflow/experiments/search`
              ],
              actions: ["execute-api:Invoke"],
            })
          ],
        })

        // Model approver
        const restApiModelApprover =  new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              effect: iam.Effect.ALLOW,
              resources: [
                `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/GET/*`,
                `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/POST/api/2.0/mlflow/runs/search`,
                `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/POST/api/2.0/mlflow/experiments/search`,
                `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/POST/api/2.0/mlflow/model-versions/*`,
                `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/POST/api/2.0/mlflow/registered-models/*`,
              ],
              actions: ["execute-api:Invoke"],
            })
          ],
        })

        // SageMaker Execution Role for admins
        const sagemakerAdminExecutionRole = new iam.Role(this, "sagemaker-mlflow-admin-role", {
          assumedBy: new iam.CompositePrincipal(
            new iam.ServicePrincipal("sagemaker.amazonaws.com")
          ),
          managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSageMakerFullAccess")
          ],
          inlinePolicies: {
            restApiAdmin: restApiAdminPolicy,
            s3Buckets: s3bucketPolicy,
            ssmPolicy: ssmPolicy
          },
        });

        // SageMaker Execution Role for readers
        const sagemakerReadersExecutionRole = new iam.Role(this, "sagemaker-mlflow-reader-role", {
          assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
          managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSageMakerFullAccess")
          ],
          inlinePolicies: {
            restApiReader: restApiReaderPolicy,
            s3Buckets: s3bucketPolicy,
            ssmPolicy: ssmPolicy
          },
        });

        // SageMaker Execution Role for readers
        const sagemakerModelAproverExecutionRole = new iam.Role(this, "sagemaker-mlflow-model-aprover-role", {
          assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
          managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSageMakerFullAccess")
          ],
          inlinePolicies: {
            restApiReader: restApiModelApprover,
            s3Buckets: s3bucketPolicy,
            ssmPolicy: ssmPolicy
          },
        });

        if (domainId == "") {
          // Create a domain
          const defaultVpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true });
          const subnetIds: string[] = [];

          defaultVpc.publicSubnets.forEach((subnet, index) => {
            subnetIds.push(subnet.subnetId);
          });

          const cfnStudioDomain = new sagemaker.CfnDomain(this, 'MyStudioDomain', {
            authMode: 'IAM',
            defaultUserSettings: {
              executionRole: sagemakerAdminExecutionRole.roleArn
            },
            domainName: 'StudioDomainName',
            vpcId: defaultVpc.vpcId,
            subnetIds: subnetIds,
          });

          this.sagemakerStudioDomainId = cfnStudioDomain.attrDomainId
        }
        else {
          this.sagemakerStudioDomainId = domainId
        }

        const cfnAdminProfile = new sagemaker.CfnUserProfile(this, 'MyCfnAdminProfile', {
          domainId: this.sagemakerStudioDomainId,
          userProfileName: 'mlflow-admin',
          userSettings: {
            executionRole: sagemakerAdminExecutionRole.roleArn,
            }
          }
        );

        const cfnReaderProfile = new sagemaker.CfnUserProfile(this, 'MyCfnReaderProfile', {
          domainId: this.sagemakerStudioDomainId,
          userProfileName: 'mlflow-reader',
          userSettings: {
            executionRole: sagemakerReadersExecutionRole.roleArn,
            }
          }
        );

        const cfnModelApproverProfile = new sagemaker.CfnUserProfile(this, 'MyCfnModelApproverProfile', {
          domainId: this.sagemakerStudioDomainId,
          userProfileName: 'mlflow-model-approver',
          userSettings: {
            executionRole: sagemakerModelAproverExecutionRole.roleArn,
            }
          }
        );

        const cfnAdminJupyterApp = new sagemaker.CfnApp(this, 'MyCfnAdminJupyterApp', {
          appName: 'default',
          appType: 'JupyterServer',
          domainId: this.sagemakerStudioDomainId,
          userProfileName: cfnAdminProfile.userProfileName
        })
        cfnAdminJupyterApp.addDependency(cfnAdminProfile)

        const cfnReaderJupyterApp = new sagemaker.CfnApp(this, 'MyCfnReaderJupyterApp', {
          appName: 'default',
          appType: 'JupyterServer',
          domainId: this.sagemakerStudioDomainId,
          userProfileName: cfnReaderProfile.userProfileName
        })
        cfnReaderJupyterApp.addDependency(cfnReaderProfile)

        const cfnModelApproverJupyterApp = new sagemaker.CfnApp(this, 'MyCfnModelApproverJupyterApp', {
          appName: 'default',
          appType: 'JupyterServer',
          domainId: this.sagemakerStudioDomainId,
          userProfileName: cfnModelApproverProfile.userProfileName
        })

        cfnModelApproverJupyterApp.addDependency(cfnModelApproverProfile)

        const nagIamSuprressionSMExecutionRole = [
          {
              id: 'AwsSolutions-IAM4',
              reason: "Domain users require full access and the managed policy is likely better than '*'"
            },
            {
              id: 'AwsSolutions-IAM5',
              reason: 'Necessary to grant SSM ListParameters',
              appliesTo: [
                'Resource::*',
              ],
            },
            {
              id: 'AwsSolutions-IAM5',
              reason: 'Group exceptions for API Gateway invoke permissions necessary to demonstrate model approver permission on MLflow',
            },
          ]

        NagSuppressions.addResourceSuppressions(sagemakerAdminExecutionRole, nagIamSuprressionSMExecutionRole, true)

        NagSuppressions.addResourceSuppressions(sagemakerReadersExecutionRole, nagIamSuprressionSMExecutionRole, true)

        NagSuppressions.addResourceSuppressions(sagemakerModelAproverExecutionRole, nagIamSuprressionSMExecutionRole, true)
    }
}
