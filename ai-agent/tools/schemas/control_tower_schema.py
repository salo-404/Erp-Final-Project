"""Pydantic models for the Control Tower narration layer.

Per the locked architecture doc, Control Tower is explicitly NOT a fourth
agent and NOT a live chat entry point - see narration/control_tower.py for
the full explanation. These are plain data models (no tool schemas here -
this module has no @tool functions, since narration isn't Strands
Agent/tool machinery).

Alert is the input shape - what the backend's future getControlTowerAlerts()
will return (mocked today in tools/mocks/control_tower_mock_data.py).
NarratedAlert is the output shape - an Alert plus the two fields
narrate_alert() generates.
"""

from __future__ import annotations

from enum import Enum
from typing import Optional

from pydantic import BaseModel, Field


class AlertCategory(str, Enum):
    LOW_STOCK = "low_stock"
    STOCKOUT_RISK = "stockout_risk"
    OVERDUE_TRANSACTION = "overdue_transaction"
    CONSUMPTION_ANOMALY = "consumption_anomaly"
    EXPIRING_INVENTORY = "expiring_inventory"
    INVOICE_DISCREPANCY = "invoice_discrepancy"
    ORDER_DISCREPANCY = "order_discrepancy"


class AlertSeverity(str, Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


class Alert(BaseModel):
    id: str
    category: AlertCategory
    severity: AlertSeverity
    evidence: dict = Field(
        ..., description="Raw structured data backing the alert. Shape varies by category."
    )
    product_id: Optional[int] = Field(None, description="Set when the alert is about a specific product.")
    warehouse_id: Optional[int] = Field(
        None, description="Set when the alert is about a specific warehouse."
    )


class NarratedAlert(Alert):
    """Everything from Alert, unchanged, plus the generated narration.

    id/category/severity/evidence/product_id/warehouse_id are passed
    through exactly as given to narrate_alert() - the model never
    regenerates them, only narrative and proposed_action.
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
