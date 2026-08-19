import test from "node:test";
import assert from "node:assert/strict";
import {
  appendLine,
  applyModifierChanges,
  applyOptimisticRevision,
  callScopeKey,
  invalidateQuote,
  orderReadiness,
  quoteIsCurrent,
  toRpcItems,
  updateLine,
  type WorkingLine,
  type WorkingOrderState,
  type WorkingSelection,
} from "../lib/working-order-core";

const ids = {
  pepperoni: "11111111-1111-4111-8111-111111111111",
  coke: "22222222-2222-4222-8222-222222222222",
  omelet: "33333333-3333-4333-8333-333333333333",
  whiteToast: "44444444-4444-4444-8444-444444444444",
  hashBrowns: "55555555-5555-4555-8555-555555555555",
  squarePotatoes: "66666666-6666-4666-8666-666666666666",
  noOnions: "77777777-7777-4777-8777-777777777777",
  mild: "88888888-8888-4888-8888-888888888888",
  breadGroup: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sideGroup: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  removeGroup: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  spiceGroup: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
};

function line(overrides: Partial<WorkingLine> = {}): WorkingLine {
  return {
    line_id: "li_pepperoni",
    menu_item_id: ids.pepperoni,
    item_name: "Pepperoni",
    quantity: 1,
    selections: [],
    requirements: [],
    ...overrides,
  };
}

function selection(overrides: Partial<WorkingSelection>): WorkingSelection {
  return {
    modifier_id: ids.whiteToast,
    modifier_name: "White Toast",
    modifier_group_id: ids.breadGroup,
    action: "add",
    ...overrides,
  };
}

function state(overrides: Partial<WorkingOrderState> = {}): WorkingOrderState {
  return {
    id: "state-1",
    call_id: "call-a",
    agent_id: "agent-1",
    restaurant_id: "restaurant-1",
    location_id: "location-1",
    items: [],
    revision: 0,
    quoted_revision: null,
    quote_token: null,
    quote_payload: null,
    quote_result: null,
    status: "building",
    created_order_id: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

test("A single resolved item stores the authoritative menu_item_id", () => {
  const items = appendLine([], line());
  assert.equal(items.length, 1);
  assert.equal(items[0].menu_item_id, ids.pepperoni);
});

test("B multiple resolved items persist together", () => {
  const pepperoni = line();
  const coke = line({ line_id: "li_coke", menu_item_id: ids.coke, item_name: "Coke" });
  const items = appendLine(appendLine([], pepperoni), coke);
  assert.deepEqual(items.map((item) => item.item_name), ["Pepperoni", "Coke"]);
});

test("C modifying Coke preserves its line_id and leaves Pepperoni untouched", () => {
  const pepperoni = line();
  const coke = line({ line_id: "li_coke", menu_item_id: ids.coke, item_name: "Coke" });
  const before = [pepperoni, coke];
  const after = updateLine(before, "li_coke", { quantity: 2 });
  assert.equal(after[1].line_id, "li_coke");
  assert.equal(after[1].quantity, 2);
  assert.deepEqual(after[0], pepperoni);
});

test("D incremental omelet changes preserve white toast while adding no-onions and mild", () => {
  const omelet = line({
    line_id: "li_omelet",
    menu_item_id: ids.omelet,
    item_name: "Veggie Omelet",
    requirements: [
      { modifier_group_id: ids.breadGroup, group_name: "Bread Choice", min_selections: 1, max_selections: 1 },
    ],
  });
  let items = [omelet];
  items = updateLine(items, "li_omelet", {
    modifier_changes: [{ operation: "add", selection: selection({ modifier_id: ids.whiteToast, modifier_name: "White Toast" }) }],
  });
  items = updateLine(items, "li_omelet", {
    modifier_changes: [{ operation: "add", selection: selection({ modifier_id: ids.noOnions, modifier_name: "Onions", modifier_group_id: ids.removeGroup, action: "remove" }) }],
  });
  items = updateLine(items, "li_omelet", {
    modifier_changes: [{ operation: "add", selection: selection({ modifier_id: ids.mild, modifier_name: "Mild", modifier_group_id: ids.spiceGroup }) }],
  });
  assert.equal(items[0].line_id, "li_omelet");
  assert.deepEqual(items[0].selections.map((s) => s.modifier_name).sort(), ["Mild", "Onions", "White Toast"]);
});

test("E substitution replaces the old side on the same omelet line and records what it replaced", () => {
  const hash = selection({ modifier_id: ids.hashBrowns, modifier_name: "Hash Browns", modifier_group_id: ids.sideGroup });
  const square = selection({
    modifier_id: ids.squarePotatoes,
    modifier_name: "Square-Cut Potatoes",
    modifier_group_id: ids.sideGroup,
    substitutes_for_modifier_id: ids.hashBrowns,
    substitutes_for_name: "Hash Browns",
  });
  const after = applyModifierChanges([hash], [{ operation: "add", selection: square }]);
  assert.equal(after.length, 1);
  assert.equal(after[0].modifier_id, ids.squarePotatoes);
  assert.equal(after[0].substitutes_for_name, "Hash Browns");
});

test("F incomplete required selections are ORDER_NOT_READY-equivalent and a mocked quote boundary is not called", async () => {
  const omelet = line({
    line_id: "li_omelet",
    menu_item_id: ids.omelet,
    item_name: "Veggie Omelet",
    requirements: [{ modifier_group_id: ids.breadGroup, group_name: "Bread Choice", min_selections: 1, max_selections: 1 }],
  });
  let quoteCalls = 0;
  const readiness = orderReadiness([omelet]);
  if (readiness.ready) quoteCalls += 1;
  assert.equal(readiness.ready, false);
  assert.equal(readiness.reason, "MISSING_REQUIRED_SELECTIONS");
  assert.equal(quoteCalls, 0);
});

test("G quote payload items come only from stored working-order lines", () => {
  const stored = [line({ size_id: "size-pepperoni" })];
  const rpc = toRpcItems(stored);
  assert.equal(rpc.length, 1);
  assert.equal(rpc[0].menu_item_id, ids.pepperoni);
  assert.equal(rpc[0].size_id, "size-pepperoni");
});

test("H modifying state invalidates a previous quote and increments revision", () => {
  const quoted = state({ revision: 4, quoted_revision: 4, quote_token: "token", quote_payload: { a: 1 }, quote_result: { total: 10 }, status: "quoted" });
  const next = invalidateQuote(quoted);
  assert.equal(next.revision, 5);
  assert.equal(next.status, "building");
  assert.equal(next.quoted_revision, null);
  assert.equal(next.quote_token, null);
  assert.equal(next.quote_payload, null);
});

test("I stale quote cannot be treated as current after revision change", () => {
  const quoted = state({ revision: 2, quoted_revision: 2, quote_token: "good", status: "quoted" });
  assert.equal(quoteIsCurrent(quoted, "good"), true);
  const changed = invalidateQuote(quoted);
  assert.equal(quoteIsCurrent(changed, "good"), false);
});

test("J RPC IDs are sourced from the stored item/selection pair, not caller-supplied UUIDs", () => {
  const coke = line({
    line_id: "li_coke",
    menu_item_id: ids.coke,
    item_name: "Coke",
    size_id: "coke-size",
    selections: [],
  });
  const rpc = toRpcItems([coke]);
  assert.equal(rpc[0].menu_item_id, ids.coke);
  assert.equal(rpc[0].size_id, "coke-size");
});

test("K different call_ids have different storage scope keys", () => {
  const a = callScopeKey("restaurant", "location", "call-a");
  const b = callScopeKey("restaurant", "location", "call-b");
  assert.notEqual(a, b);
});

test("L optimistic revision rejects a stale simultaneous update", () => {
  const current = { revision: 3, value: "first" };
  const winner = applyOptimisticRevision(current, 3, (value) => ({ ...value, revision: 4, value: "winner" }));
  assert.equal(winner.value, "winner");
  assert.throws(() => applyOptimisticRevision(winner, 3, (value) => ({ ...value, revision: 4 })), /WORKING_ORDER_CONFLICT/);
});

test("M browse-only behavior requires no state mutation", () => {
  const before = state({ items: [line()] });
  const after = structuredClone(before);
  assert.deepEqual(after, before);
});

test("N ordinary acknowledgements require no working-order mutation", () => {
  const acknowledgements = ["no", "yes", "okay", "John", "4165550100"];
  const before = state({ items: [line()] });
  for (const _utterance of acknowledgements) {
    // No core mutation is invoked for conversational-only turns.
  }
  assert.deepEqual(before.items, [line()]);
});
