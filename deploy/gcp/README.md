# Maia Axon on Google Cloud

This setup targets the managed deployment you chose:

- `frontend` on Cloud Run
- `backend API` on Cloud Run
- `Cloud SQL for PostgreSQL`
- `Memorystore for Redis`
- `Cloud Storage` for PDFs and rendered page images
- `one small Celery worker` on a small Compute Engine VM

## 1. Create the managed services

Create:

- a GCP project
- an Artifact Registry Docker repository
- a Cloud SQL PostgreSQL instance
- a Memorystore Redis instance
- a Cloud Storage bucket
- a Secret Manager secret set for app credentials

Enable:

- Cloud Run
- Cloud Build
- Artifact Registry
- Cloud SQL Admin API
- Memorystore API
- Secret Manager API
- Cloud Storage

## 2. Configure storage

The backend already uses `boto3` S3-style storage in [backend/app/core/storage.py](../../backend/app/core/storage.py).

Use Google Cloud Storage interoperability:

- create a service account for storage access
- create HMAC credentials for that service account
- set:
  - `S3_ENDPOINT_URL=https://storage.googleapis.com`
  - `S3_PUBLIC_URL=https://storage.googleapis.com`
  - `S3_ACCESS_KEY=<GCS HMAC access key>`
  - `S3_SECRET_KEY=<GCS HMAC secret>`
  - `S3_BUCKET_NAME=<your bucket>`

## 3. Backend API on Cloud Run

Build and push the backend image:

```powershell
gcloud builds submit `
  --tag REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/maia-axon-api:latest `
  backend
```

Deploy:

```powershell
gcloud run deploy maia-axon-api `
  --image REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/maia-axon-api:latest `
  --region REGION `
  --platform managed `
  --allow-unauthenticated `
  --port 8000 `
  --add-cloudsql-instances PROJECT_ID:REGION:INSTANCE_NAME `
  --vpc-connector YOUR_SERVERLESS_VPC_CONNECTOR `
  --set-env-vars-file deploy/gcp/api.env
```

Use [deploy/gcp/api.env.example](./api.env.example) as the base for `deploy/gcp/api.env`.

Notes:

- [backend/Dockerfile.prod](../../backend/Dockerfile.prod) runs Alembic on startup and then starts Uvicorn without `--reload`.
- Cloud Run needs a Serverless VPC Access connector so the API can reach Memorystore.

## 4. Frontend on Cloud Run

Build and push the frontend image:

```powershell
gcloud builds submit `
  --tag REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/maia-axon-frontend:latest `
  --build-arg NEXT_PUBLIC_API_URL=https://API_SERVICE_URL/api `
  --build-arg NEXT_PUBLIC_WS_URL=wss://API_SERVICE_URL/ws/chat `
  frontend
```

Deploy:

```powershell
gcloud run deploy maia-axon-frontend `
  --image REGION-docker.pkg.dev/PROJECT_ID/REPOSITORY/maia-axon-frontend:latest `
  --region REGION `
  --platform managed `
  --allow-unauthenticated `
  --port 3000
```

Use [deploy/gcp/frontend.env.example](./frontend.env.example) for the values you feed into the frontend build.

## 5. Celery worker on a small Compute Engine VM

Create a small VM, for example `e2-small` or `e2-medium`, install Docker and Docker Compose, then run the worker image there.

Copy:

- [deploy/gcp/worker-compose.yaml](./worker-compose.yaml)
- a real `worker.env` based on [deploy/gcp/worker.env.example](./worker.env.example)

Run:

```powershell
docker compose -f worker-compose.yaml up -d
```

The worker uses the same backend image and connects to:

- Cloud SQL
- Memorystore
- Cloud Storage
- OpenAI
- GLM OCR

## 6. Database

The backend startup script runs:

```sh
alembic upgrade head
```

If you prefer explicit migration control, run migrations once manually and remove that startup step.

## 7. Networking

Recommended:

- keep frontend public
- keep API public but protected by app auth
- use Serverless VPC Access for Cloud Run to reach Redis privately
- keep Cloud SQL on private access if possible
- use firewall rules to limit the worker VM

## 8. Cost shape for your expected use

For about 5 testers, this setup is typically in the `~$100–$220/month` range before OpenAI and OCR usage, with the main fixed costs coming from:

- Cloud SQL
- Memorystore
- the worker VM

## 9. Important production notes

- The current backend image in [backend/Dockerfile](../../backend/Dockerfile) is still development-oriented because it uses `--reload`.
- Use [backend/Dockerfile.prod](../../backend/Dockerfile.prod) for GCP.
- Uploaded PDFs and rendered pages are data, not code. They persist only if Cloud Storage and the database are configured correctly.

## 10. Migrate the PDFs already on this PC

Your existing uploaded documents are split across:

- object storage objects in local MinIO
- document, page, chunk, and embedding metadata in PostgreSQL

To bring the already-uploaded PDFs to GCP, migrate both.

### 10.1 Copy object storage

Use [deploy/gcp/sync_object_storage.py](./sync_object_storage.py) to copy the existing `documents/` objects from local MinIO into the target Cloud Storage bucket via the S3-compatible endpoint.

Example:

```powershell
$env:SOURCE_S3_ENDPOINT_URL="http://localhost:9000"
$env:SOURCE_S3_ACCESS_KEY="maia_access"
$env:SOURCE_S3_SECRET_KEY="maia_secret_key"
$env:SOURCE_S3_BUCKET="maia-axon"

$env:TARGET_S3_ENDPOINT_URL="https://storage.googleapis.com"
$env:TARGET_S3_ACCESS_KEY="GCS_HMAC_ACCESS_KEY"
$env:TARGET_S3_SECRET_KEY="GCS_HMAC_SECRET"
$env:TARGET_S3_BUCKET="YOUR_BUCKET_NAME"

$env:OBJECT_PREFIX="documents/"
python deploy/gcp/sync_object_storage.py
```

This copies:

- original PDFs
- rendered page images

### 10.2 Copy database metadata

Export the local database and import it into Cloud SQL.

Dump local Postgres:

```powershell
docker compose -f backend/docker-compose.yml exec -T postgres pg_dump -U maia -d maia_axon > maia_axon.sql
```

Restore into Cloud SQL:

```powershell
psql "host=CLOUD_SQL_IP user=DB_USER dbname=DB_NAME password=DB_PASSWORD" -f maia_axon.sql
```

If you use the Cloud SQL Auth Proxy, point `psql` at the proxy endpoint instead.

### 10.3 Why both are required

If you copy only the files:

- the PDFs exist in storage
- but the app will not know they belong to projects or pages

If you copy only the database:

- the app will know about the documents
- but the actual PDF and page image files will be missing

You need both for the current PDFs on this PC to appear correctly after deployment.
