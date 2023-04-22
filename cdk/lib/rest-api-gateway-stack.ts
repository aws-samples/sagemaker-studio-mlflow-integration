import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { PassthroughBehavior } from "aws-cdk-lib/aws-apigateway"
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from "aws-cdk-lib/aws-logs";
import * as lambdapython from '@aws-cdk/aws-lambda-python-alpha';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { IdentityPool, UserPoolAuthenticationProvider } from '@aws-cdk/aws-cognito-identitypool-alpha';

import { NagSuppressions } from 'cdk-nag'

export class RestApiGatewayStack extends cdk.Stack {
  public readonly restApi: apigateway.RestApi;
  public readonly userPool: cognito.UserPool;
  public readonly userPoolClient: cognito.UserPoolClient
  public readonly identityPool: IdentityPool;

  constructor(
    scope: Construct,
    id: string,
    httpApiInternalNLB: elbv2.NetworkLoadBalancer,
    props?: cdk.StackProps
  ) {
    super(scope, id, props);

    const link = new apigateway.VpcLink(this, 'link', {
      targets: [httpApiInternalNLB],
    });

    // User Pool
    this.userPool = new cognito.UserPool(this, 'userpool', {
      userPoolName: 'mlflow-user-pool',
      selfSignUpEnabled: true,
      signInAliases: {
        email: true,
      },
      autoVerify: {
        email: false,
      },
      passwordPolicy: {
        minLength: 8,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cfnUserPool = this.userPool.node.defaultChild as cognito.CfnUserPool;
    cfnUserPool.userPoolAddOns = { advancedSecurityMode: "ENFORCED" };

    this.identityPool = new IdentityPool(this, 'mlflow-identity-pool', {
      identityPoolName: 'mlflow-identity-pool',
      authenticationProviders: {
        userPools: [new UserPoolAuthenticationProvider({ userPool: this.userPool })],
      },
    });

    this.userPoolClient = this.userPool.addClient('mlflow-app-client', {
      supportedIdentityProviders: [
        cognito.UserPoolClientIdentityProvider.COGNITO,
      ],
    });

    const defaultProxyApiIntegration = new apigateway.Integration(
      {
        type: apigateway.IntegrationType.HTTP_PROXY,
        integrationHttpMethod: 'ANY',
        options: {
          connectionType: apigateway.ConnectionType.VPC_LINK,
          vpcLink: link,
          passthroughBehavior: PassthroughBehavior.WHEN_NO_TEMPLATES,
        },
        uri: `http://${httpApiInternalNLB.loadBalancerDnsName}/`
      }
    );

    const logGroup = new logs.LogGroup(this, 'MLflowRestApiAccessLogs', {
      retention: 30, // Keep logs for 30 days
    });

    this.restApi = new apigateway.RestApi(this, 'mlflow-rest-api',
      {
        defaultIntegration: defaultProxyApiIntegration,
        defaultMethodOptions: {
          methodResponses: [{
            statusCode: "200"
          }],
          authorizationType: apigateway.AuthorizationType.IAM
        },
        deployOptions: {
          accessLogDestination: new apigateway.LogGroupLogDestination(logGroup),
          accessLogFormat: apigateway.AccessLogFormat.jsonWithStandardFields(),
          loggingLevel: apigateway.MethodLoggingLevel.INFO,
          dataTraceEnabled: true
        },
        cloudWatchRole: true
      }
    )

    const lambdaFunction = new lambdapython.PythonFunction(this, 'MyFunction', {
      entry: './lambda/authorizer/', // required
      runtime: lambda.Runtime.PYTHON_3_9, // required
      index: 'index.py', // optional, defaults to 'index.py'
      handler: 'handler', // optional, defaults to 'handler',
      reservedConcurrentExecutions: 100, // change as you see it fit
      environment: { 
        REGION: this.region, 
        ACCOUNT: this.account,
        COGNITO_USER_POOL_ID: this.userPool.userPoolId,
        REST_API_ID: this.restApi.restApiId,
        COGNITO_KEYS_URL: `https://cognito-idp.${this.region}.amazonaws.com/${this.userPool.userPoolId}/.well-known/jwks.json`,
        APP_CLIENT_ID: this.userPoolClient.userPoolClientId
      },
    });

    const lambdaAuthorizer = new apigateway.RequestAuthorizer(this, 'lambda-authorizer', {
      handler: lambdaFunction,
      identitySources: [apigateway.IdentitySource.header('Authorization')],
      resultsCacheTtl: cdk.Duration.seconds(0) // Increase as you see it fit
    });

    const proxyApiIntegration = new apigateway.Integration(
      {
        type: apigateway.IntegrationType.HTTP_PROXY,
        integrationHttpMethod: 'ANY',
        options: {
          connectionType: apigateway.ConnectionType.VPC_LINK,
          vpcLink: link,
          requestParameters: {
            'integration.request.path.proxy': 'method.request.path.proxy'
          },
          passthroughBehavior: PassthroughBehavior.WHEN_NO_TEMPLATES
        },
        uri: `http://${httpApiInternalNLB.loadBalancerDnsName}/{proxy}`
      }
    );

    const rootProxy = this.restApi.root.addProxy({
      defaultIntegration: proxyApiIntegration,
      defaultMethodOptions: {
        requestParameters: {
          'method.request.path.proxy': true
        },
        authorizer: lambdaAuthorizer,
        authorizationType: apigateway.AuthorizationType.CUSTOM,
      },
      // "false" will require explicitly adding methods on the `proxy` resource
      anyMethod: true // "true" is the default
    });

    const apiIntegration = new apigateway.Integration(
      {
        type: apigateway.IntegrationType.HTTP_PROXY,
        integrationHttpMethod: 'ANY',
        options: {
          connectionType: apigateway.ConnectionType.VPC_LINK,
          vpcLink: link,
          requestParameters: {
            'integration.request.path.proxy': 'method.request.path.proxy'
          },
          passthroughBehavior: PassthroughBehavior.WHEN_NO_TEMPLATES
      },
      uri: `http://${httpApiInternalNLB.loadBalancerDnsName}/api/{proxy}`
    });

    this.restApi.root.addResource('api').addProxy({
      defaultIntegration: apiIntegration,
      defaultMethodOptions: {
        requestParameters: {
          'method.request.path.proxy': true
        },
        authorizationType: apigateway.AuthorizationType.IAM,
      },
      // "false" will require explicitly adding methods on the `proxy` resource
      anyMethod: true // "true" is the default
    });

    const mlflowRestApiId = new ssm.StringParameter(this, 'mlflowRestApiId', {
      parameterName: 'mlflow-restApiId',
      stringValue: this.restApi.restApiId,
    });

    const mlflowRestApiUrl = new ssm.StringParameter(this, 'mlflowRestApiUrl', {
      parameterName: 'mlflow-restApiUrl',
      stringValue: this.restApi.url,
    });

    NagSuppressions.addResourceSuppressions(this.userPool, [
        {
          id: 'AwsSolutions-COG2',
          reason: 'MFA not necessary for this sample'
        }
      ]
    )

    NagSuppressions.addResourceSuppressions(lambdaFunction, [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Lambda Basic execution role needed to log to CloudWatch',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole']
        }
      ],
      true
    )

    NagSuppressions.addResourceSuppressions(this.restApi, [
        {
          id: 'AwsSolutions-APIG2',
          reason: 'Request validation is done at a deeper level by the MLflow server'
        },
        {
          id: 'AwsSolutions-IAM4',
          reason: 'CloudWatch policy automatically generated',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/service-role/AmazonAPIGatewayPushToCloudWatchLogs']
        },
        {
          id: 'AwsSolutions-COG4',
          reason: 'The Proxy resource uses either a lambda authorizer (that validates the token with the Cognito User Pool or IAM_AUTH'
        },
        {
          id: 'AwsSolutions-APIG4',
          reason: 'Missing auth does not impact here the {proxy} resource and api/(proxy} have both authorization methods attached'
        }
      ],
      true
    )

    new cdk.CfnOutput(this, "Rest API Output : ", {
      value: this.restApi.url,
    });
  }
}
