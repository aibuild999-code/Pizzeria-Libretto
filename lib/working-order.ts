import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";
import {
  appendLine,
  applyModifierChanges,
  invalidateQuote,
  orderReadiness,
  removeLine,
  toRpcItems,
  updateLine,
  type ResolvedModifierChange,
  type WorkingLine,
  type WorkingOrderState,
  type WorkingRequirement,
  type WorkingSelection,
} from "@/lib/working-order-core";

type Json = Record<string, any>;
type Context = {
  supabase: ReturnType<typeof createServerSupabase>;
  agentId: string;
  restaurantId: string;
  locationId: string;
  callId: string;
  args: Json;
};
type ResolvedItemResult =
  | { ok: true; item: any; size: any | null }
  | { ok: false; error: NextResponse };

const ZERO = "00000000-0000-0000-0000-000000000000";
const ok = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status });
const fail = (error_code: string, message: string, status = 400, recoverable = true) =>
  NextResponse.json({ success: false, error_code, message, recoverable }, { status });
const stable = (value: any): string =>
  value === null || typeof value !== "object"
    ? JSON.stringify(value)
    : Array.isArray(value)
      ? `[${value.map(stable).join(",")}]`
      : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
const hash = (value: any) => createHash("sha256").update(stable(value)).digest("hex");
const quoteTokenFor = (value: any) => {
  const secret = process.env.RETELL_API_KEY;
  if (!secret) throw new Error("AI pricing confirmation is not configured");
  return createHmac("sha256", secret).update(hash(value)).digest("hex");
};
const safeEqual = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const normalize = (value: string) => value.trim().toLowerCase();

function verify(raw: string, signature: string | null) {
  const key = process.env.RETELL_API_KEY;
  if (!key || !signature) return false;
  const match = /^v=(\d+),d=([a-f0-9]+)$/i.exec(signature.trim());
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 300000) return false;
  const expected = createHmac("sha256", key).update(raw + match[1]).digest("hex");
  return safeEqual(expected, match[2].toLowerCase());
}

function normalizePhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  return digits.length === 10 ? `1${digits}` : digits.length === 11 && digits.startsWith("1") ? digits : "";
}

function lineId() {
  return `li_${randomUUID()}`;
}

function workingOrders(c: Context) {
  // Production intentionally does not have this table yet. Keep the type escape
  // isolated to this server-only development table until the migration is promoted.
  return (c.supabase as any).from("ai_working_orders");
}

async function auth(request: Request): Promise<Context | NextResponse> {
  const raw = await request.text();
  if (!verify(raw, request.headers.get("X-Retell-Signature"))) {
    return fail("UNAUTHORIZED", "This request is not an authenticated Retell request.", 401, false);
  }

  let payload: Json;
  try {
    payload = JSON.parse(raw);
  } catch {
    return fail("INVALID_JSON", "The AI request body is not valid JSON.", 400, false);
  }

  const args = payload.args && typeof payload.args === "object" ? payload.args : payload;
  const retellAgentId = payload?.call?.agent_id ?? payload.agent_id ?? args.agent_id;
  const callId = payload?.call?.call_id ?? payload.call_id ?? args.call_id;
  if (typeof retellAgentId !== "string") return fail("AGENT_REQUIRED", "The authenticated AI request did not identify an agent.", 400, false);
  if (typeof callId !== "string" || !callId.trim()) return fail("CALL_ID_REQUIRED", "A Retell call_id is required for order state.", 400, false);

  const supabase = createServerSupabase();
  const { data: agent, error } = await supabase
    .from("ai_agents")
    .select("id,restaurant_id,location_id,status")
    .eq("retell_agent_id", retellAgentId)
    .neq("status", "disabled")
    .limit(1)
    .maybeSingle();
  if (error || !agent) return fail("AGENT_NOT_AUTHORIZED", "This AI agent is not authorized.", 403, false);

  let locationId = agent.location_id as string | null;
  if (!locationId) {
    const { data: location } = await supabase
      .from("restaurant_locations")
      .select("id")
      .eq("restaurant_id", agent.restaurant_id)
      .eq("is_active", true)
      .limit(1)
      .maybeSingle();
    locationId = location?.id ?? null;
  }
  if (!locationId) return fail("LOCATION_NOT_CONFIGURED", "No active restaurant location is configured for this AI agent.", 409, false);

  return { supabase, agentId: agent.id, restaurantId: agent.restaurant_id, locationId, callId, args };
}

async function findState(c: Context): Promise<WorkingOrderState | null> {
  const { data, error } = await workingOrders(c)
    .select("*")
    .eq("restaurant_id", c.restaurantId)
    .eq("location_id", c.locationId)
    .eq("call_id", c.callId)
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  const state = (data ?? null) as WorkingOrderState | null;
  if (state && new Date(state.expires_at).getTime() < Date.now()) throw new Error("WORKING_ORDER_EXPIRED");
  return state;
}

async function getState(c: Context): Promise<WorkingOrderState>;
async function getState(c: Context, create: false): Promise<WorkingOrderState | null>;
async function getState(c: Context, create = true): Promise<WorkingOrderState | null> {
  const existing = await findState(c);
  if (existing || !create) return existing;

  const { data: created, error: createError } = await workingOrders(c)
    .insert({ call_id: c.callId, agent_id: c.agentId, restaurant_id: c.restaurantId, location_id: c.locationId })
    .select("*")
    .single();

  if (!createError && created) return created as WorkingOrderState;
  if (createError?.code === "23505") {
    const raced = await findState(c);
    if (raced) return raced;
  }
  throw createError ?? new Error("WORKING_ORDER_CREATE_FAILED");
}

async function save(c: Context, state: WorkingOrderState, items: WorkingLine[]) {
  const invalidated = invalidateQuote(state);
  const { data, error } = await workingOrders(c)
    .update({
      items,
      revision: invalidated.revision,
      quoted_revision: null,
      quote_token: null,
      quote_payload: null,
      quote_result: null,
      status: "building",
      updated_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    })
    .eq("id", state.id)
    .eq("revision", state.revision)
    .in("status", ["building", "quoted"])
    .select("*")
    .maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("WORKING_ORDER_CONFLICT");
  return data as WorkingOrderState;
}

async function resolveItem(c: Context, name: string, sizeName?: string): Promise<ResolvedItemResult> {
  const { data: categories, error: categoryError } = await c.supabase
    .from("menu_categories")
    .select("id")
    .eq("restaurant_id", c.restaurantId)
    .eq("is_active", true);
  if (categoryError) throw categoryError;
  const categoryIds = (categories ?? []).map((category) => category.id);

  const { data: items, error } = await c.supabase
    .from("menu_items")
    .select("id,name,price,is_available,category_id,item_type")
    .in("category_id", categoryIds.length ? categoryIds : [ZERO])
    .ilike("name", name.trim())
    .limit(5);
  if (error) throw error;

  const available = (items ?? []).filter((item) => item.is_available);
  if (available.length === 0) return { ok: false, error: fail("ITEM_NOT_FOUND", "I could not find an available menu item with that name.", 404) };
  if (available.length > 1) return { ok: false, error: fail("ITEM_AMBIGUOUS", "More than one menu item matches that name. Ask the customer to clarify.", 409) };

  const item = available[0];
  let size: any = null;
  const { data: sizes, error: sizeError } = await c.supabase
    .from("menu_item_sizes")
    .select("id,name,price,is_available")
    .eq("menu_item_id", item.id)
    .order("display_order");
  if (sizeError) throw sizeError;
  const availableSizes = (sizes ?? []).filter((candidate) => candidate.is_available);

  if (sizeName) {
    const matches = availableSizes.filter((candidate) => normalize(candidate.name) === normalize(sizeName));
    if (matches.length !== 1) return { ok: false, error: fail("SIZE_NOT_FOUND", "That size is not available for this item.", 409) };
    size = matches[0];
  } else if (availableSizes.length === 1) {
    size = availableSizes[0];
  } else if (availableSizes.length > 1) {
    return { ok: false, error: fail("SIZE_REQUIRED", "This item has multiple sizes. Ask the customer which size they want.", 409) };
  }

  return { ok: true, item, size };
}

async function loadRequirements(c: Context, itemId: string): Promise<WorkingRequirement[]> {
  const { data: links, error } = await c.supabase
    .from("menu_item_modifier_groups")
    .select("modifier_group_id,min_selections,max_selections,required")
    .eq("menu_item_id", itemId);
  if (error) throw error;
  const requiredLinks = (links ?? []).filter((link) => link.required || Number(link.min_selections ?? 0) > 0);
  if (!requiredLinks.length) return [];

  const ids = requiredLinks.map((link) => link.modifier_group_id);
  const { data: groups, error: groupError } = await c.supabase
    .from("modifier_groups")
    .select("id,name")
    .in("id", ids);
  if (groupError) throw groupError;

  return requiredLinks.map((link) => ({
    modifier_group_id: link.modifier_group_id,
    group_name: (groups ?? []).find((group) => group.id === link.modifier_group_id)?.name ?? "Required selection",
    min_selections: Math.max(1, Number(link.min_selections ?? 1)),
    max_selections: link.max_selections == null ? null : Number(link.max_selections),
  }));
}

const modifierChangeSchema = z.object({
  modifier_name: z.string().trim().min(1).max(120),
  operation: z.enum(["add", "remove"]).default("add"),
  action: z.enum(["add", "remove"]).optional(),
  replaces_modifier_name: z.string().trim().min(1).max(120).optional(),
});
type ModifierChangeInput = z.infer<typeof modifierChangeSchema>;

async function resolveModifierChanges(c: Context, itemId: string, changes: ModifierChangeInput[] | undefined): Promise<ResolvedModifierChange[]> {
  if (!changes?.length) return [];
  const additions = changes.filter((change) => change.operation === "add");
  if (!additions.length) return changes.map((change) => ({ operation: "remove" as const, modifier_name: change.modifier_name }));

  const { data: links, error: linkError } = await c.supabase
    .from("menu_item_modifier_groups")
    .select("modifier_group_id")
    .eq("menu_item_id", itemId);
  if (linkError) throw linkError;
  const groupIds = (links ?? []).map((link) => link.modifier_group_id);

  const { data: modifiers, error } = await c.supabase
    .from("modifiers")
    .select("id,name,modifier_group_id,is_available,action")
    .in("modifier_group_id", groupIds.length ? groupIds : [ZERO]);
  if (error) throw error;

  const resolved: ResolvedModifierChange[] = [];
  for (const change of changes) {
    if (change.operation === "remove") {
      resolved.push({ operation: "remove", modifier_name: change.modifier_name });
      continue;
    }

    const matches = (modifiers ?? []).filter((modifier) =>
      normalize(modifier.name) === normalize(change.modifier_name)
      && modifier.is_available
      && (!change.action || modifier.action === change.action),
    );
    if (matches.length === 0) throw new Error(`MODIFIER_NOT_FOUND:${change.modifier_name}`);
    if (matches.length > 1) throw new Error(`MODIFIER_AMBIGUOUS:${change.modifier_name}`);
    const modifier = matches[0];

    let substitutionTarget: any = null;
    if (change.replaces_modifier_name) {
      const targetMatches = (modifiers ?? []).filter((candidate) =>
        normalize(candidate.name) === normalize(change.replaces_modifier_name!),
      );
      if (targetMatches.length === 1) substitutionTarget = targetMatches[0];
    }

    const selection: WorkingSelection = {
      modifier_id: modifier.id,
      modifier_name: modifier.name,
      modifier_group_id: modifier.modifier_group_id,
      action: modifier.action === "remove" ? "remove" : "add",
      substitutes_for_modifier_id: substitutionTarget?.id,
      substitutes_for_name: change.replaces_modifier_name,
    };
    resolved.push({ operation: "add", selection });
  }
  return resolved;
}

const addSchema = z.object({
  item_name: z.string().trim().min(1).max(120),
  size_name: z.string().trim().max(100).optional(),
  quantity: z.coerce.number().int().min(1).max(99).default(1),
  modifier_changes: z.array(modifierChangeSchema).max(30).optional(),
  special_instructions: z.string().max(500).optional(),
});
const updateSchema = z.object({
  line_id: z.string().min(4),
  quantity: z.coerce.number().int().min(1).max(99).optional(),
  size_name: z.string().trim().max(100).optional(),
  modifier_changes: z.array(modifierChangeSchema).max(30).optional(),
  special_instructions: z.string().max(500).optional(),
});
const quoteSchema = z.object({
  customer_name: z.string().trim().min(1).max(120),
  customer_phone: z.string().trim().min(10).max(30),
  customer_email: z.string().email().max(320).optional(),
  fulfillment_type: z.enum(["pickup", "delivery", "dine_in"]),
  notes: z.string().max(1000).optional(),
  scheduled_for: z.string().datetime().optional(),
  delivery_address_line1: z.string().max(200).optional(),
  delivery_address_line2: z.string().max(200).optional(),
  delivery_city: z.string().max(100).optional(),
  delivery_province: z.string().max(100).optional(),
  delivery_postal_code: z.string().max(30).optional(),
  delivery_instructions: z.string().max(1000).optional(),
  table_number: z.string().max(30).optional(),
});

export async function handleWorkingOrderRequest(request: Request, operation: string[]) {
  const authorized = await auth(request);
  if (authorized instanceof NextResponse) return authorized;
  const c = authorized;
  const op = operation.join("/");

  try {
    if (op === "order/state") {
      const state = await getState(c, false);
      return ok({ working_order: state ? { call_id: c.callId, revision: state.revision, status: state.status, items: state.items, quoted_revision: state.quoted_revision, readiness: orderReadiness(state.items) } : null });
    }

    if (op === "order/item/add") {
      const input = addSchema.parse(c.args);
      const state = await getState(c);
      if (state.status === "created") return fail("ORDER_ALREADY_CREATED", "This call already created an order.", 409, false);
      if (state.status === "creating") return fail("ORDER_CREATE_IN_PROGRESS", "This order is already being created.", 409, true);

      const resolved = await resolveItem(c, input.item_name, input.size_name);
      if (!resolved.ok) return resolved.error;
      const [requirements, changes] = await Promise.all([
        loadRequirements(c, resolved.item.id),
        resolveModifierChanges(c, resolved.item.id, input.modifier_changes),
      ]);
      const line: WorkingLine = {
        line_id: lineId(),
        menu_item_id: resolved.item.id,
        item_name: resolved.item.name,
        size_id: resolved.size?.id,
        size_name: resolved.size?.name,
        quantity: input.quantity,
        special_instructions: input.special_instructions,
        selections: applyModifierChanges([], changes),
        requirements,
      };
      const items = appendLine(state.items, line);
      const saved = await save(c, state, items);
      return ok({ revision: saved.revision, items: saved.items, readiness: orderReadiness(saved.items) });
    }

    if (op === "order/item/update") {
      const input = updateSchema.parse(c.args);
      const state = await getState(c, false);
      if (!state) return fail("ORDER_NOT_READY", "There is no working order for this call.", 409);
      if (state.status === "creating") return fail("ORDER_CREATE_IN_PROGRESS", "This order is already being created.", 409, true);
      if (state.status === "created") return fail("ORDER_ALREADY_CREATED", "This call already created an order.", 409, false);

      const current = state.items.find((line) => line.line_id === input.line_id);
      if (!current) return fail("LINE_ITEM_NOT_FOUND", "That working-order line item could not be found.", 404);

      let sizeId = current.size_id;
      let sizeName = current.size_name;
      if (input.size_name !== undefined) {
        const resolved = await resolveItem(c, current.item_name, input.size_name);
        if (!resolved.ok) return resolved.error;
        sizeId = resolved.size?.id;
        sizeName = resolved.size?.name;
      }
      const changes = await resolveModifierChanges(c, current.menu_item_id, input.modifier_changes);
      const items = updateLine(state.items, input.line_id, {
        quantity: input.quantity,
        size_id: sizeId,
        size_name: sizeName,
        special_instructions: input.special_instructions,
        modifier_changes: changes.length ? changes : undefined,
      });
      const saved = await save(c, state, items);
      return ok({ revision: saved.revision, items: saved.items, readiness: orderReadiness(saved.items) });
    }

    if (op === "order/item/remove") {
      const input = z.object({ line_id: z.string().min(4) }).parse(c.args);
      const state = await getState(c, false);
      if (!state) return fail("ORDER_NOT_READY", "There is no working order for this call.", 409);
      if (state.status === "creating") return fail("ORDER_CREATE_IN_PROGRESS", "This order is already being created.", 409, true);
      if (state.status === "created") return fail("ORDER_ALREADY_CREATED", "This call already created an order.", 409, false);
      const saved = await save(c, state, removeLine(state.items, input.line_id));
      return ok({ revision: saved.revision, items: saved.items, readiness: orderReadiness(saved.items) });
    }

    if (op === "order/quote") {
      const input = quoteSchema.parse(c.args);
      const state = await getState(c, false);
      if (!state) return fail("ORDER_NOT_READY", "There is no working order for this call.", 409);
      if (state.status === "creating") return fail("ORDER_CREATE_IN_PROGRESS", "This order is already being created.", 409, true);
      if (state.status === "created") return fail("ORDER_ALREADY_CREATED", "This call already created an order.", 409, false);
      const readiness = orderReadiness(state.items);
      if (!readiness.ready) return fail("ORDER_NOT_READY", "The working order still has unresolved required selections.", 409, true);

      const phone = normalizePhone(input.customer_phone);
      if (!phone) return fail("INVALID_PHONE", "A valid 10-digit North American phone number is required.", 409);
      const rpcOrderItems = toRpcItems(state.items);
      const payload = { ...input, customer_phone: phone, items: rpcOrderItems, working_order_revision: state.revision };
      const { data, error } = await c.supabase.rpc("quote_complex_order_atomic", {
        p_restaurant_id: c.restaurantId,
        p_location_id: c.locationId,
        p_customer_name: input.customer_name,
        p_customer_phone: phone,
        p_fulfillment_type: input.fulfillment_type,
        p_notes: input.notes ?? null,
        p_scheduled_for: input.scheduled_for ?? null,
        p_delivery_address_line1: input.delivery_address_line1 ?? null,
        p_delivery_address_line2: input.delivery_address_line2 ?? null,
        p_delivery_city: input.delivery_city ?? null,
        p_delivery_province: input.delivery_province ?? null,
        p_delivery_postal_code: input.delivery_postal_code ?? null,
        p_delivery_instructions: input.delivery_instructions ?? null,
        p_table_number: input.table_number ?? null,
        p_items: rpcOrderItems,
      });
      if (error) throw error;

      const quoteToken = quoteTokenFor(payload);
      const { data: quotedState, error: updateError } = await workingOrders(c)
        .update({ quoted_revision: state.revision, quote_token: quoteToken, quote_payload: payload, quote_result: data, status: "quoted", updated_at: new Date().toISOString() })
        .eq("id", state.id)
        .eq("revision", state.revision)
        .in("status", ["building", "quoted"])
        .select("id")
        .maybeSingle();
      if (updateError) throw updateError;
      if (!quotedState) throw new Error("WORKING_ORDER_CONFLICT");
      return ok({ quote: data, quote_token: quoteToken, working_order_revision: state.revision, items: state.items });
    }

    if (op === "order/create") {
      const input = z.object({
        customer_confirmed: z.literal(true),
        quote_token: z.string().regex(/^[a-f0-9]{64}$/i),
        idempotency_key: z.string().trim().min(8).max(200).optional(),
      }).parse(c.args);
      const state = await getState(c, false);
      if (!state || !state.quote_payload || !state.quote_token || state.quoted_revision !== state.revision) {
        return fail("ORDER_NOT_READY", "The working order changed or has not been successfully quoted. Calculate the order again before creating it.", 409);
      }
      if (!safeEqual(input.quote_token, state.quote_token)) return fail("QUOTE_MISMATCH", "The quote token does not match the validated working order.", 409);
      if (state.status === "created" && state.created_order_id) return ok({ order_id: state.created_order_id, already_created: true });
      if (state.status !== "quoted" && state.status !== "creating") return fail("ORDER_NOT_READY", "The working order is not in a quoted state.", 409);

      if (state.status === "quoted") {
        const { data: claimed, error: claimError } = await workingOrders(c)
          .update({ status: "creating", updated_at: new Date().toISOString() })
          .eq("id", state.id)
          .eq("revision", state.revision)
          .eq("quoted_revision", state.revision)
          .eq("quote_token", input.quote_token)
          .eq("status", "quoted")
          .select("id")
          .maybeSingle();
        if (claimError) throw claimError;
        if (!claimed) return fail("ORDER_NOT_READY", "The working order changed before it could be created. Calculate the order again.", 409);
      }

      const quotePayload = state.quote_payload;
      const items = toRpcItems(state.items);
      const requestHash = hash({ ...quotePayload, items });
      const idempotencyKey = input.idempotency_key ?? hash(`${c.callId}:order.create:${requestHash}`).slice(0, 48);
      const { data, error } = await c.supabase.rpc("create_ai_order_idempotent", {
        p_agent_id: c.agentId,
        p_restaurant_id: c.restaurantId,
        p_location_id: c.locationId,
        p_idempotency_key: idempotencyKey,
        p_request_hash: requestHash,
        p_customer_name: quotePayload.customer_name,
        p_customer_phone: quotePayload.customer_phone,
        p_fulfillment_type: quotePayload.fulfillment_type,
        p_notes: quotePayload.notes ?? null,
        p_scheduled_for: quotePayload.scheduled_for ?? null,
        p_delivery_address_line1: quotePayload.delivery_address_line1 ?? null,
        p_delivery_address_line2: quotePayload.delivery_address_line2 ?? null,
        p_delivery_city: quotePayload.delivery_city ?? null,
        p_delivery_province: quotePayload.delivery_province ?? null,
        p_delivery_postal_code: quotePayload.delivery_postal_code ?? null,
        p_delivery_instructions: quotePayload.delivery_instructions ?? null,
        p_table_number: quotePayload.table_number ?? null,
        p_items: items,
      });
      if (error) {
        await workingOrders(c).update({ status: "quoted", updated_at: new Date().toISOString() }).eq("id", state.id).eq("revision", state.revision).eq("status", "creating");
        throw error;
      }

      const order = data as any;
      const { error: finalizeError } = await workingOrders(c)
        .update({ status: "created", created_order_id: order?.id ?? null, updated_at: new Date().toISOString() })
        .eq("id", state.id)
        .eq("revision", state.revision)
        .eq("status", "creating");
      if (finalizeError) throw finalizeError;
      return ok({ order }, 201);
    }

    return fail("UNKNOWN_WORKING_ORDER_OPERATION", "That working-order operation is not available.", 404, false);
  } catch (error) {
    console.error(`Working order ${op}`, error);
    const raw = error instanceof Error ? error.message : String(error);
    if (raw.includes("WORKING_ORDER_EXPIRED")) return fail("ORDER_NOT_READY", "The working order expired. Start resolving the order again.", 409);
    if (raw.includes("WORKING_ORDER_CONFLICT")) return fail("ORDER_NOT_READY", "The working order changed concurrently. Retry the latest order action.", 409);
    if (raw.includes("LINE_ITEM_NOT_FOUND")) return fail("LINE_ITEM_NOT_FOUND", "That working-order line item could not be found.", 404);
    if (raw.startsWith("MODIFIER_NOT_FOUND:")) return fail("MODIFIER_NOT_FOUND", "That modifier is not available for this item.", 409);
    if (raw.startsWith("MODIFIER_AMBIGUOUS:")) return fail("MODIFIER_AMBIGUOUS", "That modifier name is ambiguous for this item; specify whether it is an add or removal.", 409);
    return fail("REQUEST_REJECTED", "The restaurant could not complete that order-state request. Please retry or escalate to staff.", 400, true);
  }
}
