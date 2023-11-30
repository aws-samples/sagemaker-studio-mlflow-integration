FROM python:3.11.0

ARG PORT=5001

RUN pip install \
    mlflow[gateway]==2.8.0\
    boto3

WORKDIR /mlflow/

COPY config.yaml ./

EXPOSE ${PORT}

CMD mlflow gateway start \
    --host 0.0.0.0 \
    --port ${PORT} \
    --config-path config.yaml \
    --workers ${WORKERS}