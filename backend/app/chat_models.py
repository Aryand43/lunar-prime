"""Typed contracts for the mission analyst API."""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, ConfigDict, Field

MAX_MESSAGE_CHARS = 4000


class ChatMessageIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    content: str = Field(..., min_length=1, max_length=MAX_MESSAGE_CHARS)
    run_id: Optional[str] = Field(None, pattern=r"^run_[0-9a-f]{16}$",
                                  description="The run this question is about; bound to the turn permanently")


class SessionCreated(BaseModel):
    session_id: str
    token: str = Field(..., description="Send as X-Session-Token on every request for this session")


class ChatStatus(BaseModel):
    enabled: bool
    reason: Optional[str]
    provider: Optional[str]
    model: Optional[str]
    retrieval: dict
    limits: dict
