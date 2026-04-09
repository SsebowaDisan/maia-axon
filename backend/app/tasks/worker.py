from celery import Celery

from app.core.config import settings

celery_app = Celery(
    "maia_axon",
    broker=settings.celery_broker_url,
    backend=settings.redis_url,
)

celery_app.conf.update(
    task_serializer="json",
    accept_content=["json"],
    result_serializer="json",
    timezone="UTC",
    enable_utc=True,
    task_track_started=True,
    task_acks_late=True,
    worker_prefetch_multiplier=1,
)

# Register task modules explicitly so the worker can consume queued ingestion jobs.
celery_app.conf.imports = ("app.tasks.ingestion",)
celery_app.autodiscover_tasks(["app.tasks"])
