import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

import * as elbv2 from "aws-cdk-lib/aws-elasticloadbalancingv2";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import { PassthroughBehavior } from "aws-cdk-lib/aws-apigateway"
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdapython from '@aws-cdk/aws-lambda-python-alpha';
import { IdentityPool, UserPoolAuthenticationProvider } from '@aws-cdk/aws-cognito-identitypool-alpha';

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
        minLength: 6,
        requireLowercase: true,
        requireDigits: true,
        requireUppercase: true,
        requireSymbols: true,
      },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    
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

    this.restApi = new apigateway.RestApi(this, 'mlflow-rest-api',
      {
        defaultIntegration: defaultProxyApiIntegration,
        defaultMethodOptions: {
          methodResponses: [{
            statusCode: "200"
          }],
        }
      })
    
    const lambdaFunction = new lambdapython.PythonFunction(this, 'MyFunction', {
      entry: './lambda/authorizer/', // required
      runtime: lambda.Runtime.PYTHON_3_9, // required
      index: 'index.py', // optional, defaults to 'index.py'
      handler: 'handler', // optional, defaults to 'handler'
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
      resultsCacheTtl: cdk.Duration.seconds(0)
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

    new cdk.CfnOutput(this, "Rest API Output : ", {
      value: this.restApi.url,
    });
  }
}
