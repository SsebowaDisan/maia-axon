from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # App
    app_name: str = "Maia Axon"
    debug: bool = False
    log_level: str = "INFO"

    # Database
    database_url: str = "postgresql+asyncpg://maia:maia_secret@localhost:5432/maia_axon"

    # Redis
    redis_url: str = "redis://localhost:6379/0"
    celery_broker_url: str = "redis://localhost:6379/1"

    # Object Storage
    s3_endpoint_url: str = "http://localhost:9000"
    s3_access_key: str = "maia_access"
    s3_secret_key: str = "maia_secret_key"
    s3_bucket_name: str = "maia-axon"

    # LLM Provider (OpenAI — used for chat, vision, embeddings)
    openai_api_key: str = ""

    # GLM-OCR
    glmocr_api_key: str = ""
    glmocr_deployment: str = "cloud"  # "cloud" or "selfhosted"
    glmocr_selfhosted_url: str = "http://localhost:8080"

    # Auth
    jwt_secret_key: str = "change-this-to-a-random-secret"
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 1440

    # Ingestion
    max_upload_size_mb: int = 200
    glmocr_max_workers: int = 32
    embedding_model: str = "text-embedding-3-large"
    embedding_dimensions: int = 3072

    # Retrieval
    retrieval_top_k: int = 10
    rerank_top_k: int = 5

    model_config = {"env_file": ".env", "extra": "ignore"}


settings = Settings()
