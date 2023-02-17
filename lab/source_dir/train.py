# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: MIT-0

import os
import logging
import argparse
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestRegressor

import mlflow
import mlflow.sklearn
from mlflow.tracking import MlflowClient

import joblib
import boto3
import json
import time

from smexperiments.tracker import Tracker

logging.basicConfig(level=logging.INFO)

def retrieve_credentials(region_name, secret_name):
    session = boto3.session.Session()
    client = session.client(
        service_name='secretsmanager',
        region_name=region_name
    )
    
    kwarg = {'SecretId': secret_name}
    secret = client.get_secret_value(**kwarg)
    credentials = {}

    credentials['username'] = json.loads(secret['SecretString'])['username']
    credentials['password'] = json.loads(secret['SecretString'])['password']
    
    return credentials

def print_auto_logged_info(r):
    tags = {k: v for k, v in r.data.tags.items()}
    artifacts = [f.path for f in MlflowClient().list_artifacts(r.info.run_id, "model")]
    print("run_id: {}".format(r.info.run_id))
    print("artifacts: {}".format(artifacts))
    print("params: {}".format(r.data.params))
    print("metrics: {}".format(r.data.metrics))
    #print("tags: {}".format(tags))
    
if __name__ =='__main__':
    parser = argparse.ArgumentParser()
    # MLflow related parameters
    parser.add_argument("--tracking_uri", type=str)
    parser.add_argument("--experiment_name", type=str)
    parser.add_argument("--mlflow_amplify_ui", type=str)
    
    parser.add_argument("--region", type=str, default='us-west-2')
    parser.add_argument("--secret_name", type=str)
    # hyperparameters sent by the client are passed as command-line arguments to the script.
    # to simplify the demo we don't use all sklearn RandomForest hyperparameters
    parser.add_argument('--n-estimators', type=int, default=10)
    parser.add_argument('--min-samples-leaf', type=int, default=3)

    # Data, model, and output directories
    parser.add_argument('--model-dir', type=str, default=os.environ.get('SM_MODEL_DIR'))
    parser.add_argument('--train', type=str, default=os.environ.get('SM_CHANNEL_TRAIN'))
    parser.add_argument('--test', type=str, default=os.environ.get('SM_CHANNEL_TEST'))
    parser.add_argument('--train-file', type=str, default='california_train.csv')
    parser.add_argument('--test-file', type=str, default='california_test.csv')
    parser.add_argument('--user', type=str, default='sagemaker')
    parser.add_argument('--features', type=str)  # we ask user to explicitly name features
    parser.add_argument('--target', type=str) # we ask user to explicitly name the target

    args, _ = parser.parse_known_args()

    logging.info('reading data')
    train_df = pd.read_csv(os.path.join(args.train, args.train_file))
    test_df = pd.read_csv(os.path.join(args.test, args.test_file))
    
    logging.info('building training and testing datasets')
    X_train = train_df[args.features.split()]
    X_test = test_df[args.features.split()]
    y_train = train_df[args.target]
    y_test = test_df[args.target]

    
    # sets the header Authentication: Basic <credentials>
    #credentials = retrieve_credentials(args.region, args.secret_name)
    #os.environ['MLFLOW_TRACKING_USERNAME'] = credentials['username']
    #os.environ['MLFLOW_TRACKING_PASSWORD'] = credentials['password']
    os.environ['AWS_DEFAULT_REGION'] = args.region
    os.environ["MLFLOW_TRACKING_AWS_SIGV4"] = "true"

    # set remote mlflow server
    mlflow.set_tracking_uri(args.tracking_uri)
    experiment = mlflow.set_experiment(args.experiment_name)

    mlflow.autolog()

    with mlflow.start_run() as run:
        params = {
            "n-estimators": args.n_estimators,
            "min-samples-leaf": args.min_samples_leaf,
            "features": args.features
        }
        mlflow.log_params(params)

        # TRAIN
        logging.info('training model')
        model = RandomForestRegressor(
            n_estimators=args.n_estimators,
            min_samples_leaf=args.min_samples_leaf,
            n_jobs=-1
        )

        model.fit(X_train, y_train)

        # ABS ERROR AND LOG COUPLE PERF METRICS
        logging.info('evaluating model')
        abs_err = np.abs(model.predict(X_test) - y_test)

        for q in [10, 50, 90]:
            logging.info(f'AE-at-{q}th-percentile: {np.percentile(a=abs_err, q=q)}')
            mlflow.log_metric(f'AE-at-{str(q)}th-percentile', np.percentile(a=abs_err, q=q))

        # SAVE MODEL
        logging.info('saving model in MLflow')
        mlflow.sklearn.log_model(model, "model")
        sm_data = json.loads(os.environ.get('SM_TRAINING_ENV'))
        job_name = sm_data['job_name']
        
        # Overwrite system tags
        mlflow.set_tags(
            {
                'mlflow.source.name': f"https://{args.region}.console.aws.amazon.com/sagemaker/home?region={args.region}#/jobs/{job_name}",
                'mlflow.source.type': 'JOB',
                'mlflow.user': args.user
            }
        )
        # Shovel all SageMaker related data into mlflow
        mlflow.set_tags(sm_data)

    run_id = run.info.run_id
    experiment_id = experiment.experiment_id

    r = mlflow.get_run(run_id=run_id)
    print_auto_logged_info(r)

    artifacts = [f.path for f in MlflowClient().list_artifacts(r.info.run_id, "model")]

    tracker_parameters = {
            "run_id": run_id,
            "experiment_id": experiment_id,
            "mlflow-run-url": f"{args.mlflow_amplify_ui}/#/experiments/{experiment_id}/runs/{run_id}"
        }
    try:
        with Tracker.load() as tracker:
            tracker.log_parameters(tracker_parameters)
            tracker.log_parameters(r.data.params)
            for metric_name, value in r.data.metrics.items():
                tracker.log_metric(metric_name=metric_name, value=value)
            for artifact in artifacts:
                tracker.log_output(name=f"MLFlow.{artifact}", value=f"{r.info.artifact_uri}/{artifact}")
            # Nullify default SageMaker.ModelArtifact
            tracker.log_output(name="SageMaker.ModelArtifact", value="NA")
        print("Loaded existing tracker")
    except:
        print("Could not load tracker (likely running in local mode). Create a new one")
        create_date = time.strftime("%Y-%m-%d-%H-%M-%S")
        tracker_name = f"mlflow-tracker-{create_date}"
        with Tracker.create(display_name=tracker_name) as tracker:
            tracker.log_parameters(tracker_parameters)
            tracker.log_parameters(r.data.params)
            print("Metric cannot be logged when creating a tracker in this way")
            for artifact in artifacts:
                tracker.log_output(name=f"MLFlow.{artifact}", value=f"{r.info.artifact_uri}/{artifact}")
            tracker.log_output(name="SageMaker.ModelArtifact", value="NA")