import os
from typing import Iterator

import boto3
from botocore.config import Config


def _client(endpoint_url: str, access_key: str, secret_key: str, region_name: str = "us-east-1"):
    return boto3.client(
        "s3",
        endpoint_url=endpoint_url,
        aws_access_key_id=access_key,
        aws_secret_access_key=secret_key,
        config=Config(signature_version="s3v4"),
        region_name=region_name,
    )


def _iter_keys(client, bucket: str, prefix: str) -> Iterator[str]:
    token = None
    while True:
        kwargs = {"Bucket": bucket, "Prefix": prefix}
        if token:
            kwargs["ContinuationToken"] = token
        response = client.list_objects_v2(**kwargs)
        for item in response.get("Contents", []):
            key = item.get("Key")
            if key:
                yield key
        if not response.get("IsTruncated"):
            break
        token = response.get("NextContinuationToken")


def main() -> None:
    source_endpoint = os.environ["SOURCE_S3_ENDPOINT_URL"]
    source_access_key = os.environ["SOURCE_S3_ACCESS_KEY"]
    source_secret_key = os.environ["SOURCE_S3_SECRET_KEY"]
    source_bucket = os.environ["SOURCE_S3_BUCKET"]

    target_endpoint = os.environ["TARGET_S3_ENDPOINT_URL"]
    target_access_key = os.environ["TARGET_S3_ACCESS_KEY"]
    target_secret_key = os.environ["TARGET_S3_SECRET_KEY"]
    target_bucket = os.environ["TARGET_S3_BUCKET"]

    prefix = os.environ.get("OBJECT_PREFIX", "documents/")

    source = _client(source_endpoint, source_access_key, source_secret_key)
    target = _client(target_endpoint, target_access_key, target_secret_key)

    copied = 0
    for key in _iter_keys(source, source_bucket, prefix):
        body = source.get_object(Bucket=source_bucket, Key=key)["Body"].read()
        target.put_object(Bucket=target_bucket, Key=key, Body=body)
        copied += 1
        print(f"copied {key}")

    print(f"done: copied {copied} objects from {source_bucket} to {target_bucket}")


if __name__ == "__main__":
    main()
