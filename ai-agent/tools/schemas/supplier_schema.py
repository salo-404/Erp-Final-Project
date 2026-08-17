"""Pydantic models for the on-demand supplier analysis narration.

This is the "explain this supplier" button feature - distinct from
narration/control_tower.py's batch alert narration. SupplierStats is the
input shape (what the backend's existing getSupplierStats() /
rankSuppliers() / getTransactionHistory() would hand back, mocked today in
tools/mocks/supplier_mock_data.py). SupplierNarration is the output shape -
SupplierStats plus the two fields narrate_supplier() generates.

Field names are snake_case here (not the camelCase used by
tools/schemas/insights_schema.py / document_schema.py, which mirror the
backend's Prisma field names directly) - same convention as
tools/schemas/control_tower_schema.py, since this is the AI layer's own
narration-input contract rather than a 1:1 mirror of a backend record.
"""

from __future__ import annotations

from pydantic import BaseModel, Field


class SupplierStats(BaseModel):
    supplier_id: int
    name: str
    unit_cost: float = Field(..., description="Current unit cost this supplier charges.")
    lead_time_days: int = Field(..., description="Typical lead time in days.")
    reliability_score: float = Field(
        ..., ge=0, le=1, description="Backend-calculated on-time-delivery reliability, 0-1."
    )
    overall_score: float = Field(
        ..., ge=0, le=1, description="Backend-calculated composite score weighing cost, lead time, reliability."
    )
    recent_transaction_count: int = Field(..., description="Number of recent transactions with this supplier.")
    on_time_delivery_rate: float = Field(
        ..., ge=0, le=1, description="Share of recent deliveries that arrived on or before the expected date."
    )
    product_categories: list[str] = Field(
        ..., description="What this supplier supplies, e.g. ['Docking Stations', 'Peripherals']."
    )


class SupplierNarration(SupplierStats):
    """Everything from SupplierStats, unchanged, plus the generated narration.

    Every SupplierStats field is passed through exactly as given to
    narrate_supplier() - the model never regenerates them, only narrative
    and recommendation_context.
    """

    narrative: str = Field(
        ...,
        description="Plain-language explanation of this supplier's strengths and weaknesses - no jargon.",
    )
    recommendation_context: str = Field(
        ...,
        description=(
            "How this supplier compares to what a strong supplier profile looks like, and what "
            "situations it suits - informative context for a human decision, never a final "
            "directive telling the reader which supplier to pick."
        ),
    )
