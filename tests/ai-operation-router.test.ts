import test from "node:test";
import assert from "node:assert/strict";
import { classifyAiOperation, isWorkingOrderOperation } from "../lib/ai-operation-router";

test("Retell browse/info endpoints stay outside working-order mutation", () => {
  for (const operation of ["restaurant", "menu", "menu/availability", "reservation/availability", "reservation/create", "order/lookup", "order/modify", "order/cancel"]) {
    assert.equal(classifyAiOperation(operation), "read-or-existing", operation);
  }
});

test("explicit new-order state operations route to authoritative working order", () => {
  for (const operation of ["order/state", "order/item/add", "order/item/update", "order/item/remove", "order/quote", "order/create"]) {
    assert.equal(isWorkingOrderOperation(operation), true, operation);
  }
});

test("ordinary acknowledgements are not API operations", () => {
  for (const utterance of ["yes", "no", "okay", "sure", "yeah", "sounds good", "great", "thanks", "my name is Kishan"]) {
    assert.equal(isWorkingOrderOperation(utterance), false, utterance);
  }
});
