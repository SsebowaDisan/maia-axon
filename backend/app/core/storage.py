import io
from uuid import UUID

import boto3
from botocore.config import Config

from app.core.config import settings

_client = None


def get_s3_client():
    global _client
    if _client is None:
        _client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            config=Config(signature_version="s3v4"),
            region_name="us-east-1",
        )
    return _client


def _public_base_url() -> str:
    return settings.s3_public_url or settings.s3_endpoint_url


def upload_file(file_bytes: bytes, key: str, content_type: str = "application/octet-stream") -> str:
    client = get_s3_client()
    client.put_object(
        Bucket=settings.s3_bucket_name,
        Key=key,
        Body=file_bytes,
        ContentType=content_type,
    )
    return f"{_public_base_url()}/{settings.s3_bucket_name}/{key}"


def upload_pdf(document_id: UUID, file_bytes: bytes) -> str:
    key = f"documents/{document_id}/original.pdf"
    return upload_file(file_bytes, key, content_type="application/pdf")


def upload_page_image(document_id: UUID, page_number: int, image_bytes: bytes) -> str:
    key = f"documents/{document_id}/pages/{page_number}.png"
    return upload_file(image_bytes, key, content_type="image/png")


def get_file_url(key: str) -> str:
    return f"{_public_base_url()}/{settings.s3_bucket_name}/{key}"


def to_public_url(url: str) -> str:
    public_base = _public_base_url().rstrip("/")
    internal_base = settings.s3_endpoint_url.rstrip("/")
    if url.startswith(internal_base):
        return f"{public_base}{url[len(internal_base):]}"
    return url


def download_file(key: str) -> bytes:
    client = get_s3_client()
    response = client.get_object(Bucket=settings.s3_bucket_name, Key=key)
    return response["Body"].read()


def delete_document_files(document_id: UUID) -> None:
    client = get_s3_client()
    prefix = f"documents/{document_id}/"
    response = client.list_objects_v2(Bucket=settings.s3_bucket_name, Prefix=prefix)
    if "Contents" in response:
        objects = [{"Key": obj["Key"]} for obj in response["Contents"]]
        client.delete_objects(
            Bucket=settings.s3_bucket_name,
            Delete={"Objects": objects},
        )
