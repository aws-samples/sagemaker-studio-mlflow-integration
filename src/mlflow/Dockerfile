FROM python:3.9.0

RUN pip install \
    mlflow==2.2.1\
    boto3 \
    pymysql==1.0.2

RUN mkdir /mlflow/

EXPOSE 5000

CMD mlflow server \
    --host 0.0.0.0 \
    --port 5000 \
    --default-artifact-root ${BUCKET} \
    --gunicorn-opts "--log-level debug --timeout 180 --workers=2 --threads=4 --worker-class=gthread" \
    --backend-store-uri mysql+pymysql://${USERNAME}:${PASSWORD}@${HOST}:${PORT}/${DATABASE}
