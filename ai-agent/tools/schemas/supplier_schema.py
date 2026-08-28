"""Pydantic models for the on-demand supplier analysis narration.

This is the "explain this supplier" button feature - distinct from
narration/control_tower.py's batch alert narration. SupplierStats is the
input shape (what the backend's real getSupplierStats()/getTransactionHistory()
hand back, composed in narration/supplier_analysis.py's _fetch_supplier_stats()).
SupplierNarration is the output shape - SupplierStats plus the two fields
narrate_supplier() generates.

Field names are snake_case here (not the camelCase used by
tools/schemas/insights_schema.py / document_schema.py, which mirror the
backend's Prisma field names directly) - same convention as
tools/schemas/control_tower_schema.py, since this is the AI layer's own
narration-input contract rather than a 1:1 mirror of a backend record.
"""

from __future__ import annotations

from typing import Optional

from pydantic import BaseModel, Field


class SupplierStats(BaseModel):
    supplier_id: int
    name: str
    # unit_cost/lead_time_days/reliability_score/on_time_delivery_rate are
    # None exactly when the real backend has no value for this supplier
    # (e.g. no priced transactions yet, or leadTimeDays never set) - never
    # defaulted to 0, same convention as agents/insights_agent/tools.py's
    # compare_suppliers(). overall_score is always None: no real backend
    # endpoint computes a composite quality score for a supplier outside a
    # specific product's ranking (see SupplierIntelligenceService.
    # rankSuppliers(), which is product-scoped) - never fabricated.
    unit_cost: Optional[float] = Field(None, description="Average real unit cost this supplier has charged, if any priced transactions exist.")
    lead_time_days: Optional[int] = Field(None, description="Typical lead time in days, if configured on the supplier record.")
    reliability_score: Optional[float] = Field(
        None, ge=0, le=1, description="Backend-calculated on-time-delivery reliability, 0-1, if evaluable."
    )
    overall_score: Optional[float] = Field(
        None, ge=0, le=1, description="Backend-calculated composite score weighing cost, lead time, reliability."
    )
    recent_transaction_count: int = Field(..., description="Number of recent transactions with this supplier.")
    on_time_delivery_rate: Optional[float] = Field(
        None, ge=0, le=1, description="Share of recent deliveries that arrived on or before the expected date, if evaluable."
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
