The AI system should **not** be built as one LLM with a large system prompt.

At the same time, it should also **not** be designed as a swarm of many agents that freely talk to each other.

The better architecture is a **Supervisor / Orchestrator Agent** above a small number of specialized domain agents. Each specialized agent has a clearly defined responsibility and accesses the ERP through typed tools.

The important rule is:

> **Agents reason, investigate, coordinate, and explain. Deterministic backend services calculate facts and execute business rules.**
> 

For example, the LLM should not calculate stock availability, shortest picking paths, FEFO ordering, reorder quantities, or invoice arithmetic itself. Those should be implemented as reliable backend tools that the agents call.

Specialist agents should normally return their findings to the Supervisor rather than freely calling one another. This keeps the execution predictable, prevents agent loops, and makes the system easier to debug and explain.

---

## Inventory Intelligence Agent

The Inventory Agent understands the current physical and logical state of inventory.

It is responsible for:

```
Stock
Warehouses
Zones / locations
Reservations
Available inventory
Transfers
Stock movement ledger
Inventory history
Inter-warehouse availability
```

Possible tools:

```
get_stock()
get_available_stock()
get_stock_by_warehouse()
get_warehouse_inventory()
get_product_movements()
get_stock_timeline()
find_transfer_candidates()
```

For example, the Supervisor may ask:

> How much Medical Mask inventory is actually available?
> 

The Inventory Agent does not estimate the answer itself.

It calls the inventory tools, which calculate:

```
Available = On-hand - Reserved
```

and returns the verified result.

It can also help investigate situations such as:

> Beirut is predicted to run out of masks. Does another warehouse have enough excess inventory to help?
> 

The Inventory Agent checks the other warehouses and returns possible transfer candidates.

---

# Risk & Insights Agent

Instead of maintaining separate Forecast and Risk agents, these responsibilities should be combined because they operate on closely related data.

The Risk & Insights Agent is responsible for:

```
Demand forecasting
Stockout prediction
Dead stock
Consumption spikes
Inventory imbalance
Expiry risk
Forecasted shortages
Operational anomalies
Predictive replenishment signals
```

Its tools might include:

```
forecast_demand()
predict_stockout()
calculate_safety_stock()
detect_consumption_spike()
analyze_dead_stock()
get_expiring_inventory()
calculate_inventory_risk()
```

The important distinction is that the **forecasting calculations happen inside deterministic forecasting services**, not inside the LLM.

For example:

```
Forecast Service
    ↓
Projected demand = 110 units/day

Stockout Service
    ↓
Stockout predicted in 5 days
```

The Risk & Insights Agent interprets those results and can answer:

> Why is Medical Mask inventory considered high risk?
> 

Instead of simply saying:

> You have 450 masks.
> 

It can explain:

> Current available stock is 450 units, average projected demand is 110 units per day, and the next confirmed purchase order does not arrive for 8 days. A shortage is therefore predicted before replenishment arrives.
> 

---

# Procurement Agent

The Procurement Agent handles purchasing and supplier-related decisions.

It understands:

```
Suppliers
Supplier prices
Supplier lead times
Supplier reliability
Supplier history
Purchase orders
Open incoming POs
Replenishment requirements
Supplier discrepancies
```

Possible tools:

```
get_suppliers()
compare_suppliers()
rank_suppliers()
calculate_reorder_quantity()
get_open_purchase_orders()
calculate_purchase_cost()
draft_purchase_order()
```

The Procurement Agent should not simply select the cheapest supplier.

It should consider factors such as:

```
Price
Lead time
Historical on-time delivery
Previous delays
Invoice discrepancies
Current replenishment urgency
```

Example:

```
Supplier A
Price: $0.80
Lead time: 8 days
Reliability: 91%

Supplier B
Price: $0.87
Lead time: 3 days
Reliability: 97%
```

If the warehouse will run out in 5 days, the Procurement Agent may recommend Supplier B even though it is more expensive.

It should explain why:

> Supplier A is cheaper, but its eight-day lead time would result in a projected three-day stockout. Supplier B costs more but can deliver before inventory reaches the safety-stock threshold.
> 

---

# Invoice Intelligence Agent

The Invoice Agent specializes in the invoice and document-processing workflow.

Its responsibilities include:

```
Invoice extraction
Supplier identification
Product matching
Purchase-order matching
Goods-received matching
Duplicate detection
Price discrepancies
Quantity discrepancies
Extraction confidence
Invoice anomaly detection
```

The workflow could be:

```
Invoice uploaded
      ↓
Amazon S3
      ↓
Document extraction
      ↓
Structured invoice data
      ↓
Supplier matching
      ↓
Product matching
      ↓
Purchase Order matching
      ↓
Goods Received matching
      ↓
Anomaly checks
      ↓
Human review
```

Possible tools:

```
extract_invoice()
find_supplier()
match_invoice_to_po()
match_invoice_to_receipt()
detect_duplicate_invoice()
detect_invoice_anomaly()
calculate_invoice_variance()
```

A major improvement over basic invoice extraction is **three-way matching**:

```
Invoice
   ↕
Purchase Order
   ↕
Goods Received
```

For example:

```
PO quantity:          500
Received quantity:    500
Invoice quantity:     700
```

The Invoice Agent should flag:

> The supplier invoiced 200 units more than were ordered and received.
> 

The calculations should be deterministic. The agent's role is to investigate and clearly explain the discrepancy.

---

# Fulfillment Agent

The Fulfillment Agent is responsible for the outgoing customer-order side of the ERP.

It understands:

```
Customer orders
Reservations
Warehouse selection
Picking
Shipping
Fulfillment status
Warehouse locations
Slotting recommendations
Pick paths
Order impact
```

Possible tools include:

```
get_customer_order()
evaluate_order_inventory()
choose_fulfillment_warehouse()
calculate_pick_path()
recommend_slotting()
find_crossdock_matches()
get_order_status()
```

For example, if a customer orders 1,000 masks, the Fulfillment Agent can determine whether one warehouse should fulfill the whole order or whether it should be split across several warehouses.

It could evaluate:

```
Beirut available: 700
Tripoli available: 800
Order requirement: 1,000
```

and recommend:

```
700 from Beirut
300 from Tripoli
```

It can also call the deterministic pick-path optimizer to determine the shortest warehouse route for a picker.

The LLM does **not** calculate the shortest geometric route itself.

The backend optimization service calculates the path, while the Fulfillment Agent explains the result.

---

# Supervisor Agent

The Supervisor Agent is the main brain of the AI system.

It receives the user's request and determines:

```
What problem is being asked?
Which specialist agents are required?
Which results need to be combined?
Does an action need approval?
```

The Supervisor should be the main coordinator between specialists.

Avoid architectures like:

```
Inventory Agent
      ↓
Risk Agent
      ↓
Procurement Agent
      ↓
Fulfillment Agent
      ↓
Inventory Agent
```

where agents can continuously invoke each other.

# Example Multi-Agent Workflow

Suppose the manager asks:

> We received an order for 1,000 masks. Can we fulfill it without creating a shortage?
> 

The Supervisor determines that several domains are involved.

```
Supervisor
    │
    ├── Inventory Agent
    │      ↓
    │   How much inventory is currently available?
    │
    ├── Fulfillment Agent
    │      ↓
    │   How would the 1,000-unit order affect reservations
    │   and warehouse fulfillment?
    │
    ├── Risk & Insights Agent
    │      ↓
    │   Would fulfilling the order create a future shortage?
    │
    └── Procurement Agent
           ↓
        If a shortage occurs, how should we replenish?
```

Assume the agents discover:

```
Available inventory:
Beirut: 700
Tripoli: 750

Order requirement:
1,000

Projected Beirut demand:
600 units during the next 7 days

Tripoli excess stock:
250 units

Recommended supplier:
Supplier B

Supplier B lead time:
3 days
```

The Supervisor combines the evidence and returns:

```
RECOMMENDATION

The order can be fulfilled.

Recommended fulfillment:
700 units from Beirut
300 units from Tripoli

However, fulfilling the order will place Beirut
below its projected 7-day demand requirement.

Recommended recovery plan:

1. Transfer 200 additional units from Tripoli.
2. Purchase 400 units from Supplier B.
3. Expected supplier delivery: August 18.

Projected stockout risk after the plan:
LOW
```

That is a meaningful multi-agent workflow because several business domains were required to solve one problem.

---

# AI Should Be Capable of Actions

The AI should not only answer questions.

It should be able to propose operational workflows.

For example:

> We're going to run out of masks. Fix the situation.
> 

The system could perform:

```
User request
     ↓
Supervisor investigates
     ↓
Inventory Agent checks stock
     ↓
Risk Agent confirms shortage
     ↓
Inventory Agent checks other warehouses
     ↓
Procurement Agent checks suppliers
     ↓
Supervisor compares alternatives
     ↓
Proposed resolution
     ↓
Manager approval
```

A proposed plan could contain:

```
Transfer 200 masks from Tripoli to Beirut

Create purchase order:
400 masks from Supplier B

Send supplier email

Create expected-delivery calendar event
```

But these actions should **not execute immediately**.

---

# Human-in-the-Loop Approval

The AI should be allowed to freely perform:

```
READ operations
ANALYSIS
FORECASTING
INVESTIGATION
RECOMMENDATIONS
```

But important write or external actions should require manager approval.

Examples:

```
Create purchase order
Execute warehouse transfer
Send supplier email
Cancel customer order
Change important order state
Create external calendar event
```

The workflow should be:

```
AI proposes action
       ↓
Approval Service
       ↓
Manager sees:

[Approve]
[Reject]

       ↓

If approved
       ↓
Workflow Executor
       ↓
Action executed
```

This approval should be enforced technically in the backend.

Do **not** rely only on a system prompt saying:

> Never perform actions without approval.
> 

For example, write tools could require:

```
approvalId
```

before execution.

Without a valid approved request, the backend rejects the action.

---

# Typed Tool Layer

A major architectural rule should be:

> **Agents should not directly query PostgreSQL or calculate business-critical values themselves.**
> 

They should interact with typed backend tools.

The architecture becomes:

```
                         AI AGENTS
                             │
                             ▼
                     TYPED TOOL LAYER
                             │
        ┌────────────────────┼────────────────────┐
        ▼                    ▼                    ▼
 Inventory Service     Forecast Service      Supplier Service
 Orders Service        Invoice Service       Optimization Service
 Ledger Service        Replenishment         Approval Service
                             │
                             ▼
                         PostgreSQL
```

This means both the frontend and AI can rely on the same backend business logic.

For example:

```
get_available_stock(productId, warehouseId)
```

always calculates availability according to the ERP's rules.

The LLM never invents its own version.

---

# Deterministic Logic vs AI Logic

Not every intelligent-looking feature should use an LLM.

These should normally use deterministic backend logic:

```
Available stock calculation
Reservation calculation
FEFO
Reorder formulas
Safety-stock calculations
Shortest pick path
Supplier scoring
Invoice arithmetic
Duplicate checks
PO state transitions
Warehouse transfer validation
```

Forecasting may use statistical or machine-learning models.

The AI agents should handle:

```
Understanding the user's request
Determining what needs investigation
Choosing which tools or specialists are required
Combining evidence from several systems
Comparing alternatives
Explaining recommendations
Creating proposed workflows
Communicating uncertainty and risk
```

This separation makes the system much more reliable.

Supervisor Agent

Inventory Agent
├── get_available_stock()
├── get_stock_by_warehouse()
├── get_inventory_history()
└── recommend_transfer_candidates()

Risk & Insights Agent
├── forecast_demand()
├── predict_stockout()
├── detect_spike()
├── get_expiry_risk()
└── analyze_dead_stock()

Procurement Agent
├── calculate_reorder_quantity()
├── compare_suppliers()
├── get_open_purchase_orders()
└── draft_purchase_order()

Invoice Agent
├── extract_invoice()
├── match_invoice_to_po()
├── detect_duplicate_invoice()
└── detect_invoice_anomaly()

Fulfillment Agent
├── get_customer_order()
├── choose_fulfillment_warehouse()
├── calculate_pick_path()
└── evaluate_order_impact()