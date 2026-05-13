from pydantic import field_validator
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
    s3_public_url: str | None = None
    s3_access_key: str = "maia_access"
    s3_secret_key: str = "maia_secret_key"
    s3_bucket_name: str = "maia-axon"

    # LLM Provider (OpenAI — used for chat, vision, embeddings,
    # section enrichment, path generation, and rubric grading).
    openai_api_key: str = ""
    # Model used for the deeper-reasoning offline passes (section
    # enrichment, path generation, free-text rubric grading). gpt-4o
    # is the cost/quality sweet spot; gpt-4o-mini is too weak for
    # the structured-output discipline these passes need.
    openai_reasoning_model: str = "gpt-4o"

    # Google integrations
    google_service_account_email: str = ""
    google_service_account_key_path: str = ""
    google_ads_developer_token: str = ""
    google_ads_login_customer_id: str = ""
    evidence_browser_user_data_dir: str = ""
    evidence_browser_channel: str = "chrome"

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
    embedding_dimensions: int = 1536

    # Retrieval
    retrieval_top_k: int = 80
    vector_ivfflat_probes: int = 30
    rerank_top_k: int = 12
    llm_rerank_candidate_k: int = 24
    neighbor_window_pages: int = 1
    neighbor_chunks_per_hit: int = 2
    answer_context_top_k: int = 24
    # Quality gate: if fewer than ``retrieval_min_quality_results`` chunks
    # score above ``retrieval_relevance_floor`` after reranking, the system
    # makes one LLM-driven query reformulation attempt and re-retrieves.
    # Floors below ~0.4 admit too much noise; above ~0.6 over-trust the
    # rerank scores and starve legitimate but lower-scored chunks.
    retrieval_relevance_floor: float = 0.45
    retrieval_min_quality_results: int = 3

    model_config = {"env_file": ".env", "extra": "ignore"}

    @field_validator("debug", mode="before")
    @classmethod
    def parse_debug_flag(cls, value: object) -> object:
        if isinstance(value, str) and value.strip().lower() in {"release", "prod", "production"}:
            return False
        return value


settings = Settings()
