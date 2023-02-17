FROM --platform=linux/amd64 amazonlinux:2

RUN yum install -y amazon-linux-extras
RUN amazon-linux-extras install python3.8
RUN ln -s /usr/bin/python3.8 /usr/bin/python3
RUN python3 -m pip install --upgrade pip
RUN python3 -m pip install \
    mlflow==1.30.0\
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
