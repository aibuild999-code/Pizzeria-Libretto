import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

type Json = Record<string, any>;
const ZERO = "00000000-0000-0000-0000-000000000000";
const ok = (data: unknown, status = 200) => NextResponse.json({ success: true, data }, { status });
const fail = (error_code: string, message: string, status = 400, recoverable = true) => NextResponse.json({ success: false, error_code, message, recoverable }, { status });
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

function localTime(iso: string | undefined, timezone: string) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { day: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(get("weekday")), time: `${get("hour")}:${get("minute")}` };
}

export async function handleMenuAvailabilityV2(request: Request) {
  const raw = await request.text();
  if (!verify(raw, request.headers.get("X-Retell-Signature"))) return fail("UNAUTHORIZED", "This request is not an authenticated Retell request.", 401, false);
  let payload: Json;
  try { payload = JSON.parse(raw); } catch { return fail("INVALID_JSON", "The AI request body is not valid JSON.", 400, false); }
  const args = payload.args && typeof payload.args === "object" ? payload.args : payload;
  const retellAgentId = payload?.call?.agent_id ?? payload.agent_id ?? args.agent_id;
  if (typeof retellAgentId !== "string") return fail("AGENT_REQUIRED", "The authenticated AI request did not identify an agent.", 400, false);
  const input = z.object({ menu_item_id: z.string().uuid(), size_id: z.string().uuid().optional(), modifier_ids: z.array(z.string().uuid()).max(100).optional(), scheduled_for: z.string().datetime().optional() }).parse(args);
  const supabase = createServerSupabase();
  const { data: agent } = await supabase.from("ai_agents").select("id,restaurant_id,location_id,status").eq("retell_agent_id", retellAgentId).neq("status", "disabled").limit(1).maybeSingle();
  if (!agent) return fail("AGENT_NOT_AUTHORIZED", "This AI agent is not authorized.", 403, false);

  const { data: categories, error: categoryError } = await supabase.from("menu_categories").select("id").eq("restaurant_id", agent.restaurant_id).eq("is_active", true);
  if (categoryError) return fail("MENU_LOOKUP_FAILED", "Menu availability could not be checked.", 500);
  const categoryIds = (categories ?? []).map((category) => category.id);
  const { data: item, error: itemError } = await supabase.from("menu_items").select("id,name,is_available,category_id")
    .eq("id", input.menu_item_id).in("category_id", categoryIds.length ? categoryIds : [ZERO]).limit(1).maybeSingle();
  if (itemError || !item) return fail("ITEM_NOT_FOUND", "That menu item could not be found for this restaurant.", 404);
  if (!item.is_available) return ok({ available: false, reason: "item_unavailable", item: { id: item.id, name: item.name } });

  if (input.size_id) {
    const { data: size } = await supabase.from("menu_item_sizes").select("id,name,is_available").eq("id", input.size_id).eq("menu_item_id", item.id).limit(1).maybeSingle();
    if (!size) return fail("INVALID_SIZE", "That size does not belong to this item.", 409);
    if (!size.is_available) return ok({ available: false, reason: "size_unavailable", size });
  }

  if (input.modifier_ids?.length) {
    const { data: links } = await supabase.from("menu_item_modifier_groups").select("modifier_group_id").eq("menu_item_id", item.id);
    const allowedGroups = new Set((links ?? []).map((link) => link.modifier_group_id));
    const { data: modifiers } = await supabase.from("modifiers").select("id,name,is_available,modifier_group_id").in("id", input.modifier_ids);
    if ((modifiers ?? []).length !== input.modifier_ids.length) return fail("MODIFIER_NOT_FOUND", "One or more modifiers could not be found.", 404);
    if ((modifiers ?? []).some((modifier) => !allowedGroups.has(modifier.modifier_group_id))) return fail("INVALID_MODIFIER", "A modifier does not belong to this menu item.", 409);
    const unavailable = (modifiers ?? []).filter((modifier) => !modifier.is_available);
    if (unavailable.length) return ok({ available: false, reason: "modifier_unavailable", modifiers: unavailable.map((modifier) => ({ id: modifier.id, name: modifier.name })) });
  }

  if (input.scheduled_for) {
    const { data: restaurant } = await supabase.from("restaurants").select("timezone").eq("id", agent.restaurant_id).single();
    const local = localTime(input.scheduled_for, restaurant?.timezone ?? "America/Toronto");
    if (!local) return fail("INVALID_TIME", "That requested time is invalid.", 409);
    const { data: windows } = await supabase.from("menu_item_availability_windows").select("starts_at,ends_at").eq("menu_item_id", item.id).eq("day_of_week", local.day);
    if ((windows ?? []).length && !(windows ?? []).some((window) => local.time >= window.starts_at.slice(0, 5) && local.time < window.ends_at.slice(0, 5))) {
      return ok({ available: false, reason: "outside_item_availability_window" });
    }
  }
  return ok({ available: true, item: { id: item.id, name: item.name } });
}
