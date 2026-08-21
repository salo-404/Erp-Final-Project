"""Pydantic contracts for real NestJS Control Tower alerts and narration."""

from __future__ import annotations

from datetime import datetime
from enum import Enum
from typing import Any

from pydantic import BaseModel, Field


class AlertCategory(str, Enum):
    DEAD_STOCK = "DEAD_STOCK"
    CONSUMPTION_ANOMALY = "CONSUMPTION_ANOMALY"
    STOCKOUT_RISK = "STOCKOUT_RISK"
    OVERDUE_TRANSACTION = "OVERDUE_TRANSACTION"
    PENDING_DOCUMENT_REVIEW = "PENDING_DOCUMENT_REVIEW"
    RESTOCK_RECOMMENDATION = "RESTOCK_RECOMMENDATION"
    TRANSFER_RECOMMENDATION = "TRANSFER_RECOMMENDATION"


class AlertSeverity(str, Enum):
    CRITICAL = "CRITICAL"
    WARNING = "WARNING"
    INFO = "INFO"


class Alert(BaseModel):
    """One structured alert returned by GET /control-tower/alerts."""

    category: AlertCategory
    severity: AlertSeverity
    message: str
    data: dict[str, Any] = Field(
        ..., description="Backend evidence preserved verbatim; shape varies by category."
    )
    referenceDate: datetime


class NarratedAlert(Alert):
    """The backend alert unchanged, plus model-generated explanatory text."""

    narrative: str
    proposed_action: str
