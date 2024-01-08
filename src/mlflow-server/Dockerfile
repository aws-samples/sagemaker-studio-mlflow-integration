FROM python:3.11.0

ARG PORT=5000

RUN pip install \
    mlflow==2.9.2\
    boto3 \
    psycopg2==2.9.5

WORKDIR /mlflow/

EXPOSE 5000

CMD mlflow server \
    --host 0.0.0.0 \
    --port ${PORT} \
    --default-artifact-root ${BUCKET} \
    --gunicorn-opts "--log-level debug --timeout 180 --workers=2 --threads=4 --worker-class=gthread" \
    --backend-store-uri postgresql+psycopg2://${USERNAME}:${PASSWORD}@${DBHOST}:${DBPORT}/${DATABASE}
