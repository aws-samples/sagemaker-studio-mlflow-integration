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
    constructor(
        scope: Construct,
        id: string,
        httpGatewayStackName: string,
        restApiGateway: apigateway.RestApi,
        domainId: string,
        props?: cdk.StackProps
    ){
        super(scope, id, props);
        
        // SageMaker Execution Role for admins
        const sagemakerAdminExecutionRole = new iam.Role(this, "sagemaker-mlflow-admin-role", {
          assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
          managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSageMakerFullAccess")
          ],
          inlinePolicies: {
            retrieveAmplifyUrl: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  resources: [`arn:*:amplify:${this.region}:${this.account}:apps/*`],
                  actions: ["amplify:ListApps"],
                })
              ],
            }),
            retrieveApiGatewayUrl: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  resources: [`arn:*:cloudformation:${this.region}:${this.account}:stack/${httpGatewayStackName}/*`],
                  actions: ["cloudformation:DescribeStacks"],
                })
              ],
            }),
            restApiAdmin: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  resources: [
                    `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/*/*`
                  ],
                  actions: ["execute-api:Invoke"],
                })
              ],
            }),
            s3Buckets: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  resources: ["arn:aws:s3:::*mlflow*"],
                  actions: ["s3:ListBucket","s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:PutObjectTagging", "s3:CreateBucket"],
                })
              ],
            }),
          },
        });
        
        const sagemakerReadersExecutionRole = new iam.Role(this, "sagemaker-mlflow-reader-role", {
          assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
          managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSageMakerFullAccess")
          ],
          inlinePolicies: {
            retrieveAmplifyUrl: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  resources: [`arn:*:amplify:${this.region}:${this.account}:apps/*`],
                  actions: ["amplify:ListApps"],
                })
              ],
            }),
            retrieveApiGatewayUrl: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  resources: [`arn:*:cloudformation:${this.region}:${this.account}:stack/${httpGatewayStackName}/*`],
                  actions: ["cloudformation:DescribeStacks"],
                })
              ],
            }),
            restApiReader: new iam.PolicyDocument({
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
            }),
            s3Buckets: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  resources: ["arn:aws:s3:::*mlflow*"],
                  actions: ["s3:ListBucket","s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:PutObjectTagging", "s3:CreateBucket"],
                })
              ],
            }),
          },
        });
        
        // SageMaker Execution Role for denying all on MLFlow
        const sagemakerDenyAllExecutionRole = new iam.Role(this, "sagemaker-mlflow-deny-all-role", {
          assumedBy: new iam.ServicePrincipal("sagemaker.amazonaws.com"),
          managedPolicies: [
            iam.ManagedPolicy.fromAwsManagedPolicyName("AmazonSageMakerFullAccess")
          ],
          inlinePolicies: {
            retrieveAmplifyUrl: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  resources: [`arn:*:amplify:${this.region}:${this.account}:apps/*`],
                  actions: ["amplify:ListApps"],
                })
              ],
            }),
            retrieveApiGatewayUrl: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  resources: [`arn:*:cloudformation:${this.region}:${this.account}:stack/${httpGatewayStackName}/*`],
                  actions: ["cloudformation:DescribeStacks"],
                })
              ],
            }),
            restApiDeny: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.DENY,
                  resources: [
                    `arn:aws:execute-api:${this.region}:${this.account}:${restApiGateway.restApiId}/*/*/*`
                  ],
                  actions: ["execute-api:Invoke"],
                })
              ],
            }),
            s3Buckets: new iam.PolicyDocument({
              statements: [
                new iam.PolicyStatement({
                  effect: iam.Effect.ALLOW,
                  resources: ["arn:aws:s3:::*mlflow*"],
                  actions: ["s3:ListBucket","s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:PutObjectTagging", "s3:CreateBucket"],
                })
              ],
            }),
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

          const cfnDenyAllUserProfile = new sagemaker.CfnUserProfile(this, 'MyCfnDenyAllUserProfile', {
            domainId: cfnStudioDomain.attrDomainId,
            userProfileName: 'mlflow-deny-all',
            userSettings: {
              executionRole: sagemakerDenyAllExecutionRole.roleArn,
              }
            }
          );
        }
        else {
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

          const cfnDenyAllUserProfile = new sagemaker.CfnUserProfile(this, 'MyCfnDenyAllUserProfile', {
            domainId: domainId,
            userProfileName: 'mlflow-deny-all',
            userSettings: {
              executionRole: sagemakerDenyAllExecutionRole.roleArn,
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
