import setuptools


setuptools.setup(
    name='aws_iframe_jupyter_extension',
    version='1.0.0',
    packages=setuptools.find_packages(),
    install_requires=[
        'aws-jupyter-proxy',
        'notebook',
        'botocore >= 1.19.17',
        'boto3 >= 1.16.17'
    ],
    include_package_data=True,
    data_files=[
        (
            "etc/jupyter/jupyter_notebook_config.d",
            ["aws_iframe_jupyter_extension/etc/aws_iframe_jupyter_extension.json"],
        )
    ],
)
