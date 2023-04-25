# Copyright 2017-2019 Amazon.com, Inc. or its affiliates. All Rights Reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file
# except in compliance with the License. A copy of the License is located at
#
#     http://aws.amazon.com/apache2.0/
#
# or in the "license" file accompanying this file. This file is distributed on an "AS IS"
# BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the
# License for the specific language governing permissions and limitations under the License.
from __future__ import print_function

import json
import time
import os
import urllib.request
from jose import jwk, jwt
from jose.utils import base64url_decode
import re
import logging

logging.basicConfig(level=logging.INFO) # change me to DEBUG and redeploy if needed

REGION = os.environ['REGION']
APP_CLIENT_ID = os.environ['APP_CLIENT_ID']
KEYS_URL = os.environ['COGNITO_KEYS_URL']
BEARER_PREFIX = 'Bearer '
AJAX_API_PREFIX = '/ajax-api/2.0/mlflow'
# instead of re-downloading the public keys every time
# we download them only on cold start
# https://aws.amazon.com/blogs/compute/container-reuse-in-lambda/
with urllib.request.urlopen(KEYS_URL) as f:
  response = f.read()
keys = json.loads(response.decode('utf-8'))['keys']

def verify_token(token):
    # get the kid from the headers prior to verification
    headers = jwt.get_unverified_headers(token)
    kid = headers['kid']
    # search for the kid in the downloaded public keys
    key_index = -1
    for i in range(len(keys)):
        if kid == keys[i]['kid']:
            key_index = i
            break
    if key_index == -1:
        logging.info('Public key not found in jwks.json')
        return False
    # construct the public key
    public_key = jwk.construct(keys[key_index])
    # get the last two sections of the token,
    # message and signature (encoded in base64)
    message, encoded_signature = str(token).rsplit('.', 1)
    # decode the signature
    decoded_signature = base64url_decode(encoded_signature.encode('utf-8'))
    # verify the signature
    if not public_key.verify(message.encode("utf8"), decoded_signature):
        logging.info('Signature verification failed')
        return False

    # since we passed the verification, we can now safely
    # use the unverified claims
    claims = jwt.get_unverified_claims(token)
    # additionally we can verify the token expiration
    if time.time() > claims['exp']:
        logging.info('Token is expired')
        return False
    # and the Audience  (use claims['client_id'] if verifying an access token)
    if claims['aud'] != APP_CLIENT_ID:
        logging.info('Token was not issued for this audience')
        return False
    # now we can use the claims: DO NOT PRINT FOR PRODUCTION
    # print(claims)
    return True

def handler(event, context):
    # the event contains sensitive information. Should not be logged
    # print(event)
    request_type = event['type']
    
    if request_type == 'TOKEN':
        token = event['authorizationToken']
    elif request_type == 'REQUEST':
        token = event['headers']['Authorization']
    else:
        raise Exception('Unsuported request type')

    if token.startswith(BEARER_PREFIX):
        token = token[len(BEARER_PREFIX):]

    if not verify_token(token):
        raise Exception('Unauthorized')
    
    claims = jwt.get_unverified_claims(token)
    principalId=claims['cognito:username']

    tmp = event['methodArn'].split(':')
    apiGatewayArnTmp = tmp[5].split('/')
    awsAccountId = tmp[4]

    policy = AuthPolicy(principalId, awsAccountId)
    policy.restApiId = apiGatewayArnTmp[0]
    policy.region = tmp[3]
    policy.stage = apiGatewayArnTmp[1]
    
    groups = claims['cognito:groups']
    logging.debug(f"cognito group extracted: {groups}")
    # Add your custom logic here
    # For example, you could depict a strategy based on experiment. However,
    # to verify if an individual run, or a model-version, or an artifact belongs to a run,
    # you must query the MLFlow api again to cross check, and only then authorize or not the
    # request.
    if 'admins' in groups:
        policy.allowAllMethods()
    elif 'readers' in groups:
        policy.allowMethod(HttpVerb.POST, f"{AJAX_API_PREFIX}/runs/search")
        policy.allowMethod(HttpVerb.POST, f"{AJAX_API_PREFIX}/experiments/search")
        policy.allowMethod(HttpVerb.GET, f"{AJAX_API_PREFIX}/*")
        policy.allowMethod(HttpVerb.GET, f"/get-artifact")
        policy.allowMethod(HttpVerb.GET, f"/model-versions/*")
    elif 'model-approvers' in groups:
        # user cannot do anything
        policy.allowMethod(HttpVerb.POST, f"{AJAX_API_PREFIX}/runs/search")
        policy.allowMethod(HttpVerb.POST, f"{AJAX_API_PREFIX}/experiments/search")
        policy.allowMethod(HttpVerb.POST, f"{AJAX_API_PREFIX}/registered-models/*")
        policy.allowMethod(HttpVerb.ALL, f"{AJAX_API_PREFIX}/model-versions/*")
        policy.allowMethod(HttpVerb.GET, f"{AJAX_API_PREFIX}/*")
        policy.allowMethod(HttpVerb.GET, f"/get-artifact")
        policy.allowMethod(HttpVerb.GET, f"/model-versions/*")
    else:
        logging.info('Unknown user group')
        return False

    # Finally, build the policy
    authResponse = policy.build()
 
    # new! -- add additional key-value pairs associated with the authenticated principal
    # these are made available by APIGW like so: $context.authorizer.<key>
    # additional context is cached
    # context = {
    #     'key': 'value', # $context.authorizer.key -> value
    #     'number' : 1,
    #     'bool' : True
    # }
    # context['arr'] = ['foo'] <- this is invalid, APIGW will not accept it
    # context['obj'] = {'foo':'bar'} <- also invalid
    #authResponse['context'] = context

    # Check policy generated for this request
    logging.debug(f"policy built for this request: {authResponse}")
    return authResponse

class HttpVerb:
    GET     = "GET"
    POST    = "POST"
    PUT     = "PUT"
    PATCH   = "PATCH"
    HEAD    = "HEAD"
    DELETE  = "DELETE"
    OPTIONS = "OPTIONS"
    ALL     = "*"

class AuthPolicy(object):
    awsAccountId = ""
    """The AWS account id the policy will be generated for. This is used to create the method ARNs."""
    principalId = ""
    """The principal used for the policy, this should be a unique identifier for the end user."""
    version = "2012-10-17"
    """The policy version used for the evaluation. This should always be '2012-10-17'"""
    pathRegex = "^[/.a-zA-Z0-9-\*]+$"
    """The regular expression used to validate resource paths for the policy"""

    """these are the internal lists of allowed and denied methods. These are lists
    of objects and each object has 2 properties: A resource ARN and a nullable
    conditions statement.
    the build method processes these lists and generates the approriate
    statements for the final policy"""
    allowMethods = []
    denyMethods = []

    
    restApiId = "<<restApiId>>"
    """ Replace the placeholder value with a default API Gateway API id to be used in the policy. 
    Beware of using '*' since it will not simply mean any API Gateway API id, because stars will greedily expand over '/' or other separators. 
    See https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_resource.html for more details. """    

    region = "<<region>>"
    """ Replace the placeholder value with a default region to be used in the policy. 
    Beware of using '*' since it will not simply mean any region, because stars will greedily expand over '/' or other separators. 
    See https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_resource.html for more details. """    

    stage = "<<stage>>"
    """ Replace the placeholder value with a default stage to be used in the policy. 
    Beware of using '*' since it will not simply mean any stage, because stars will greedily expand over '/' or other separators. 
    See https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements_resource.html for more details. """

    def __init__(self, principal, awsAccountId):
        self.awsAccountId = awsAccountId
        self.principalId = principal
        self.allowMethods = []
        self.denyMethods = []

    def _addMethod(self, effect, verb, resource, conditions):
        """Adds a method to the internal lists of allowed or denied methods. Each object in
        the internal list contains a resource ARN and a condition statement. The condition
        statement can be null."""
        if verb != "*" and not hasattr(HttpVerb, verb):
            raise NameError("Invalid HTTP verb " + verb + ". Allowed verbs in HttpVerb class")
        resourcePattern = re.compile(self.pathRegex)
        if not resourcePattern.match(resource):
            raise NameError("Invalid resource path: " + resource + ". Path should match " + self.pathRegex)

        if resource[:1] == "/":
            resource = resource[1:]

        resourceArn = ("arn:aws:execute-api:" +
            self.region + ":" +
            self.awsAccountId + ":" +
            self.restApiId + "/" +
            self.stage + "/" +
            verb + "/" +
            resource)

        if effect.lower() == "allow":
            self.allowMethods.append({
                'resourceArn' : resourceArn,
                'conditions' : conditions
            })
        elif effect.lower() == "deny":
            self.denyMethods.append({
                'resourceArn' : resourceArn,
                'conditions' : conditions
            })

    def _getEmptyStatement(self, effect):
        """Returns an empty statement object prepopulated with the correct action and the
        desired effect."""
        statement = {
            'Action': 'execute-api:Invoke',
            'Effect': effect[:1].upper() + effect[1:].lower(),
            'Resource': []
        }

        return statement

    def _getStatementForEffect(self, effect, methods):
        """This function loops over an array of objects containing a resourceArn and
        conditions statement and generates the array of statements for the policy."""
        statements = []

        if len(methods) > 0:
            statement = self._getEmptyStatement(effect)

            for curMethod in methods:
                if curMethod['conditions'] is None or len(curMethod['conditions']) == 0:
                    statement['Resource'].append(curMethod['resourceArn'])
                else:
                    conditionalStatement = self._getEmptyStatement(effect)
                    conditionalStatement['Resource'].append(curMethod['resourceArn'])
                    conditionalStatement['Condition'] = curMethod['conditions']
                    statements.append(conditionalStatement)

            statements.append(statement)

        return statements

    def allowAllMethods(self):
        """Adds a '*' allow to the policy to authorize access to all methods of an API"""
        self._addMethod("Allow", HttpVerb.ALL, "*", [])

    def denyAllMethods(self):
        """Adds a '*' allow to the policy to deny access to all methods of an API"""
        self._addMethod("Deny", HttpVerb.ALL, "*", [])

    def allowMethod(self, verb, resource):
        """Adds an API Gateway method (Http verb + Resource path) to the list of allowed
        methods for the policy"""
        self._addMethod("Allow", verb, resource, [])

    def denyMethod(self, verb, resource):
        """Adds an API Gateway method (Http verb + Resource path) to the list of denied
        methods for the policy"""
        self._addMethod("Deny", verb, resource, [])

    def allowMethodWithConditions(self, verb, resource, conditions):
        """Adds an API Gateway method (Http verb + Resource path) to the list of allowed
        methods and includes a condition for the policy statement. More on AWS policy
        conditions here: http://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements.html#Condition"""
        self._addMethod("Allow", verb, resource, conditions)

    def denyMethodWithConditions(self, verb, resource, conditions):
        """Adds an API Gateway method (Http verb + Resource path) to the list of denied
        methods and includes a condition for the policy statement. More on AWS policy
        conditions here: http://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_elements.html#Condition"""
        self._addMethod("Deny", verb, resource, conditions)

    def build(self):
        """Generates the policy document based on the internal lists of allowed and denied
        conditions. This will generate a policy with two main statements for the effect:
        one statement for Allow and one statement for Deny.
        Methods that includes conditions will have their own statement in the policy."""
        if ((self.allowMethods is None or len(self.allowMethods) == 0) and
            (self.denyMethods is None or len(self.denyMethods) == 0)):
            raise NameError("No statements defined for the policy")

        policy = {
            'principalId' : self.principalId,
            'policyDocument' : {
                'Version' : self.version,
                'Statement' : []
            }
        }

        policy['policyDocument']['Statement'].extend(self._getStatementForEffect("Allow", self.allowMethods))
        policy['policyDocument']['Statement'].extend(self._getStatementForEffect("Deny", self.denyMethods))

        return policy
        
# the following is useful to make this script executable in both
# AWS Lambda and any other local environments
if __name__ == '__main__':
    # for testing locally you can enter the JWT ID Token here
    event = {
        'type': 'TOKEN',
        'authorizationToken': 'Bearer <YOUR-TOKEN-GOES-HERE>',
        'methodArn': 'arn:aws:execute-api:<REGION>:<ACCOUNTI-ID>:<API-ID>/prod/GET/ajax-api/2.0/preview/mlflow/experiments/list'
    }
    handler(event, None)
