from fastapi import APIRouter

from app.api.endpoints import (
    admin_learn,
    annotations,
    auth,
    chat,
    companies,
    conversations,
    documents,
    export_destinations,
    feedback,
    groups,
    learn,
    projects,
    translate,
    users,
    ws,
)

api_router = APIRouter()

# Auth & Users
api_router.include_router(auth.router)
api_router.include_router(users.router)

# Groups
api_router.include_router(groups.router)

# Projects
api_router.include_router(projects.router)

# Companies
api_router.include_router(companies.router)

# Export destinations
api_router.include_router(export_destinations.router)

# Documents (mounted under /groups/{id}/documents and /documents/{id})
api_router.include_router(documents.router)

# Conversations
api_router.include_router(conversations.router)

# Chat (REST)
api_router.include_router(chat.router)

# Feedback
api_router.include_router(feedback.router)

# Annotations (highlights + comments)
api_router.include_router(annotations.router)

# Translate (ephemeral PDF passage translation)
api_router.include_router(translate.router)

# Learn mode (path generation, check-ins, mindmap data)
api_router.include_router(learn.router)

# Admin: learn-mode QA / review tools
api_router.include_router(admin_learn.router)

# WebSocket (mounted at root level, not under /api)
ws_router = ws.router
