import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const APP = process.env.TEST_APP_URL ?? "http://127.0.0.1:3000";
const DB = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "http://127.0.0.1:3001";
const RETELL_KEY = process.env.RETELL_API_KEY;
const JWT = process.env.SUPABASE_SERVICE_ROLE_KEY;
assert.ok(RETELL_KEY, "RETELL_API_KEY required");
assert.ok(JWT, "SUPABASE_SERVICE_ROLE_KEY required");

const AGENT = "retell-agent-a1";
const AGENT2 = "retell-agent-a2";
const AGENT_L2 = "retell-agent-a-l2";
const AGENT_B = "retell-agent-b1";
const R = "11111111-1111-1111-1111-111111111111";
const L = "22222222-2222-2222-2222-222222222222";
const OMELET = "20000000-0000-4000-8000-000000000001";
const COKE = "20000000-0000-4000-8000-000000000002";
const DIET = "20000000-0000-4000-8000-000000000003";
const PIZZA = "20000000-0000-4000-8000-000000000004";
const OTHER_TENANT_COKE = "20000000-0000-4000-8000-000000000005";
const COKE_SIZE = "30000000-0000-4000-8000-000000000003";
const DIET_SIZE = "30000000-0000-4000-8000-000000000004";
const HASH = "50000000-0000-4000-8000-000000000002";

function retellSignature(raw) {
  const timestamp = Date.now();
  const digest = createHmac("sha256", RETELL_KEY).update(raw + timestamp).digest("hex");
  return `v=${timestamp},d=${digest}`;
}

async function tool(operation, args = {}, { callId = "call-main", agentId = AGENT, badSignature = false } = {}) {
  const raw = JSON.stringify({ call: { agent_id: agentId, call_id: callId }, args });
  const response = await fetch(`${APP}/api/ai/${operation}`, {
    method: "POST",
    headers: { "content-type": "application/json", "X-Retell-Signature": badSignature ? "v=1,d=deadbeef" : retellSignature(raw) },
    body: raw,
  });
  let body;
  try { body = await response.json(); } catch { body = { raw: await response.text() }; }
  return { status: response.status, body };
}

async function db(path, init = {}) {
  const headers = { Authorization: `Bearer ${JWT}`, apikey: JWT, "content-type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) };
  const response = await fetch(`${DB}/${path}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  if (text) { try { body = JSON.parse(text); } catch { body = text; } }
  if (!response.ok) throw new Error(`DB ${response.status}: ${text}`);
  return body;
}

function data(result) { assert.equal(result.body.success, true, JSON.stringify(result.body)); return result.body.data; }
function expectCode(result, status, code) { assert.equal(result.status, status, JSON.stringify(result.body)); assert.equal(result.body.error_code, code, JSON.stringify(result.body)); }

console.log("HTTP 1: signature auth");
expectCode(await tool("order/state", {}, { badSignature: true }), 401, "UNAUTHORIZED");

console.log("HTTP 2: browse is read-only");
let state = data(await tool("order/state"));
assert.equal(state.working_order, null);
const menu = data(await tool("menu", { item: "Veggie Omelet" }));
assert.equal(menu.items.length, 1);
assert.equal(menu.items[0].name, "Veggie Omelet");
state = data(await tool("order/state"));
assert.equal(state.working_order, null, "get_menu must not create working state");

console.log("HTTP 3: add omelet and keep stable line");
let added = data(await tool("order/item/add", { item_name: "Veggie Omelet" }));
assert.equal(added.items.length, 1);
const omeletLine = added.added_line_id;
assert.equal(added.items[0].menu_item_id, OMELET);
assert.equal(added.readiness.ready, false, "required bread/side are unresolved");

console.log("HTTP 4: informational availability does not mutate state");
let beforeBrowse = data(await tool("order/state")).working_order;
const availability = data(await tool("menu/availability", { menu_item_id: OMELET, modifier_ids: [HASH] }));
assert.equal(availability.available, false);
assert.equal(availability.reason, "modifier_unavailable");
let afterBrowse = data(await tool("order/state")).working_order;
assert.equal(afterBrowse.revision, beforeBrowse.revision);
assert.deepEqual(afterBrowse.items, beforeBrowse.items);

console.log("HTTP 5: white toast + substitution + no onions + mild merge incrementally");
let updated = data(await tool("order/item/update", { line_id: omeletLine, modifier_changes: [{ modifier_name: "White Toast", operation: "add" }] }));
assert.equal(updated.updated_line_id, omeletLine);
updated = data(await tool("order/item/update", { line_id: omeletLine, modifier_changes: [{ modifier_name: "Square-Cut Potatoes", operation: "add", replaces_modifier_name: "Hash Browns" }] }));
updated = data(await tool("order/item/update", { line_id: omeletLine, modifier_changes: [{ modifier_name: "Onions", operation: "add", action: "remove" }] }));
updated = data(await tool("order/item/update", { line_id: omeletLine, modifier_changes: [{ modifier_name: "Mild", operation: "add" }] }));
const omelet = updated.items.find((item) => item.line_id === omeletLine);
assert.deepEqual(omelet.selections.map((s) => s.modifier_name).sort(), ["Mild", "Onions", "Square-Cut Potatoes", "White Toast"]);
assert.equal(omelet.selections.find((s) => s.modifier_name === "Square-Cut Potatoes").substitutes_for_name, "Hash Browns");
assert.equal(omelet.selections.find((s) => s.modifier_name === "Onions").action, "remove");
assert.ok(omelet.selections.find((s) => s.modifier_name === "Onions").target_ingredient_id);
assert.equal(updated.readiness.ready, true);

console.log("HTTP 6: Coke becomes second line, never duplicates omelet");
added = data(await tool("order/item/add", { item_name: "Coke" }));
assert.equal(added.items.length, 2);
assert.equal(added.items.filter((i) => i.line_id === omeletLine).length, 1);
const cokeLine = added.items.find((i) => i.item_name === "Coke");
assert.ok(cokeLine);
assert.equal(cokeLine.menu_item_id, COKE);
assert.equal(cokeLine.size_id, COKE_SIZE);

console.log("HTTP 7: calculate ignores hostile reconstructed items[] and quotes stored state");
const quoteArgs = {
  customer_name: "Test Customer", customer_phone: "4165550100", fulfillment_type: "pickup", expected_revision: added.revision,
  items: [{ menu_item_id: OTHER_TENANT_COKE, size_id: "30000000-0000-4000-8000-000000000005", quantity: 99 }],
};
const quote = data(await tool("order/quote", quoteArgs));
assert.equal(quote.items.length, 2);
assert.deepEqual(quote.items.map((i) => i.menu_item_id).sort(), [COKE, OMELET].sort());
assert.equal(quote.quote.items.length, 2);
assert.deepEqual(quote.quote.items.map((i) => i.menu_item_id).sort(), [COKE, OMELET].sort());
const quoteToken = quote.quote_token;
const quotedRevision = quote.working_order_revision;

console.log("HTTP 8: two simultaneous create requests never create two orders");
const createArgs = { customer_confirmed: true, quote_token: quoteToken, expected_revision: quotedRevision };
const [create1, create2] = await Promise.all([tool("order/create", createArgs), tool("order/create", createArgs)]);
const createStatuses = [create1.status, create2.status].sort();
assert.ok(createStatuses.includes(201), `one create must succeed: ${JSON.stringify([create1, create2])}`);
assert.ok(createStatuses.every((s) => [200, 201, 409].includes(s)), JSON.stringify([create1, create2]));
const createdOrders = await db(`orders?restaurant_id=eq.${R}&location_id=eq.${L}&select=id`);
assert.equal(createdOrders.length, 1, "exactly one authoritative restaurant order");
const idemRows = await db("http_ai_idempotency?select=agent_id,idempotency_key,response");
assert.equal(idemRows.length, 1, "exactly one idempotency record");
state = data(await tool("order/state")).working_order;
assert.equal(state.status, "created");
assert.equal(state.items.length, 2);

console.log("HTTP 9: agent/restaurant/location isolation");
expectCode(await tool("order/state", {}, { callId: "call-main", agentId: AGENT2 }), 403, "AGENT_SCOPE_MISMATCH");
assert.equal(data(await tool("order/state", {}, { callId: "call-main", agentId: AGENT_L2 })).working_order, null);
assert.equal(data(await tool("order/state", {}, { callId: "call-main", agentId: AGENT_B })).working_order, null);
expectCode(await tool("menu/availability", { menu_item_id: OTHER_TENANT_COKE }, { callId: "tenant-check", agentId: AGENT }), 404, "ITEM_NOT_FOUND");

console.log("HTTP 10: Coke -> Diet Coke keeps line_id and resolves new size ID");
const replaceCall = "call-replace";
let replace = data(await tool("order/item/add", { item_name: "Coke" }, { callId: replaceCall }));
const replaceLine = replace.added_line_id;
assert.equal(replace.items[0].size_id, COKE_SIZE);
replace = data(await tool("order/item/update", { line_id: replaceLine, replace_item_name: "Diet Coke" }, { callId: replaceCall }));
assert.equal(replace.items[0].line_id, replaceLine);
assert.equal(replace.items[0].menu_item_id, DIET);
assert.equal(replace.items[0].size_id, DIET_SIZE);

console.log("HTTP 11: pizza multi-select preserves peers, quantity and side");
const pizzaCall = "call-pizza";
let pizza = data(await tool("order/item/add", {
  item_name: "Pepperoni Pizza", size_name: "Large",
  modifier_changes: [
    { modifier_name: "Pepperoni", quantity: 1, side: "whole" },
    { modifier_name: "Mushrooms", quantity: 1, side: "right" },
  ],
}, { callId: pizzaCall }));
const pizzaLine = pizza.added_line_id;
pizza = data(await tool("order/item/update", { line_id: pizzaLine, modifier_changes: [{ modifier_name: "Green Peppers", quantity: 1, side: "left" }] }, { callId: pizzaCall }));
pizza = data(await tool("order/item/update", { line_id: pizzaLine, modifier_changes: [{ modifier_name: "Mushrooms", quantity: 2, side: "left" }] }, { callId: pizzaCall }));
assert.deepEqual(pizza.items[0].selections.map((s) => s.modifier_name).sort(), ["Green Peppers", "Mushrooms", "Pepperoni"]);
assert.equal(pizza.items[0].selections.find((s) => s.modifier_name === "Mushrooms").quantity, 2);
assert.equal(pizza.items[0].selections.find((s) => s.modifier_name === "Mushrooms").side, "left");
expectCode(await tool("order/item/update", { line_id: pizzaLine, modifier_changes: [{ modifier_name: "White Toast" }] }, { callId: pizzaCall }), 409, "INVALID_MODIFIER");

console.log("HTTP 12: quote invalidates after size change and old create is rejected");
let pizzaState = data(await tool("order/state", {}, { callId: pizzaCall })).working_order;
let pizzaQuote = data(await tool("order/quote", { customer_name: "Pizza Test", customer_phone: "4165550199", fulfillment_type: "pickup", expected_revision: pizzaState.revision }, { callId: pizzaCall }));
pizza = data(await tool("order/item/update", { line_id: pizzaLine, size_name: "Medium", expected_revision: pizzaQuote.working_order_revision }, { callId: pizzaCall }));
assert.equal(pizza.items[0].size_name, "Medium");
expectCode(await tool("order/create", { customer_confirmed: true, quote_token: pizzaQuote.quote_token }, { callId: pizzaCall }), 409, "ORDER_NOT_READY");

console.log("HTTP 13: missing required modifiers prevents quote");
const missingCall = "call-missing";
const missing = data(await tool("order/item/add", { item_name: "Veggie Omelet" }, { callId: missingCall }));
assert.equal(missing.readiness.ready, false);
expectCode(await tool("order/quote", { customer_name: "Missing Test", customer_phone: "4165550111", fulfillment_type: "pickup" }, { callId: missingCall }), 409, "ORDER_NOT_READY");

console.log("HTTP 14: restaurant fulfillment settings are enforced at quote boundary");
await db(`restaurant_settings?restaurant_id=eq.${R}`, { method: "PATCH", body: JSON.stringify({ pickup_enabled: false }) });
const disabledCall = "call-disabled";
await tool("order/item/add", { item_name: "Coke" }, { callId: disabledCall });
expectCode(await tool("order/quote", { customer_name: "Disabled Test", customer_phone: "4165550122", fulfillment_type: "pickup" }, { callId: disabledCall }), 409, "FULFILLMENT_UNAVAILABLE");
await db(`restaurant_settings?restaurant_id=eq.${R}`, { method: "PATCH", body: JSON.stringify({ pickup_enabled: true }) });

console.log("HTTP 15: restaurant hours are enforced at quote boundary");
await db(`restaurant_hours?location_id=eq.${L}`, { method: "PATCH", body: JSON.stringify({ is_closed: true }) });
const closedCall = "call-closed";
await tool("order/item/add", { item_name: "Coke" }, { callId: closedCall });
expectCode(await tool("order/quote", { customer_name: "Closed Test", customer_phone: "4165550133", fulfillment_type: "pickup" }, { callId: closedCall }), 409, "RESTAURANT_CLOSED");
await db(`restaurant_hours?location_id=eq.${L}`, { method: "PATCH", body: JSON.stringify({ is_closed: false }) });

console.log("RETELL_SHAPED_HTTP_SIMULATION_PASS");
