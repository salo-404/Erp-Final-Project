import assert from "node:assert/strict";
import test from "node:test";

import { deliveryBucket } from "../src/lib/calendarStats.ts";
import { transactionStatusBadge } from "../src/lib/transactionStatus.ts";

const reference = new Date("2026-08-26T18:00:00.000Z");

test("pending delivery expected today is not overdue", () => {
  assert.equal(transactionStatusBadge("PENDING", "2026-08-26T00:00:00.000Z", reference).label, "Pending");
  assert.equal(deliveryBucket("2026-08-26T00:00:00.000Z", reference), "today");
});

test("pending delivery expected before today is overdue", () => {
  assert.equal(transactionStatusBadge("PENDING", "2026-08-20T00:00:00.000Z", reference).label, "Overdue");
  assert.equal(deliveryBucket("2026-08-20T00:00:00.000Z", reference), "overdue");
});

test("future pending delivery is not overdue", () => {
  assert.equal(transactionStatusBadge("PENDING", "2026-08-29T00:00:00.000Z", reference).label, "Pending");
  assert.equal(deliveryBucket("2026-08-29T00:00:00.000Z", reference), "upcoming");
});

test("completed delivery is never overdue", () => {
  assert.equal(transactionStatusBadge("COMPLETED", "2026-08-20T00:00:00.000Z", reference).label, "Completed");
});
