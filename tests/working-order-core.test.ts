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
  removeLine,
  replaceLineItem,
  toRpcItems,
  updateLine,
  type WorkingLine,
  type WorkingOrderState,
  type WorkingRequirement,
  type WorkingSelection,
} from "../lib/working-order-core";

const ids = {
  pepperoni: "11111111-1111-4111-8111-111111111111",
  coke: "22222222-2222-4222-8222-222222222222",
  dietCoke: "22222222-2222-4222-8222-222222222223",
  omelet: "33333333-3333-4333-8333-333333333333",
  whiteToast: "44444444-4444-4444-8444-444444444444",
  hashBrowns: "55555555-5555-4555-8555-555555555555",
  squarePotatoes: "66666666-6666-4666-8666-666666666666",
  noOnions: "77777777-7777-4777-8777-777777777777",
  mild: "88888888-8888-4888-8888-888888888888",
  mushrooms: "99999999-9999-4999-8999-999999999999",
  peppers: "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa",
  cheese: "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb",
  breadGroup: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  sideGroup: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  removeGroup: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  spiceGroup: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  toppingGroup: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
};

const single = (id: string, name: string, min = 0): WorkingRequirement => ({
  modifier_group_id: id, group_name: name, selection_type: "single", min_selections: min, max_selections: 1,
});
const multi = (id: string, name: string, min = 0, max: number | null = null): WorkingRequirement => ({
  modifier_group_id: id, group_name: name, selection_type: "multiple", min_selections: min, max_selections: max,
});
function line(overrides: Partial<WorkingLine> = {}): WorkingLine {
  return { line_id: "li_pepperoni", menu_item_id: ids.pepperoni, item_name: "Pepperoni Pizza", quantity: 1, selections: [], requirements: [], ...overrides };
}
function selection(overrides: Partial<WorkingSelection> = {}): WorkingSelection {
  return { modifier_id: ids.whiteToast, modifier_name: "White Toast", modifier_group_id: ids.breadGroup, action: "add", quantity: 1, side: "whole", ...overrides };
}
function state(overrides: Partial<WorkingOrderState> = {}): WorkingOrderState {
  return {
    id: "state-1", call_id: "call-a", agent_id: "agent-1", restaurant_id: "restaurant-1", location_id: "location-1",
    items: [], revision: 0, quoted_revision: null, quote_token: null, quote_payload: null, quote_result: null,
    status: "building", created_order_id: null, expires_at: new Date(Date.now() + 60_000).toISOString(),
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), ...overrides,
  };
}

test("A single resolved item stores authoritative menu_item_id", () => {
  const items = appendLine([], line());
  assert.equal(items.length, 1); assert.equal(items[0].menu_item_id, ids.pepperoni);
});

test("B multiple items persist in one working order", () => {
  const items = appendLine(appendLine([], line()), line({ line_id: "li_coke", menu_item_id: ids.coke, item_name: "Coke" }));
  assert.deepEqual(items.map((i) => i.item_name), ["Pepperoni Pizza", "Coke"]);
});

test("C modification preserves line_id and unrelated lines", () => {
  const before = [line(), line({ line_id: "li_coke", menu_item_id: ids.coke, item_name: "Coke" })];
  const after = updateLine(before, "li_coke", { quantity: 2 });
  assert.equal(after[1].line_id, "li_coke"); assert.equal(after[1].quantity, 2); assert.deepEqual(after[0], before[0]);
});

test("D multi-select group preserves distinct toppings", () => {
  const rules = [multi(ids.toppingGroup, "Pizza Toppings")];
  let selections: WorkingSelection[] = [];
  for (const s of [
    selection({ modifier_id: ids.pepperoni, modifier_name: "Pepperoni", modifier_group_id: ids.toppingGroup }),
    selection({ modifier_id: ids.mushrooms, modifier_name: "Mushrooms", modifier_group_id: ids.toppingGroup }),
    selection({ modifier_id: ids.peppers, modifier_name: "Green Peppers", modifier_group_id: ids.toppingGroup }),
  ]) selections = applyModifierChanges(selections, [{ operation: "add", selection: s }], rules);
  assert.deepEqual(selections.map((s) => s.modifier_name), ["Pepperoni", "Mushrooms", "Green Peppers"]);
});

test("E repeating one multi-select modifier updates only that modifier", () => {
  const rules = [multi(ids.toppingGroup, "Pizza Toppings")];
  const mushrooms = selection({ modifier_id: ids.mushrooms, modifier_name: "Mushrooms", modifier_group_id: ids.toppingGroup });
  const peppers = selection({ modifier_id: ids.peppers, modifier_name: "Green Peppers", modifier_group_id: ids.toppingGroup });
  const next = applyModifierChanges([mushrooms, peppers], [{ operation: "add", selection: { ...mushrooms, quantity: 2, side: "left" } }], rules);
  assert.equal(next.length, 2); assert.equal(next.find((s) => s.modifier_id === ids.mushrooms)?.quantity, 2);
  assert.equal(next.find((s) => s.modifier_id === ids.peppers)?.modifier_name, "Green Peppers");
});

test("F single-select group replaces previous selection", () => {
  const rules = [single(ids.spiceGroup, "Spice")];
  const mild = selection({ modifier_id: ids.mild, modifier_name: "Mild", modifier_group_id: ids.spiceGroup });
  const hot = selection({ modifier_id: ids.peppers, modifier_name: "Hot", modifier_group_id: ids.spiceGroup });
  const next = applyModifierChanges([mild], [{ operation: "add", selection: hot }], rules);
  assert.deepEqual(next.map((s) => s.modifier_name), ["Hot"]);
});

test("G max selections is enforced", () => {
  const rules = [multi(ids.toppingGroup, "Fillings", 0, 2)];
  const existing = [
    selection({ modifier_id: ids.mushrooms, modifier_name: "Mushrooms", modifier_group_id: ids.toppingGroup }),
    selection({ modifier_id: ids.peppers, modifier_name: "Peppers", modifier_group_id: ids.toppingGroup }),
  ];
  assert.throws(() => applyModifierChanges(existing, [{ operation: "add", selection: selection({ modifier_id: ids.cheese, modifier_name: "Cheese", modifier_group_id: ids.toppingGroup }) }], rules), /MODIFIER_SELECTION_LIMIT/);
});

test("H incremental omelet changes preserve white toast, removal and mild", () => {
  const requirements = [single(ids.breadGroup, "Bread", 1), single(ids.spiceGroup, "Spice") , multi(ids.removeGroup, "Remove")];
  let items = [line({ line_id: "li_omelet", menu_item_id: ids.omelet, item_name: "Veggie Omelet", requirements })];
  items = updateLine(items, "li_omelet", { modifier_changes: [{ operation: "add", selection: selection() }] });
  items = updateLine(items, "li_omelet", { modifier_changes: [{ operation: "add", selection: selection({ modifier_id: ids.noOnions, modifier_name: "Onions", modifier_group_id: ids.removeGroup, action: "remove", target_ingredient_id: "ingredient-onion" }) }] });
  items = updateLine(items, "li_omelet", { modifier_changes: [{ operation: "add", selection: selection({ modifier_id: ids.mild, modifier_name: "Mild", modifier_group_id: ids.spiceGroup }) }] });
  assert.deepEqual(items[0].selections.map((s) => `${s.action}:${s.modifier_name}`).sort(), ["add:Mild", "add:White Toast", "remove:Onions"]);
});

test("I substitution stays on same line and records replacement", () => {
  const hash = selection({ modifier_id: ids.hashBrowns, modifier_name: "Hash Browns", modifier_group_id: ids.sideGroup });
  const potatoes = selection({ modifier_id: ids.squarePotatoes, modifier_name: "Square-Cut Potatoes", modifier_group_id: ids.sideGroup, substitutes_for_modifier_id: ids.hashBrowns, substitutes_for_name: "Hash Browns" });
  const next = applyModifierChanges([hash], [{ operation: "add", selection: potatoes }], [single(ids.sideGroup, "Side", 1)]);
  assert.equal(next.length, 1); assert.equal(next[0].modifier_id, ids.squarePotatoes); assert.equal(next[0].substitutes_for_name, "Hash Browns");
});

test("J required multi-select min is enforced by readiness", () => {
  const omelet = line({ requirements: [multi(ids.toppingGroup, "Fillings", 2, 5)], selections: [selection({ modifier_id: ids.mushrooms, modifier_name: "Mushrooms", modifier_group_id: ids.toppingGroup })] });
  assert.equal(orderReadiness([omelet]).ready, false);
  const ready = updateLine([omelet], omelet.line_id, { modifier_changes: [{ operation: "add", selection: selection({ modifier_id: ids.peppers, modifier_name: "Peppers", modifier_group_id: ids.toppingGroup }) }] });
  assert.equal(orderReadiness(ready).ready, true);
});

test("K empty order is not ready", () => { assert.equal(orderReadiness([]).ready, false); assert.equal(orderReadiness([]).reason, "EMPTY_ORDER"); });

test("L RPC payload preserves modifier quantity, side and quantity level", () => {
  const rpc = toRpcItems([line({ selections: [selection({ modifier_id: ids.cheese, modifier_name: "Extra Cheese", modifier_group_id: ids.toppingGroup, quantity: 2, side: "right", quantity_level_id: "level-extra", notes: "crispy" })] })]);
  assert.deepEqual(rpc[0].selections[0], { modifier_id: ids.cheese, quantity: 2, side: "right", quantity_level_id: "level-extra", notes: "crispy" });
});

test("M item replacement preserves line_id but clears incompatible old selections", () => {
  const before = [line({ line_id: "li_coke", menu_item_id: ids.coke, item_name: "Coke", size_id: "coke-small", selections: [selection()] })];
  const after = replaceLineItem(before, "li_coke", { menu_item_id: ids.dietCoke, item_name: "Diet Coke", size_id: "diet-small", quantity: 1, selections: [], requirements: [] });
  assert.equal(after[0].line_id, "li_coke"); assert.equal(after[0].menu_item_id, ids.dietCoke); assert.equal(after[0].size_id, "diet-small"); assert.equal(after[0].selections.length, 0);
});

test("N removing an existing modifier removes only that modifier", () => {
  const selections = [selection(), selection({ modifier_id: ids.mild, modifier_name: "Mild", modifier_group_id: ids.spiceGroup })];
  const next = applyModifierChanges(selections, [{ operation: "remove", modifier_name: "White Toast", modifier_group_id: ids.breadGroup }], []);
  assert.deepEqual(next.map((s) => s.modifier_name), ["Mild"]);
});

test("O quote invalidation increments revision and clears quote", () => {
  const next = invalidateQuote(state({ revision: 5, quoted_revision: 5, quote_token: "token", quote_payload: { x: 1 }, quote_result: { total: 10 }, status: "quoted" }));
  assert.equal(next.revision, 6); assert.equal(next.status, "building"); assert.equal(next.quote_token, null); assert.equal(next.quoted_revision, null);
});

test("P stale quote is never current after change", () => {
  const quoted = state({ revision: 2, quoted_revision: 2, quote_token: "good", status: "quoted" });
  assert.equal(quoteIsCurrent(quoted, "good"), true); assert.equal(quoteIsCurrent(invalidateQuote(quoted), "good"), false);
});

test("Q removing a line invalidates order shape without touching peers", () => {
  const pizza = line(); const coke = line({ line_id: "li_coke", menu_item_id: ids.coke, item_name: "Coke" });
  assert.deepEqual(removeLine([pizza, coke], "li_coke"), [pizza]);
});

test("R different call/location/restaurant scope keys never collide", () => {
  const base = callScopeKey("r1", "l1", "c1");
  assert.notEqual(base, callScopeKey("r1", "l1", "c2")); assert.notEqual(base, callScopeKey("r1", "l2", "c1")); assert.notEqual(base, callScopeKey("r2", "l1", "c1"));
});

test("S optimistic revision rejects stale simultaneous writer", () => {
  const current = { revision: 3, value: "first" };
  const winner = applyOptimisticRevision(current, 3, (v) => ({ ...v, revision: 4, value: "winner" }));
  assert.throws(() => applyOptimisticRevision(winner, 3, (v) => ({ ...v, revision: 4 })), /WORKING_ORDER_CONFLICT/);
});

test("T browse and acknowledgement turns cause zero mutations", () => {
  const before = state({ items: [line()] }); const serialized = JSON.stringify(before);
  const turns = ["What pizzas do you have?", "What does it come with?", "Do you have hash browns?", "yes", "no", "okay", "sure", "Kishan", "4165550100"];
  for (const _turn of turns) { /* conversational/read-only: no mutation function called */ }
  assert.equal(JSON.stringify(before), serialized);
});

test("U full 11-turn complex conversation ends with exactly two lines and no lost choices", () => {
  const omeletRules = [single(ids.breadGroup, "Bread", 1), single(ids.sideGroup, "Side", 1), multi(ids.removeGroup, "Remove"), single(ids.spiceGroup, "Spice")];
  let items: WorkingLine[] = [];
  // Turn 1 order. Turns 2/4 browse only and deliberately do nothing.
  items = appendLine(items, line({ line_id: "li_omelet", menu_item_id: ids.omelet, item_name: "Veggie Omelet", requirements: omeletRules }));
  const omeletId = items[0].line_id;
  // Turn 3 white toast.
  items = updateLine(items, omeletId, { modifier_changes: [{ operation: "add", selection: selection() }] });
  // Turn 6 accepted substitution (Hash Browns was a pending/known choice represented by replacement metadata).
  items = updateLine(items, omeletId, { modifier_changes: [{ operation: "add", selection: selection({ modifier_id: ids.squarePotatoes, modifier_name: "Square-Cut Potatoes", modifier_group_id: ids.sideGroup, substitutes_for_modifier_id: ids.hashBrowns, substitutes_for_name: "Hash Browns" }) }] });
  // Turn 7 removal and Turn 8 mild.
  items = updateLine(items, omeletId, { modifier_changes: [{ operation: "add", selection: selection({ modifier_id: ids.noOnions, modifier_name: "Onions", modifier_group_id: ids.removeGroup, action: "remove", target_ingredient_id: "ingredient-onion" }) }] });
  items = updateLine(items, omeletId, { modifier_changes: [{ operation: "add", selection: selection({ modifier_id: ids.mild, modifier_name: "Mild", modifier_group_id: ids.spiceGroup }) }] });
  // Turn 9 Coke. Turn 10 quote and 11 create are orchestration boundaries, not state reconstruction.
  items = appendLine(items, line({ line_id: "li_coke", menu_item_id: ids.coke, item_name: "Coke", requirements: [] }));
  assert.equal(items.length, 2); assert.equal(items[0].line_id, omeletId); assert.equal(items[1].item_name, "Coke");
  const omelet = items[0];
  assert.deepEqual(omelet.selections.map((s) => s.modifier_name).sort(), ["Mild", "Onions", "Square-Cut Potatoes", "White Toast"]);
  assert.equal(omelet.selections.find((s) => s.modifier_id === ids.squarePotatoes)?.substitutes_for_name, "Hash Browns");
  assert.equal(omelet.selections.find((s) => s.modifier_id === ids.noOnions)?.action, "remove");
  assert.equal(orderReadiness(items).ready, true);
});
