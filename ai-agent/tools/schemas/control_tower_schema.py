"""Pydantic models for the Control Tower narration layer.

Per the locked architecture doc, Control Tower is explicitly NOT a fourth
agent and NOT a live chat entry point - see narration/control_tower.py for
the full explanation. These are plain data models (no tool schemas here -
this module has no @tool functions, since narration isn't Strands
Agent/tool machinery).

Alert is the exact input shape returned by the frozen backend's
GET /control-tower/alerts endpoint. NarratedAlert is that authoritative
alert plus the two fields narrate_alert() generates.
"""

from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel, ConfigDict, Field


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
    model_config = ConfigDict(extra="forbid")

    category: AlertCategory
    severity: AlertSeverity
    message: str = Field(..., min_length=1)
    data: dict = Field(
        ..., description="Backend-calculated structured evidence; shape varies by category."
    )
    referenceDate: datetime


class NarratedAlert(Alert):
    """Everything from Alert, unchanged, plus the generated narration.

    category/severity/message/data/referenceDate are passed through exactly
    as returned by the backend. The model never regenerates them.
    """

    narrative: str = Field(
        ..., description="Plain-language explanation of the alert - no jargon, no field names."
    )
    proposed_action: str = Field(
        ...,
        description=(
            "One concrete recommended next step. Always phrased as a proposal for a human to "
            "review and approve - never as an action already taken."
        ),
    )
