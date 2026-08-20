import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

type Json = Record<string, any>;
const fail = (error_code: string, message: string, status = 409, recoverable = true) => NextResponse.json({ success: false, error_code, message, recoverable }, { status });
const safeEqual = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

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

function localParts(iso: string | undefined, timezone: string) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")), time: `${get("hour")}:${get("minute")}` };
}

async function sizeSpecificReadiness(supabase: ReturnType<typeof createServerSupabase>, state: any) {
  for (const line of state?.items ?? []) {
    if (!line.size_id) continue;
    const { data: rules, error } = await (supabase as any).from("menu_item_modifier_group_size_rules")
      .select("modifier_group_id,min_selections,max_selections,required")
      .eq("menu_item_id", line.menu_item_id).eq("menu_item_size_id", line.size_id);
    if (error) throw error;
    for (const rule of rules ?? []) {
      const count = (line.selections ?? []).filter((selection: any) => selection.modifier_group_id === rule.modifier_group_id && selection.action === "add").length;
      const minimum = Math.max(0, Number(rule.min_selections ?? (rule.required ? 1 : 0)));
      const maximum = rule.max_selections == null ? null : Number(rule.max_selections);
      if (count < minimum || (maximum !== null && count > maximum)) return false;
    }
  }
  return true;
}

export async function validateOrderQuoteContext(request: Request): Promise<NextResponse | null> {
  const raw = await request.text();
  if (!verify(raw, request.headers.get("X-Retell-Signature"))) return fail("UNAUTHORIZED", "This request is not an authenticated Retell request.", 401, false);
  let payload: Json;
  try { payload = JSON.parse(raw); } catch { return fail("INVALID_JSON", "The AI request body is not valid JSON.", 400, false); }
  const args = payload.args && typeof payload.args === "object" ? payload.args : payload;
  const input = z.object({ fulfillment_type: z.enum(["pickup", "delivery", "dine_in"]), scheduled_for: z.string().datetime().optional() }).passthrough().safeParse(args);
  if (!input.success) return fail("INVALID_ORDER_CONTEXT", "The fulfillment information is incomplete.", 400, true);
  const retellAgentId = payload?.call?.agent_id ?? payload.agent_id ?? args.agent_id;
  const callId = payload?.call?.call_id ?? payload.call_id ?? args.call_id;
  if (typeof retellAgentId !== "string") return fail("AGENT_REQUIRED", "The request did not identify an agent.", 400, false);
  if (typeof callId !== "string" || !callId.trim()) return fail("CALL_ID_REQUIRED", "A Retell call_id is required for order state.", 400, false);

  const supabase = createServerSupabase();
  const { data: agent } = await supabase.from("ai_agents").select("id,restaurant_id,location_id,status").eq("retell_agent_id", retellAgentId).neq("status", "disabled").limit(1).maybeSingle();
  if (!agent) return fail("AGENT_NOT_AUTHORIZED", "This AI agent is not authorized.", 403, false);
  let locationId = agent.location_id as string | null;
  if (!locationId) {
    const { data: location } = await supabase.from("restaurant_locations").select("id").eq("restaurant_id", agent.restaurant_id).eq("is_active", true).limit(1).maybeSingle();
    locationId = location?.id ?? null;
  }
  if (!locationId) return fail("LOCATION_NOT_CONFIGURED", "No active restaurant location is configured for this AI agent.", 409, false);

  const [{ data: restaurant }, { data: settings }, { data: hours }, { data: state, error: stateError }] = await Promise.all([
    supabase.from("restaurants").select("timezone").eq("id", agent.restaurant_id).single(),
    supabase.from("restaurant_settings").select("pickup_enabled,delivery_enabled,dine_in_enabled,scheduled_orders_enabled,delivery_radius_km").eq("restaurant_id", agent.restaurant_id).single(),
    supabase.from("restaurant_hours").select("day_of_week,opens_at,closes_at,is_closed").eq("location_id", locationId),
    (supabase as any).from("ai_working_orders").select("agent_id,items,revision,status").eq("restaurant_id", agent.restaurant_id).eq("location_id", locationId).eq("call_id", callId).limit(1).maybeSingle(),
  ]);
  if (!restaurant || !settings) return fail("RESTAURANT_NOT_CONFIGURED", "Restaurant order settings are not configured.", 500, false);
  if (stateError) return fail("ORDER_STATE_LOOKUP_FAILED", "The working order could not be validated.", 500, false);
  if (state && state.agent_id !== agent.id) return fail("AGENT_SCOPE_MISMATCH", "This call state belongs to a different authorized agent.", 403, false);

  if (input.data.fulfillment_type === "pickup" && !settings.pickup_enabled) return fail("FULFILLMENT_UNAVAILABLE", "Pickup is currently unavailable.");
  if (input.data.fulfillment_type === "dine_in" && !settings.dine_in_enabled) return fail("FULFILLMENT_UNAVAILABLE", "Dine-in ordering is currently unavailable.");
  if (input.data.fulfillment_type === "delivery") {
    if (!settings.delivery_enabled) return fail("FULFILLMENT_UNAVAILABLE", "Delivery is currently unavailable.");
    if (settings.delivery_radius_km == null || Number(settings.delivery_radius_km) <= 0) return fail("DELIVERY_NOT_CONFIGURED", "Delivery area validation is not configured.");
  }
  if (input.data.scheduled_for && !settings.scheduled_orders_enabled) return fail("SCHEDULED_ORDERS_UNAVAILABLE", "Scheduled ordering is currently unavailable.");
  if (input.data.scheduled_for && new Date(input.data.scheduled_for).getTime() <= Date.now()) return fail("INVALID_SCHEDULED_TIME", "The scheduled order time must be in the future.");

  const local = localParts(input.data.scheduled_for, restaurant.timezone ?? "America/Toronto");
  if (!local) return fail("INVALID_SCHEDULED_TIME", "The requested order time is invalid.");
  const open = (hours ?? []).some((window) => {
    if (window.day_of_week !== local.day || window.is_closed || !window.opens_at || !window.closes_at) return false;
    const starts = window.opens_at.slice(0, 5); const ends = window.closes_at.slice(0, 5);
    return starts <= ends ? local.time >= starts && local.time < ends : local.time >= starts || local.time < ends;
  });
  if (!open) return fail("RESTAURANT_CLOSED", "The restaurant is closed at the requested order time.");
  if (state && !(await sizeSpecificReadiness(supabase, state))) return fail("ORDER_NOT_READY", "A size-specific required menu selection is still missing.");
  return null;
}
