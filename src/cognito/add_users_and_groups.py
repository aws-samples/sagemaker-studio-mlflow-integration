import boto3
import os
import argparse
    
cognito_client = boto3.client('cognito-idp')
user_pools = cognito_client.list_user_pools(MaxResults=60)['UserPools']
user_pool_id = [user_pool['Id'] for user_pool in user_pools if user_pool['Name']=='mlflow-user-pool'][0]
groups = ['admins', 'readers', 'deny-all']
list_groups = cognito_client.list_groups(UserPoolId=user_pool_id)['Groups']
existing_group_names = [group['GroupName'] for group in list_groups]
users_groups = [
    {
        'username': 'mlflow-admin@example.com',
        'group': 'admins'
    },
    {
        'username': 'mlflow-reader@example.com',
        'group': 'readers',
    },
    {
        'username': 'mlflow-deny-all@example.com',
        'group': 'deny-all'
    }
]
list_users = cognito_client.list_users(UserPoolId=user_pool_id)['Users']

existing_email_list = []
for user in list_users:
    attributes = user['Attributes']
    email = [attribute['Value'] for attribute in attributes if attribute['Name']=='email'][0]
    existing_email_list.append(email)

        
if __name__=="__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument('--password', type=str, default='ChangeMe123!')
    args, _ = parser.parse_known_args()
    
    # Create groups
    for group in groups:
        if group in existing_group_names:
            print(f"group {group} already exists")
        else:
            print(f"create group {group} for cognito user pool {user_pool_id}")
            cognito_client.create_group(
                GroupName=group,
                UserPoolId=user_pool_id
            )
    # Create users and associate them with a group
    for user_group in users_groups:
        username = user_group['username']
        group = user_group['group']
        if username in existing_email_list:
            print(f"user {username} already exist. skip it")
        else:
            print(f"create user {username}")
            cognito_client.admin_create_user(
                UserPoolId=user_pool_id,
                Username=username,
                #TemporaryPassword=args.password
            )
            
            cognito_client.admin_set_user_password(
                UserPoolId=user_pool_id,
                Username=username,
                Password=args.password,
                Permanent=True # does not force a user to change the password
            )
            
            print(f"add user {username} to group {group}")
            cognito_client.admin_add_user_to_group(
                UserPoolId=user_pool_id,
                Username=username,
                GroupName=group
            )