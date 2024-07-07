FROM python:3.11.0

ARG PORT=5001

RUN pip install \
    mlflow[genai]==2.12.2\
    boto3

WORKDIR /mlflow/

COPY config.yaml ./

EXPOSE ${PORT}

CMD mlflow deployments start-server \
    --host 0.0.0.0 \
    --port ${PORT} \
    --config-path config.yaml \
    --workers ${WORKERS}