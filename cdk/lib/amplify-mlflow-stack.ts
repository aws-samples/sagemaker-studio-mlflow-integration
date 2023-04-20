import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as apigateway from "aws-cdk-lib/aws-apigateway"; 
import * as amplify from "@aws-cdk/aws-amplify-alpha";
import * as codebuild from "aws-cdk-lib/aws-codebuild";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as codecommit from "aws-cdk-lib/aws-codecommit";
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as cr from 'aws-cdk-lib/custom-resources';

import { IdentityPool } from '@aws-cdk/aws-cognito-identitypool-alpha';
import { NagSuppressions } from 'cdk-nag'

export class AmplifyMlflowStack extends cdk.Stack {
  constructor(
    scope: Construct,
    id: string,
    restApiGateway: apigateway.RestApi,
    cognitoUserPool: cognito.UserPool,
    cognitoIdentityPool: IdentityPool,
    cognitoUserPoolClient: cognito.UserPoolClient,
    sagemakerStudioDomainId: string,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    const repo = new codecommit.Repository(this, 'Repository', {
        repositoryName: 'mlflow-2.2.1-patched',
        description: 'MLflow v2.2.1 with cognito patch', // optional property
        code: codecommit.Code.fromDirectory('../mlflow/mlflow/server/js', 'main')
    });

    const AccessControlAllowOriginHeader: amplify.CustomResponseHeader = {
        headers: {
            'Access-Control-Allow-Origin': `https://${sagemakerStudioDomainId}.studio.${this.region}.sagemaker.aws`,
        },
        pattern: '*',
    };

    const amplifyApp = new amplify.App(this, 'Mlflow-UI', {
        sourceCodeProvider: new amplify.CodeCommitSourceCodeProvider({ repository: repo }),
        buildSpec: codebuild.BuildSpec.fromObjectToYaml({
            // Alternatively add a `amplify.yml` to the repo
            version: '1.0',
            applications: [{
                frontend: {
                    phases: {
                        preBuild: {
                            commands: ['yarn install'],
                        },
                        build: {
                            commands: [
                                'echo "REACT_APP_REGION=$REACT_APP_REGION" >> .env',
                                'echo "REACT_APP_COGNITO_USER_POOL_ID=$REACT_APP_COGNITO_USER_POOL_ID" >> .env',
                                'echo "REACT_APP_COGNITO_IDENTITY_POOL_ID=$REACT_APP_COGNITO_IDENTITY_POOL_ID" >> .env',
                                'echo "REACT_APP_COGNITO_USER_POOL_CLIENT_ID=$REACT_APP_COGNITO_USER_POOL_CLIENT_ID" >> .env',
                                'yarn run build'
                            ],
                        },
                    },
                    artifacts: {
                        baseDirectory: 'build',
                        files: ['**/*'],
                    },
                    cache: {
                        path: "node_modules/**/*"
                    },
                },
            }]
        }),
        environmentVariables: {
            '_LIVE_UPDATES': `[{"pkg":"@aws-amplify/cli","type":"npm","version":"9.2.1"}]`,
            '_BUILD_TIMEOUT': '60',
            'REACT_APP_REGION': this.region,
            'REACT_APP_COGNITO_USER_POOL_ID': cognitoUserPool.userPoolId,
            'REACT_APP_COGNITO_IDENTITY_POOL_ID': cognitoIdentityPool.identityPoolId,
            'AMPLIFY_USERPOOL_ID': cognitoUserPool.userPoolId,
            'AMPLIFY_IDENTITYPOOL_ID': cognitoIdentityPool.identityPoolId, 
            'REACT_APP_COGNITO_USER_POOL_CLIENT_ID': cognitoUserPoolClient.userPoolClientId
        },
        customResponseHeaders: [AccessControlAllowOriginHeader]
    })
    
    amplifyApp.addBranch('main')

    // Rule for static files
    amplifyApp.addCustomRule({
        source: '/static-files/<*>',
        target: '/<*>',
        status: amplify.RedirectStatus.REWRITE
    });
    
    // Rule for ajax-api
    amplifyApp.addCustomRule({
        source: '/ajax-api/<*>',
        target: `${restApiGateway.url}ajax-api/<*>`,
        status: amplify.RedirectStatus.REWRITE
    })
    
    // Rule for get-artifact
    amplifyApp.addCustomRule({
        source: '/get-artifact',
        target: `${restApiGateway.url}get-artifact`,
        status: amplify.RedirectStatus.REWRITE
    })
    
    // Rule for /model-version/get-artifact
    amplifyApp.addCustomRule({
        source: '/model-versions/get-artifact',
        target: `${restApiGateway.url}model-versions/get-artifact`,
        status: amplify.RedirectStatus.REWRITE
    })
    
    const buildTrigger = new cr.AwsCustomResource(this, 'triggerAppBuild', {
        policy: cr.AwsCustomResourcePolicy.fromSdkCalls({
            resources: [`arn:aws:amplify:${this.region}:${this.account}:apps/${amplifyApp.appId}/branches/main/jobs/*`]
        }),
        onCreate: {
            service: 'Amplify',
            action: 'startJob',
            physicalResourceId: cr.PhysicalResourceId.of('app-build-trigger'),
            apiVersion: '9.2.1',
            parameters: {
                appId: amplifyApp.appId,
                branchName: 'main',
                jobType: 'RELEASE',
                jobReason: 'Auto Start build',
            }
        },
    });

    const mlflowUiUrl = new ssm.StringParameter(this, 'mlflowUiUrl', {
      parameterName: 'mlflow-uiUrl',
      stringValue: `https://main.${amplifyApp.defaultDomain}`
    });

    NagSuppressions.addResourceSuppressions(buildTrigger, [
        {
            id: 'AwsSolutions-IAM5',
            reason: 'Permissions needed by the lambda function to trigger the first build job',
            appliesTo: [`Resource::arn:aws:amplify:${this.region}:${this.account}:apps/${amplifyApp.appId}/branches/main/jobs/*`]
        }
    ], true)
}
}
