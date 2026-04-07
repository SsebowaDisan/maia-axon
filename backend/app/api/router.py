from fastapi import APIRouter

from app.api.endpoints import auth, chat, conversations, documents, groups, users, ws

api_router = APIRouter()

# Auth & Users
api_router.include_router(auth.router)
api_router.include_router(users.router)

# Groups
api_router.include_router(groups.router)

# Documents (mounted under /groups/{id}/documents and /documents/{id})
api_router.include_router(documents.router)

# Conversations
api_router.include_router(conversations.router)

# Chat (REST)
api_router.include_router(chat.router)

# WebSocket (mounted at root level, not under /api)
ws_router = ws.router
