# Maia Axon Quick Deploy

Use this from Google Cloud Shell.

```bash
cd ~/maia-axon
git pull origin main

export PROJECT_ID=ai-agent-suite-488510
export PROJECT_NUMBER=681709382043
export REGION=europe-west3
export REPO=maia-axon

export API_IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/maia-axon-api:latest
export FRONTEND_IMAGE=$REGION-docker.pkg.dev/$PROJECT_ID/$REPO/maia-axon-frontend:latest
export API_URL=https://maia-axon-api-$PROJECT_NUMBER.$REGION.run.app
export FRONTEND_URL=https://maia-axon-frontend-$PROJECT_NUMBER.$REGION.run.app

gcloud config set project $PROJECT_ID
gcloud config set compute/region $REGION
gcloud auth configure-docker $REGION-docker.pkg.dev
```

Deploy backend:

```bash
docker build -f backend/Dockerfile.prod -t $API_IMAGE backend
docker push $API_IMAGE
gcloud run deploy maia-axon-api --image $API_IMAGE --region $REGION --platform managed --allow-unauthenticated
```

Deploy frontend:

```bash
docker build \
  --build-arg NEXT_PUBLIC_API_URL=$API_URL/api \
  --build-arg NEXT_PUBLIC_WS_URL=wss://maia-axon-api-$PROJECT_NUMBER.$REGION.run.app/ws/chat \
  -t $FRONTEND_IMAGE \
  frontend

docker push $FRONTEND_IMAGE
gcloud run deploy maia-axon-frontend --image $FRONTEND_IMAGE --region $REGION --platform managed --allow-unauthenticated
```

Verify:

```bash
curl $API_URL/health
echo $FRONTEND_URL
```

Current production URLs:

- API: `https://maia-axon-api-681709382043.europe-west3.run.app`
- Frontend: `https://maia-axon-frontend-681709382043.europe-west3.run.app`
