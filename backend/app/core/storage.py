from uuid import UUID
from urllib.parse import urlparse

import boto3
from google.cloud import storage as gcs_storage

from app.core.config import settings

_s3_client = None
_gcs_client = None


def _is_google_cloud_storage() -> bool:
    host = urlparse(settings.s3_endpoint_url).netloc.lower()
    return host in {"storage.googleapis.com", "www.googleapis.com"}


def uses_browser_direct_upload() -> bool:
    return _is_google_cloud_storage()


def get_s3_client():
    global _s3_client
    if _s3_client is None:
        _s3_client = boto3.client(
            "s3",
            endpoint_url=settings.s3_endpoint_url,
            aws_access_key_id=settings.s3_access_key,
            aws_secret_access_key=settings.s3_secret_key,
            region_name="us-east-1",
        )
    return _s3_client


def get_gcs_client():
    global _gcs_client
    if _gcs_client is None:
        _gcs_client = gcs_storage.Client()
    return _gcs_client


def _public_base_url() -> str:
    if settings.s3_public_url:
        return settings.s3_public_url
    if _is_google_cloud_storage():
        return "https://storage.googleapis.com"
    return settings.s3_endpoint_url


def upload_file(file_bytes: bytes, key: str, content_type: str = "application/octet-stream") -> str:
    if _is_google_cloud_storage():
        bucket = get_gcs_client().bucket(settings.s3_bucket_name)
        blob = bucket.blob(key)
        blob.upload_from_string(file_bytes, content_type=content_type)
    else:
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


def create_pdf_upload_session(
    document_id: UUID,
    *,
    content_type: str = "application/pdf",
    size_bytes: int | None = None,
    origin: str | None = None,
) -> str:
    if not _is_google_cloud_storage():
        raise RuntimeError("Direct browser upload is only supported for Google Cloud Storage")

    bucket = get_gcs_client().bucket(settings.s3_bucket_name)
    blob = bucket.blob(f"documents/{document_id}/original.pdf")
    return blob.create_resumable_upload_session(
        content_type=content_type,
        size=size_bytes,
        origin=origin,
    )


def upload_page_image(document_id: UUID, page_number: int, image_bytes: bytes) -> str:
    key = f"documents/{document_id}/pages/{page_number}.png"
    return upload_file(image_bytes, key, content_type="image/png")


def get_file_url(key: str) -> str:
    return f"{_public_base_url()}/{settings.s3_bucket_name}/{key}"


def get_file_metadata(key: str) -> dict | None:
    if _is_google_cloud_storage():
        bucket = get_gcs_client().bucket(settings.s3_bucket_name)
        blob = bucket.get_blob(key)
        if blob is None:
            return None
        return {
            "size": blob.size,
            "content_type": blob.content_type,
            "updated": blob.updated,
        }

    client = get_s3_client()
    try:
        response = client.head_object(Bucket=settings.s3_bucket_name, Key=key)
    except client.exceptions.NoSuchKey:
        return None
    except Exception:
        return None

    return {
        "size": response.get("ContentLength"),
        "content_type": response.get("ContentType"),
        "updated": response.get("LastModified"),
    }


def to_public_url(url: str) -> str:
    public_base = _public_base_url().rstrip("/")
    internal_base = settings.s3_endpoint_url.rstrip("/")
    if url.startswith(internal_base):
        return f"{public_base}{url[len(internal_base):]}"
    return url


def download_file(key: str) -> bytes:
    if _is_google_cloud_storage():
        bucket = get_gcs_client().bucket(settings.s3_bucket_name)
        return bucket.blob(key).download_as_bytes()

    client = get_s3_client()
    response = client.get_object(Bucket=settings.s3_bucket_name, Key=key)
    return response["Body"].read()


def delete_document_files(document_id: UUID) -> None:
    prefix = f"documents/{document_id}/"
    if _is_google_cloud_storage():
        bucket = get_gcs_client().bucket(settings.s3_bucket_name)
        for blob in bucket.list_blobs(prefix=prefix):
            blob.delete()
        return

    client = get_s3_client()
    response = client.list_objects_v2(Bucket=settings.s3_bucket_name, Prefix=prefix)
    if "Contents" in response:
        objects = [{"Key": obj["Key"]} for obj in response["Contents"]]
        client.delete_objects(
            Bucket=settings.s3_bucket_name,
            Delete={"Objects": objects},
        )
