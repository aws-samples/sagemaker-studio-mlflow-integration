import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as sagemaker from 'aws-cdk-lib/aws-sagemaker';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';

import * as iam from "aws-cdk-lib/aws-iam";

const sagemakerArnRegionAccountMapping = {
  "eu-west-1": "470317259841",
	"us-east-1": "081325390199",
	"us-east-2": "429704687514",
	"us-west-1": "742091327244",
	"us-west-2": "236514542706",
	"af-south-1": "559312083959",
	"ap-east-1": "493642496378",
	"ap-south-1": "394103062818",
	"ap-northeast-2": "806072073708",
	"ap-southeast-1": "492261229750",
	"ap-southeast-2": "452832661640",
	"ap-northeast-1": "102112518831",
	"ca-central-1": "310906938811",
	"eu-central-1": "936697816551",
	"eu-west-2": "712779665605",
	"eu-west-3": "615547856133",
	"eu-north-1": "243637512696",
	"eu-south-1": "592751261982",
	"sa-east-1": "782484402741",
}

export class SageMakerStudioUserStack extends cdk.Stack {
  public readonly sagemakerStudioDomainId: string;
  
    constructor(
        scope: Construct,
        id: string,
        httpGatewayStackName: string,
        restApiGateway: apigateway.RestApi,
        domainId: string,
        props?: cdk.StackProps
    ){
        super(scope, id, props);

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
              resources: [`arn:aws:ssm:${this.region}:${this.account}:parameter/mlflow-*`],
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
              resources: ["arn:aws:s3:::*mlflow*"],
              actions: ["s3:ListBucket","s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:PutObjectTagging", "s3:CreateBucket"],
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
          const defaultVpc = ec2.Vpc.fromLookup(this, 'DefaultVPC', { isDefault: true });
          const subnetIds: string[] = [];

          defaultVpc.publicSubnets.forEach((subnet, index) => {
            subnetIds.push(subnet.subnetId);
          });

          const cfnStudioDomain = new sagemaker.CfnDomain(this, 'MyStudioDomain', {
            authMode: 'IAM',
            defaultUserSettings: {
              executionRole: sagemakerAdminExecutionRole.roleArn,
              jupyterServerAppSettings: {
                defaultResourceSpec: {
                  instanceType: 'system',
                  sageMakerImageArn: `arn:aws:sagemaker:${this.region}:${sagemakerArnRegionAccountMapping[this.region]}:image/jupyter-server-3`
                },
              },
            },
            domainName: 'StudioDomainName',
            vpcId: defaultVpc.vpcId,
            subnetIds: subnetIds,
          });

          this.sagemakerStudioDomainId = cfnStudioDomain.attrDomainId

          const cfnAdminProfile = new sagemaker.CfnUserProfile(this, 'MyCfnAdminProfile', {
            domainId: cfnStudioDomain.attrDomainId,
            userProfileName: 'mlflow-admin',
            userSettings: {
              executionRole: sagemakerAdminExecutionRole.roleArn,
              }
            }
          );

          const cfnReaderProfile = new sagemaker.CfnUserProfile(this, 'MyCfnReaderProfile', {
            domainId: cfnStudioDomain.attrDomainId,
            userProfileName: 'mlflow-reader',
            userSettings: {
              executionRole: sagemakerReadersExecutionRole.roleArn,
              }
            }
          );

          const cfnModelApproverProfile = new sagemaker.CfnUserProfile(this, 'MyCfnModelApproverProfile', {
            domainId: cfnStudioDomain.attrDomainId,
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
        }
        else {
          this.sagemakerStudioDomainId = domainId

          const cfnAdminProfile = new sagemaker.CfnUserProfile(this, 'MyCfnAdminProfile', {
            domainId: domainId,
            userProfileName: 'mlflow-admin',
            userSettings: {
              executionRole: sagemakerAdminExecutionRole.roleArn,
              jupyterServerAppSettings: {
                defaultResourceSpec: {
                  instanceType: 'system',
                  sageMakerImageArn: `arn:aws:sagemaker:${this.region}:${sagemakerArnRegionAccountMapping[this.region]}:image/jupyter-server-3`
                },
              },
            },
          });

          const cfnReaderProfile = new sagemaker.CfnUserProfile(this, 'MyCfnReaderProfile', {
            domainId: domainId,
            userProfileName: 'mlflow-reader',
            userSettings: {
              executionRole: sagemakerReadersExecutionRole.roleArn,
              jupyterServerAppSettings: {
                defaultResourceSpec: {
                  instanceType: 'system',
                  sageMakerImageArn: `arn:aws:sagemaker:${this.region}:${sagemakerArnRegionAccountMapping[this.region]}:image/jupyter-server-3`
                },
              },
            },
          });

          const cfnModelApproverProfile = new sagemaker.CfnUserProfile(this, 'MyCfnModelApproverProfile', {
            domainId: domainId,
            userProfileName: 'mlflow-model-approver',
            userSettings: {
              executionRole: sagemakerModelAproverExecutionRole.roleArn,
              jupyterServerAppSettings: {
                defaultResourceSpec: {
                  instanceType: 'system',
                  sageMakerImageArn: `arn:aws:sagemaker:${this.region}:${sagemakerArnRegionAccountMapping[this.region]}:image/jupyter-server-3`
                },
              },
            },
          });
        }
    }
}
