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
  replaceLineItem,
  toRpcItems,
  updateLine,
  type ResolvedModifierChange,
  type SelectionSide,
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
type ResolvedItem = { item: any; size: any | null };

const ZERO = "00000000-0000-0000-0000-000000000000";
const ok = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status });
const fail = (error_code: string, message: string, status = 400, recoverable = true) =>
  NextResponse.json({ success: false, error_code, message, recoverable }, { status });
const normalize = (value: string) => value.trim().toLowerCase();
const stable = (value: any): string => value === null || typeof value !== "object"
  ? JSON.stringify(value)
  : Array.isArray(value)
    ? `[${value.map(stable).join(",")}]`
    : `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(",")}}`;
const hash = (value: any) => createHash("sha256").update(stable(value)).digest("hex");
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const quoteTokenFor = (payload: any) => {
  const secret = process.env.RETELL_API_KEY;
  if (!secret) throw new Error("AI_CONFIGURATION_ERROR");
  return createHmac("sha256", secret).update(hash(payload)).digest("hex");
};

function verifySignature(raw: string, signature: string | null) {
  const secret = process.env.RETELL_API_KEY;
  if (!secret || !signature) return false;
  const match = /^v=(\d+),d=([a-f0-9]+)$/i.exec(signature.trim());
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) return false;
  const expected = createHmac("sha256", secret).update(raw + match[1]).digest("hex");
  return safeEqual(expected, match[2].toLowerCase());
}

function normalizePhone(phone: string) {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 10) return `1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return digits;
  return "";
}

function workingOrders(c: Context) {
  return (c.supabase as any).from("ai_working_orders");
}

async function authorize(request: Request): Promise<Context | NextResponse> {
  const raw = await request.text();
  if (!verifySignature(raw, request.headers.get("X-Retell-Signature"))) {
    return fail("UNAUTHORIZED", "This request is not an authenticated Retell request.", 401, false);
  }
  let payload: Json;
  try { payload = JSON.parse(raw); } catch { return fail("INVALID_JSON", "The AI request body is not valid JSON.", 400, false); }
  const args = payload.args && typeof payload.args === "object" ? payload.args : payload;
  const retellAgentId = payload?.call?.agent_id ?? payload.agent_id ?? args.agent_id;
  const callId = payload?.call?.call_id ?? payload.call_id ?? args.call_id;
  if (typeof retellAgentId !== "string") return fail("AGENT_REQUIRED", "The authenticated AI request did not identify an agent.", 400, false);
  if (typeof callId !== "string" || !callId.trim()) return fail("CALL_ID_REQUIRED", "A Retell call_id is required for order state.", 400, false);

  const supabase = createServerSupabase();
  const { data: agent, error } = await supabase.from("ai_agents")
    .select("id,restaurant_id,location_id,status")
    .eq("retell_agent_id", retellAgentId).neq("status", "disabled").limit(1).maybeSingle();
  if (error || !agent) return fail("AGENT_NOT_AUTHORIZED", "This AI agent is not authorized.", 403, false);
  let locationId = agent.location_id as string | null;
  if (!locationId) {
    const { data: location } = await supabase.from("restaurant_locations").select("id")
      .eq("restaurant_id", agent.restaurant_id).eq("is_active", true).limit(1).maybeSingle();
    locationId = location?.id ?? null;
  }
  if (!locationId) return fail("LOCATION_NOT_CONFIGURED", "No active restaurant location is configured for this AI agent.", 409, false);
  return { supabase, agentId: agent.id, restaurantId: agent.restaurant_id, locationId, callId, args };
}

async function findState(c: Context): Promise<WorkingOrderState | null> {
  const { data, error } = await workingOrders(c).select("*")
    .eq("restaurant_id", c.restaurantId).eq("location_id", c.locationId).eq("call_id", c.callId)
    .limit(1).maybeSingle();
  if (error) throw error;
  const state = (data ?? null) as WorkingOrderState | null;
  if (!state) return null;
  if (state.agent_id !== c.agentId) throw new Error("AGENT_SCOPE_MISMATCH");
  if (new Date(state.expires_at).getTime() < Date.now()) throw new Error("WORKING_ORDER_EXPIRED");
  return state;
}

async function getState(c: Context, create = true): Promise<WorkingOrderState | null> {
  const current = await findState(c);
  if (current || !create) return current;
  const { data, error } = await workingOrders(c)
    .insert({ call_id: c.callId, agent_id: c.agentId, restaurant_id: c.restaurantId, location_id: c.locationId })
    .select("*").single();
  if (!error && data) return data as WorkingOrderState;
  if (error?.code === "23505") return await findState(c);
  throw error ?? new Error("WORKING_ORDER_CREATE_FAILED");
}

async function save(c: Context, state: WorkingOrderState, items: WorkingLine[]) {
  const next = invalidateQuote(state);
  const { data, error } = await workingOrders(c).update({
    items,
    revision: next.revision,
    quoted_revision: null,
    quote_token: null,
    quote_payload: null,
    quote_result: null,
    status: "building",
    updated_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  }).eq("id", state.id).eq("agent_id", c.agentId).eq("revision", state.revision)
    .in("status", ["building", "quoted"]).select("*").maybeSingle();
  if (error) throw error;
  if (!data) throw new Error("WORKING_ORDER_CONFLICT");
  return data as WorkingOrderState;
}

async function restaurantCategoryIds(c: Context) {
  const { data, error } = await c.supabase.from("menu_categories").select("id")
    .eq("restaurant_id", c.restaurantId).eq("is_active", true);
  if (error) throw error;
  return (data ?? []).map((row) => row.id);
}

async function resolveItem(c: Context, itemName: string, sizeName?: string): Promise<ResolvedItem> {
  const categoryIds = await restaurantCategoryIds(c);
  const { data: items, error } = await c.supabase.from("menu_items")
    .select("id,name,is_available,category_id,item_type")
    .in("category_id", categoryIds.length ? categoryIds : [ZERO])
    .ilike("name", itemName.trim()).limit(5);
  if (error) throw error;
  const exact = (items ?? []).filter((item) => normalize(item.name) === normalize(itemName));
  const available = exact.filter((item) => item.is_available);
  if (!available.length) throw new Error(exact.length ? "ITEM_UNAVAILABLE" : "ITEM_NOT_FOUND");
  if (available.length !== 1) throw new Error("ITEM_AMBIGUOUS");
  const item = available[0];
  const { data: sizes, error: sizeError } = await c.supabase.from("menu_item_sizes")
    .select("id,name,is_available").eq("menu_item_id", item.id).order("display_order");
  if (sizeError) throw sizeError;
  const availableSizes = (sizes ?? []).filter((size) => size.is_available);
  let size: any = null;
  if (sizeName) {
    const matches = availableSizes.filter((candidate) => normalize(candidate.name) === normalize(sizeName));
    if (matches.length !== 1) throw new Error("INVALID_SIZE");
    size = matches[0];
  } else if (availableSizes.length === 1) {
    size = availableSizes[0];
  } else if (availableSizes.length > 1) {
    throw new Error("SIZE_REQUIRED");
  }
  return { item, size };
}

async function loadGroupRules(c: Context, itemId: string): Promise<WorkingRequirement[]> {
  const { data: links, error } = await c.supabase.from("menu_item_modifier_groups")
    .select("modifier_group_id,min_selections,max_selections,required").eq("menu_item_id", itemId);
  if (error) throw error;
  if (!(links ?? []).length) return [];
  const groupIds = (links ?? []).map((link) => link.modifier_group_id);
  const { data: groups, error: groupError } = await c.supabase.from("modifier_groups")
    .select("id,name,selection_type,min_selections,max_selections,is_active")
    .eq("restaurant_id", c.restaurantId).in("id", groupIds);
  if (groupError) throw groupError;
  return (links ?? []).map((link) => {
    const group = (groups ?? []).find((candidate) => candidate.id === link.modifier_group_id);
    if (!group?.is_active) throw new Error("INVALID_MODIFIER_GROUP");
    return {
      modifier_group_id: link.modifier_group_id,
      group_name: group.name,
      selection_type: group.selection_type === "single" ? "single" : "multiple",
      min_selections: Math.max(0, Number(link.min_selections ?? group.min_selections ?? (link.required ? 1 : 0))),
      max_selections: link.max_selections == null
        ? (group.max_selections == null ? null : Number(group.max_selections))
        : Number(link.max_selections),
    } as WorkingRequirement;
  });
}

const modifierChangeSchema = z.object({
  modifier_name: z.string().trim().min(1).max(120),
  operation: z.enum(["add", "remove"]).default("add"),
  action: z.enum(["add", "remove"]).optional(),
  replaces_modifier_name: z.string().trim().min(1).max(120).optional(),
  quantity: z.coerce.number().int().min(1).max(99).optional(),
  side: z.enum(["whole", "left", "right"]).optional(),
  quantity_level_id: z.string().uuid().optional(),
  notes: z.string().max(500).optional(),
});
type ModifierChangeInput = z.infer<typeof modifierChangeSchema>;

async function resolveModifierChanges(c: Context, itemId: string, changes?: ModifierChangeInput[]): Promise<ResolvedModifierChange[]> {
  if (!changes?.length) return [];
  const rules = await loadGroupRules(c, itemId);
  const groupIds = rules.map((rule) => rule.modifier_group_id);
  const { data: modifiers, error } = await c.supabase.from("modifiers")
    .select("id,name,modifier_group_id,is_available,action,target_ingredient_id,replacement_ingredient_id,max_quantity")
    .in("modifier_group_id", groupIds.length ? groupIds : [ZERO]);
  if (error) throw error;

  const resolved: ResolvedModifierChange[] = [];
  for (const change of changes) {
    if (change.operation === "remove") {
      const existingMatches = (modifiers ?? []).filter((modifier) => normalize(modifier.name) === normalize(change.modifier_name));
      const groupId = existingMatches.length === 1 ? existingMatches[0].modifier_group_id : undefined;
      resolved.push({ operation: "remove", modifier_name: change.modifier_name, modifier_group_id: groupId });
      continue;
    }
    const matches = (modifiers ?? []).filter((modifier) =>
      normalize(modifier.name) === normalize(change.modifier_name)
      && modifier.is_available
      && (!change.action || modifier.action === change.action),
    );
    if (!matches.length) throw new Error("INVALID_MODIFIER");
    if (matches.length > 1) throw new Error("MODIFIER_AMBIGUOUS");
    const modifier = matches[0];
    const quantity = change.quantity ?? 1;
    if (modifier.max_quantity != null && quantity > Number(modifier.max_quantity)) throw new Error("INVALID_MODIFIER_QUANTITY");

    let substitutionTarget: any = null;
    if (change.replaces_modifier_name) {
      const targetMatches = (modifiers ?? []).filter((candidate) =>
        candidate.modifier_group_id === modifier.modifier_group_id
        && normalize(candidate.name) === normalize(change.replaces_modifier_name!),
      );
      if (targetMatches.length !== 1) throw new Error("INVALID_SUBSTITUTION");
      substitutionTarget = targetMatches[0];
    }
    const selection: WorkingSelection = {
      modifier_id: modifier.id,
      modifier_name: modifier.name,
      modifier_group_id: modifier.modifier_group_id,
      action: modifier.action === "remove" ? "remove" : "add",
      quantity,
      side: (change.side ?? "whole") as SelectionSide,
      quantity_level_id: change.quantity_level_id,
      notes: change.notes,
      target_ingredient_id: modifier.target_ingredient_id ?? undefined,
      replacement_ingredient_id: modifier.replacement_ingredient_id ?? undefined,
      substitutes_for_modifier_id: substitutionTarget?.id,
      substitutes_for_name: substitutionTarget?.name,
    };
    resolved.push({ operation: "add", selection });
  }
  return resolved;
}

async function validateWorkingOrder(c: Context, state: WorkingOrderState) {
  const categoryIds = new Set(await restaurantCategoryIds(c));
  for (const line of state.items) {
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 99) throw new Error("INVALID_QUANTITY");
    const { data: item } = await c.supabase.from("menu_items").select("id,category_id,is_available")
      .eq("id", line.menu_item_id).maybeSingle();
    if (!item || !categoryIds.has(item.category_id)) throw new Error("INVALID_ITEM_RELATIONSHIP");
    if (!item.is_available) throw new Error("ITEM_UNAVAILABLE");
    if (line.size_id) {
      const { data: size } = await c.supabase.from("menu_item_sizes").select("id,is_available")
        .eq("id", line.size_id).eq("menu_item_id", line.menu_item_id).maybeSingle();
      if (!size) throw new Error("INVALID_SIZE");
      if (!size.is_available) throw new Error("SIZE_UNAVAILABLE");
    }
    const rules = await loadGroupRules(c, line.menu_item_id);
    const allowedGroups = new Set(rules.map((rule) => rule.modifier_group_id));
    for (const selection of line.selections) {
      if (!allowedGroups.has(selection.modifier_group_id)) throw new Error("INVALID_MODIFIER");
      const { data: modifier } = await c.supabase.from("modifiers")
        .select("id,modifier_group_id,is_available,action,target_ingredient_id,replacement_ingredient_id,max_quantity")
        .eq("id", selection.modifier_id).eq("modifier_group_id", selection.modifier_group_id).maybeSingle();
      if (!modifier) throw new Error("INVALID_MODIFIER");
      if (!modifier.is_available) throw new Error("MODIFIER_UNAVAILABLE");
      if ((modifier.action === "remove" ? "remove" : "add") !== selection.action) throw new Error("INVALID_MODIFIER_ACTION");
      if ((modifier.target_ingredient_id ?? null) !== (selection.target_ingredient_id ?? null)) throw new Error("INVALID_MODIFIER_RELATIONSHIP");
      if ((modifier.replacement_ingredient_id ?? null) !== (selection.replacement_ingredient_id ?? null)) throw new Error("INVALID_MODIFIER_RELATIONSHIP");
      const quantity = selection.quantity ?? 1;
      if (modifier.max_quantity != null && quantity > Number(modifier.max_quantity)) throw new Error("INVALID_MODIFIER_QUANTITY");
      if (selection.substitutes_for_modifier_id) {
        const { data: target } = await c.supabase.from("modifiers").select("id,modifier_group_id")
          .eq("id", selection.substitutes_for_modifier_id).eq("modifier_group_id", selection.modifier_group_id).maybeSingle();
        if (!target) throw new Error("INVALID_SUBSTITUTION");
      }
    }
    // Re-evaluate current group rules so stale menu configuration cannot be bypassed.
    const currentLine = { ...line, requirements: rules };
    if (!orderReadiness([currentLine]).ready) throw new Error("REQUIRED_MODIFIER_MISSING");
  }
}

const addSchema = z.object({
  item_name: z.string().trim().min(1).max(120),
  size_name: z.string().trim().min(1).max(100).optional(),
  quantity: z.coerce.number().int().min(1).max(99).default(1),
  modifier_changes: z.array(modifierChangeSchema).max(50).optional(),
  special_instructions: z.string().max(500).optional(),
  expected_revision: z.coerce.number().int().min(0).optional(),
});
const updateSchema = z.object({
  line_id: z.string().min(4),
  replace_item_name: z.string().trim().min(1).max(120).optional(),
  quantity: z.coerce.number().int().min(1).max(99).optional(),
  size_name: z.string().trim().min(1).max(100).optional(),
  modifier_changes: z.array(modifierChangeSchema).max(50).optional(),
  special_instructions: z.string().max(500).optional(),
  expected_revision: z.coerce.number().int().min(0).optional(),
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
  expected_revision: z.coerce.number().int().min(0).optional(),
}).passthrough();

function ensureExpectedRevision(state: WorkingOrderState, expected?: number) {
  if (expected !== undefined && expected !== state.revision) throw new Error("STALE_REVISION");
}

export async function handleWorkingOrderRequestV2(request: Request, operation: string[]) {
  const authorized = await authorize(request);
  if (authorized instanceof NextResponse) return authorized;
  const c = authorized;
  const op = operation.join("/");
  try {
    if (op === "order/state") {
      const state = await getState(c, false);
      return ok({ working_order: state ? {
        call_id: state.call_id, revision: state.revision, status: state.status,
        items: state.items, quoted_revision: state.quoted_revision, readiness: orderReadiness(state.items),
      } : null });
    }

    if (op === "order/item/add") {
      const input = addSchema.parse(c.args);
      const state = await getState(c, true);
      if (!state) throw new Error("WORKING_ORDER_CREATE_FAILED");
      ensureExpectedRevision(state, input.expected_revision);
      if (state.status === "creating") return fail("ORDER_CREATE_IN_PROGRESS", "This order is already being created.", 409);
      if (state.status === "created") return fail("ORDER_ALREADY_CREATED", "This call already created an order.", 409, false);
      const resolved = await resolveItem(c, input.item_name, input.size_name);
      const rules = await loadGroupRules(c, resolved.item.id);
      const changes = await resolveModifierChanges(c, resolved.item.id, input.modifier_changes);
      const line: WorkingLine = {
        line_id: `li_${randomUUID()}`,
        menu_item_id: resolved.item.id,
        item_name: resolved.item.name,
        size_id: resolved.size?.id,
        size_name: resolved.size?.name,
        quantity: input.quantity,
        special_instructions: input.special_instructions,
        selections: applyModifierChanges([], changes, rules),
        requirements: rules,
      };
      const saved = await save(c, state, appendLine(state.items, line));
      return ok({ revision: saved.revision, added_line_id: line.line_id, items: saved.items, readiness: orderReadiness(saved.items) });
    }

    if (op === "order/item/update") {
      const input = updateSchema.parse(c.args);
      const state = await getState(c, false);
      if (!state) return fail("ORDER_NOT_READY", "There is no working order for this call.", 409);
      ensureExpectedRevision(state, input.expected_revision);
      if (state.status === "creating") return fail("ORDER_CREATE_IN_PROGRESS", "This order is already being created.", 409);
      if (state.status === "created") return fail("ORDER_ALREADY_CREATED", "This call already created an order.", 409, false);
      const current = state.items.find((line) => line.line_id === input.line_id);
      if (!current) return fail("LINE_ITEM_NOT_FOUND", "That working-order line item could not be found.", 404);

      let items: WorkingLine[];
      if (input.replace_item_name) {
        const preferredSize = input.size_name ?? current.size_name;
        let resolved: ResolvedItem;
        try { resolved = await resolveItem(c, input.replace_item_name, preferredSize); }
        catch (error) {
          if (preferredSize && !input.size_name && error instanceof Error && error.message === "INVALID_SIZE") {
            resolved = await resolveItem(c, input.replace_item_name);
          } else throw error;
        }
        const rules = await loadGroupRules(c, resolved.item.id);
        const changes = await resolveModifierChanges(c, resolved.item.id, input.modifier_changes);
        items = replaceLineItem(state.items, input.line_id, {
          menu_item_id: resolved.item.id,
          item_name: resolved.item.name,
          size_id: resolved.size?.id,
          size_name: resolved.size?.name,
          quantity: input.quantity ?? current.quantity,
          special_instructions: input.special_instructions ?? current.special_instructions,
          selections: applyModifierChanges([], changes, rules),
          requirements: rules,
        });
      } else {
        let sizeId = current.size_id;
        let sizeName = current.size_name;
        if (input.size_name !== undefined) {
          const resolved = await resolveItem(c, current.item_name, input.size_name);
          sizeId = resolved.size?.id;
          sizeName = resolved.size?.name;
        }
        const changes = await resolveModifierChanges(c, current.menu_item_id, input.modifier_changes);
        items = updateLine(state.items, input.line_id, {
          quantity: input.quantity,
          size_id: sizeId,
          size_name: sizeName,
          special_instructions: input.special_instructions,
          modifier_changes: changes.length ? changes : undefined,
        });
      }
      const saved = await save(c, state, items);
      return ok({ revision: saved.revision, updated_line_id: input.line_id, items: saved.items, readiness: orderReadiness(saved.items) });
    }

    if (op === "order/item/remove") {
      const input = z.object({ line_id: z.string().min(4), expected_revision: z.coerce.number().int().min(0).optional() }).parse(c.args);
      const state = await getState(c, false);
      if (!state) return fail("ORDER_NOT_READY", "There is no working order for this call.", 409);
      ensureExpectedRevision(state, input.expected_revision);
      if (state.status === "creating") return fail("ORDER_CREATE_IN_PROGRESS", "This order is already being created.", 409);
      if (state.status === "created") return fail("ORDER_ALREADY_CREATED", "This call already created an order.", 409, false);
      const saved = await save(c, state, removeLine(state.items, input.line_id));
      return ok({ revision: saved.revision, removed_line_id: input.line_id, items: saved.items, readiness: orderReadiness(saved.items) });
    }

    if (op === "order/quote") {
      const input = quoteSchema.parse(c.args);
      const state = await getState(c, false);
      if (!state) return fail("ORDER_NOT_READY", "There is no working order for this call.", 409);
      ensureExpectedRevision(state, input.expected_revision);
      if (state.status === "creating") return fail("ORDER_CREATE_IN_PROGRESS", "This order is already being created.", 409);
      if (state.status === "created") return fail("ORDER_ALREADY_CREATED", "This call already created an order.", 409, false);
      const readiness = orderReadiness(state.items);
      if (!readiness.ready) return fail("ORDER_NOT_READY", "The working order still has unresolved required selections.", 409);
      await validateWorkingOrder(c, state);
      const phone = normalizePhone(input.customer_phone);
      if (!phone) return fail("INVALID_PHONE", "A valid 10-digit North American phone number is required.", 409);
      const rpcItems = toRpcItems(state.items);
      const quoteInput = {
        customer_name: input.customer_name, customer_phone: phone, customer_email: input.customer_email,
        fulfillment_type: input.fulfillment_type, notes: input.notes, scheduled_for: input.scheduled_for,
        delivery_address_line1: input.delivery_address_line1, delivery_address_line2: input.delivery_address_line2,
        delivery_city: input.delivery_city, delivery_province: input.delivery_province,
        delivery_postal_code: input.delivery_postal_code, delivery_instructions: input.delivery_instructions,
        table_number: input.table_number,
      };
      const payload = { ...quoteInput, items: rpcItems, working_order_revision: state.revision };
      const { data, error } = await c.supabase.rpc("quote_complex_order_atomic", {
        p_restaurant_id: c.restaurantId, p_location_id: c.locationId,
        p_customer_name: quoteInput.customer_name, p_customer_phone: phone,
        p_fulfillment_type: quoteInput.fulfillment_type, p_notes: quoteInput.notes ?? null,
        p_scheduled_for: quoteInput.scheduled_for ?? null,
        p_delivery_address_line1: quoteInput.delivery_address_line1 ?? null,
        p_delivery_address_line2: quoteInput.delivery_address_line2 ?? null,
        p_delivery_city: quoteInput.delivery_city ?? null, p_delivery_province: quoteInput.delivery_province ?? null,
        p_delivery_postal_code: quoteInput.delivery_postal_code ?? null,
        p_delivery_instructions: quoteInput.delivery_instructions ?? null, p_table_number: quoteInput.table_number ?? null,
        p_items: rpcItems,
      });
      if (error) throw error;
      const token = quoteTokenFor(payload);
      const { data: claimed, error: claimError } = await workingOrders(c).update({
        quoted_revision: state.revision, quote_token: token, quote_payload: payload,
        quote_result: data, status: "quoted", updated_at: new Date().toISOString(),
      }).eq("id", state.id).eq("agent_id", c.agentId).eq("revision", state.revision)
        .in("status", ["building", "quoted"]).select("id").maybeSingle();
      if (claimError) throw claimError;
      if (!claimed) throw new Error("WORKING_ORDER_CONFLICT");
      return ok({ quote: data, quote_token: token, working_order_revision: state.revision, items: state.items });
    }

    if (op === "order/create") {
      const input = z.object({
        customer_confirmed: z.literal(true),
        quote_token: z.string().regex(/^[a-f0-9]{64}$/i),
        idempotency_key: z.string().trim().min(8).max(200).optional(),
        expected_revision: z.coerce.number().int().min(0).optional(),
      }).passthrough().parse(c.args);
      const state = await getState(c, false);
      if (!state) return fail("ORDER_NOT_READY", "There is no quoted working order for this call.", 409);
      ensureExpectedRevision(state, input.expected_revision);
      if (state.status === "created" && state.created_order_id) return ok({ order_id: state.created_order_id, already_created: true });
      if (state.status === "creating") return fail("ORDER_CREATE_IN_PROGRESS", "This order is already being created. Retry shortly; do not submit another order.", 409);
      if (!state.quote_payload || !state.quote_token || state.quoted_revision !== state.revision || state.status !== "quoted") {
        return fail("ORDER_NOT_READY", "The working order changed or has not been quoted. Calculate the order again.", 409);
      }
      if (!safeEqual(input.quote_token, state.quote_token)) return fail("QUOTE_MISMATCH", "The quote token does not match the current working order.", 409);

      const { data: claim, error: claimError } = await workingOrders(c).update({ status: "creating", updated_at: new Date().toISOString() })
        .eq("id", state.id).eq("agent_id", c.agentId).eq("revision", state.revision)
        .eq("quoted_revision", state.revision).eq("quote_token", input.quote_token).eq("status", "quoted")
        .select("id").maybeSingle();
      if (claimError) throw claimError;
      if (!claim) return fail("ORDER_CREATE_IN_PROGRESS", "Another request changed or claimed this order. Retry current state; do not duplicate it.", 409);

      const quotePayload = state.quote_payload;
      const items = toRpcItems(state.items);
      const requestHash = hash({ ...quotePayload, items });
      const idempotencyKey = input.idempotency_key ?? hash(`${c.restaurantId}:${c.locationId}:${c.callId}:order.create:${requestHash}`).slice(0, 48);
      const { data, error } = await c.supabase.rpc("create_ai_order_idempotent", {
        p_agent_id: c.agentId, p_restaurant_id: c.restaurantId, p_location_id: c.locationId,
        p_idempotency_key: idempotencyKey, p_request_hash: requestHash,
        p_customer_name: quotePayload.customer_name, p_customer_phone: quotePayload.customer_phone,
        p_fulfillment_type: quotePayload.fulfillment_type, p_notes: quotePayload.notes ?? null,
        p_scheduled_for: quotePayload.scheduled_for ?? null,
        p_delivery_address_line1: quotePayload.delivery_address_line1 ?? null,
        p_delivery_address_line2: quotePayload.delivery_address_line2 ?? null,
        p_delivery_city: quotePayload.delivery_city ?? null, p_delivery_province: quotePayload.delivery_province ?? null,
        p_delivery_postal_code: quotePayload.delivery_postal_code ?? null,
        p_delivery_instructions: quotePayload.delivery_instructions ?? null, p_table_number: quotePayload.table_number ?? null,
        p_items: items,
      });
      if (error) {
        await workingOrders(c).update({ status: "quoted", updated_at: new Date().toISOString() })
          .eq("id", state.id).eq("agent_id", c.agentId).eq("revision", state.revision).eq("status", "creating");
        throw error;
      }
      const order = data as any;
      const { data: finalized, error: finalizeError } = await workingOrders(c)
        .update({ status: "created", created_order_id: order?.id ?? null, updated_at: new Date().toISOString() })
        .eq("id", state.id).eq("agent_id", c.agentId).eq("revision", state.revision).eq("status", "creating")
        .select("id").maybeSingle();
      if (finalizeError) throw finalizeError;
      if (!finalized) throw new Error("WORKING_ORDER_CONFLICT");
      return ok({ order }, 201);
    }

    return fail("UNKNOWN_WORKING_ORDER_OPERATION", "That working-order operation is not available.", 404, false);
  } catch (error) {
    const raw = error instanceof Error ? error.message : "UNKNOWN";
    // Never log payloads, caller PII, authorization headers or secrets.
    console.error(`[WORKING_ORDER_ERROR] operation=${op} code=${raw.split(":", 1)[0]}`);
    if (raw.includes("WORKING_ORDER_EXPIRED")) return fail("ORDER_NOT_READY", "The working order expired. Start the order again.", 409);
    if (raw.includes("AGENT_SCOPE_MISMATCH")) return fail("AGENT_SCOPE_MISMATCH", "This call state belongs to a different authorized agent.", 403, false);
    if (raw.includes("STALE_REVISION")) return fail("STALE_REVISION", "The working order changed. Reload current state before retrying.", 409);
    if (raw.includes("WORKING_ORDER_CONFLICT")) return fail("WORKING_ORDER_CONFLICT", "The working order changed concurrently. Retry from current state.", 409);
    if (raw.includes("LINE_ITEM_NOT_FOUND")) return fail("LINE_ITEM_NOT_FOUND", "That working-order line item could not be found.", 404);
    if (raw.includes("ITEM_NOT_FOUND")) return fail("ITEM_NOT_FOUND", "I could not find that menu item.", 404);
    if (raw.includes("ITEM_UNAVAILABLE")) return fail("ITEM_UNAVAILABLE", "That item is unavailable right now.", 409);
    if (raw.includes("ITEM_AMBIGUOUS")) return fail("NEEDS_CLARIFICATION", "More than one menu item matches. Ask the customer to clarify.", 409);
    if (raw.includes("SIZE_REQUIRED")) return fail("SIZE_REQUIRED", "This item has multiple sizes. Ask which size they want.", 409);
    if (raw.includes("INVALID_SIZE")) return fail("INVALID_SIZE", "That size does not belong to this item or is not available.", 409);
    if (raw.includes("SIZE_UNAVAILABLE")) return fail("SIZE_UNAVAILABLE", "That size is unavailable right now.", 409);
    if (raw.includes("INVALID_SUBSTITUTION")) return fail("INVALID_SUBSTITUTION", "That substitution is not valid for this item.", 409);
    if (raw.includes("INVALID_MODIFIER_QUANTITY")) return fail("INVALID_MODIFIER_QUANTITY", "That modifier quantity is not allowed.", 409);
    if (raw.includes("MODIFIER_SELECTION_LIMIT")) return fail("INVALID_MODIFIER", "That modifier group has too many selections.", 409);
    if (raw.includes("MODIFIER_UNAVAILABLE")) return fail("MODIFIER_UNAVAILABLE", "That modifier is unavailable right now.", 409);
    if (raw.includes("INVALID_MODIFIER") || raw.includes("MODIFIER_AMBIGUOUS")) return fail("INVALID_MODIFIER", "That modifier is not valid for this item.", 409);
    if (raw.includes("REQUIRED_MODIFIER_MISSING")) return fail("ORDER_NOT_READY", "A required menu selection is still missing.", 409);
    if (raw.includes("INVALID_ITEM_RELATIONSHIP") || raw.includes("INVALID_QUANTITY")) return fail("ORDER_NOT_READY", "The stored order contains an invalid item relationship and must be corrected.", 409);
    if (raw.includes("AI_CONFIGURATION_ERROR")) return fail("AI_CONFIGURATION_ERROR", "Order confirmation is not configured.", 500, false);
    return fail("REQUEST_REJECTED", "The restaurant could not complete that order action. Retry or escalate to staff.", 400);
  }
}
