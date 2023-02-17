# aws_iframe_jupyter

This is an extension for Jupyter Lab that allows you to load any webpage as an iframe resources in-context of your existing Jupyter workflows. 

### Prerequisites

1. node version > 14.x
1. jupyter lab version 3.x

Replace in `domain.json` your MLFlow domain (if you have followed the deployment guide, it looks like `https://<BRANCH>.<CUSTOM-SUBDOMAIN>.amplifyapp.com`. You can use the following command

```bash
sed -i 's/<REPLACE-ME>/'"https:\/\/<BRANCH>.<CUSTOM-SUBDOMAIN>.amplifyapp.com"'/' src/domain.json
```

### Build and install instructions
1. Initialize conda: `conda init` (you might need to restart the terminal)
1. Activate the conda studio environment: `conda activate studio`
1. Navigate to the `aws-iframe-jupyter-extension` folder
1. Install npm dependencies: `npm install`
1. Build the extension: `npm run build`
1. Install python dependencies: `pip install ./`
1. Install the extension: `jupyter labextension install ./`
1. Build jupyter lab assets: `jupyter lab build`
1. Deactivate the conda studio environment: `conda deactivate`
1. Restart the jupyter server: `restart-jupyter-server` (you might need to refresh the whole page)

```bash
conda activate studio
cd /home/sagemaker-user/sagemaker-studio-mlflow-integration/aws-iframe-jupyter-extension
npm install
npm run build
pip install ./
jupyter labextension install ./
jupyter lab build
conda deactivate
restart-jupyter-server
```
### Publishing new versions
1. Update the version and push via https://docs.npmjs.com/updating-your-published-package-version-number
1. tag the commit with a new version tag

