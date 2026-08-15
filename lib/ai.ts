import { createHmac, createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

type AiContext = { supabase: ReturnType<typeof createServerSupabase>; agentId: string; restaurantId: string; locationId: string };
type JsonObject = Record<string, any>;

const itemSchema = z.object({
  menu_item_id: z.string().uuid(), size_id: z.string().uuid().optional(), quantity: z.number().int().min(1).max(99),
  special_instructions: z.string().max(500).optional(),
  selections: z.array(z.object({ modifier_id: z.string().uuid(), quantity: z.number().int().min(1).max(99).optional(), side: z.enum(["whole","left","right"]).optional(), quantity_level_id: z.string().uuid().optional(), notes: z.string().max(500).optional() })).max(100).optional(),
});
const itemsSchema = z.array(itemSchema).min(1).max(50);

function response(data: unknown, status = 200) { return NextResponse.json({ success: true, data }, { status }); }
function fail(error_code: string, message: string, status = 400, recoverable = true) { return NextResponse.json({ success: false, error_code, message, recoverable }, { status }); }
function normalizePhone(phone: string) { const digits = phone.replace(/\D/g, ""); if (digits.length === 10) return `1${digits}`; if (digits.length === 11 && digits.startsWith("1")) return digits; return ""; }
function requirePhone(phone: string) { const normalized = normalizePhone(phone); if (!normalized) throw new Error("Invalid customer phone number"); return normalized; }
function stable(value: any): string { if (value === null || typeof value !== "object") return JSON.stringify(value); if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stable(value[k])}`).join(",")}}`; }
function hash(value: any) { return createHash("sha256").update(stable(value)).digest("hex"); }
function quoteToken(value: any) { const secret = process.env.RETELL_API_KEY; if (!secret) throw new Error("AI pricing confirmation is not configured"); return createHmac("sha256", secret).update(hash(value)).digest("hex"); }

function verifyRetellSignature(rawBody: string, signature: string | null) {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey || !signature) return false;
  const match = /^v=(\d+),d=([a-f0-9]+)$/i.exec(signature.trim());
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 5 * 60 * 1000) return false;
  const expected = createHmac("sha256", apiKey).update(rawBody + match[1]).digest("hex");
  const actual = match[2].toLowerCase();
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(actual));
}

function getArgs(payload: JsonObject): JsonObject { return (payload.args && typeof payload.args === "object") ? payload.args : payload; }
function agentIdFrom(payload: JsonObject, args: JsonObject) { return payload?.call?.agent_id ?? payload.agent_id ?? args.agent_id ?? null; }

async function authorize(request: Request): Promise<{ context?: AiContext; payload?: JsonObject; args?: JsonObject; error?: NextResponse }> {
  const rawBody = await request.text();
  if (!verifyRetellSignature(rawBody, request.headers.get("X-Retell-Signature"))) return { error: fail("UNAUTHORIZED", "This request is not an authenticated Retell request.", 401, false) };
  let payload: JsonObject;
  try { payload = JSON.parse(rawBody); } catch { return { error: fail("INVALID_JSON", "The AI request body is not valid JSON.", 400, false) }; }
  const args = getArgs(payload);
  const agentId = agentIdFrom(payload, args);
  if (!agentId || typeof agentId !== "string") return { error: fail("AGENT_REQUIRED", "The authenticated AI request did not identify an agent.", 400, false) };
  const supabase = createServerSupabase();
  const { data: agent, error } = await supabase.from("ai_agents").select("id,restaurant_id,location_id,status").eq("id", agentId).neq("status", "disabled").limit(1).maybeSingle();
  if (error) { console.error("AI agent lookup", error); return { error: fail("AUTH_LOOKUP_FAILED", "The AI agent could not be authorized.", 500, false) }; }
  if (!agent) return { error: fail("AGENT_NOT_AUTHORIZED", "This AI agent is not authorized.", 403, false) };
  let locationId = agent.location_id as string | null;
  if (!locationId) {
    const { data: location, error: locationError } = await supabase.from("restaurant_locations").select("id").eq("restaurant_id", agent.restaurant_id).eq("is_active", true).limit(1).single();
    if (locationError || !location) return { error: fail("LOCATION_NOT_CONFIGURED", "No active restaurant location is configured for this AI agent.", 409, false) };
    locationId = location.id;
  }
  return { context: { supabase, agentId: agent.id, restaurantId: agent.restaurant_id, locationId }, payload, args };
}

function userError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  const known: [string, string][] = [
    ["unavailable", "That selection is not available right now."], ["not found", "I could not find that item or record."], ["required", "A required selection is missing."],
    ["selection count", "The number of selections is outside the allowed range."], ["invalid or unavailable size", "That size is not available for this item."],
    ["invalid or unavailable modifier", "That modifier is not available for this item."], ["maximum online party size", "That party size is above the restaurant's online reservation limit."],
    ["does not belong", "I could not verify that record belongs to this customer."], ["can no longer be modified", "This order can no longer be modified."],
    ["can no longer be cancelled", "This order can no longer be cancelled."], ["cannot be cancelled", "This order can no longer be cancelled."], ["outside restaurant hours", "The requested time is outside restaurant hours."],
    ["invalid customer phone", "I need a valid 10-digit North American phone number before I can continue."],
    ["delivery distance validation is not configured", "Delivery is not currently available because the restaurant delivery area has not been configured."],
    ["delivery area is not configured", "Delivery is not currently available because the restaurant delivery area has not been configured."],
    ["customer confirmation is required", "Please confirm the final order before I place it."], ["quote does not match", "The order changed, so I need to recalculate the total before placing it."],
    ["reservation capacity is not configured", "I can submit the reservation request, but the restaurant must review the table availability."],
    ["staff approval is required", "The restaurant needs to review that request before it can be finalized."],
  ];
  const lower = raw.toLowerCase();
  const match = known.find(([needle]) => lower.includes(needle));
  return match ? match[1] : "The restaurant could not complete that request. Please try again or escalate to staff.";
}

async function resolveCustomerPhone(supabase: any, restaurantId: string, phone: string) {
  const normalized = requirePhone(phone);
  const { data } = await supabase.from("customers").select("id,phone").eq("restaurant_id", restaurantId).eq("phone_normalized", normalized).limit(1).maybeSingle();
  return data?.phone ?? normalized;
}

async function loadOrder(supabase: any, restaurantId: string, locationId: string, orderNumber: number, phone: string) {
  const normalized = requirePhone(phone);
  const { data: order, error } = await supabase.from("orders").select("*").eq("restaurant_id", restaurantId).eq("location_id", locationId).eq("order_number", orderNumber).limit(1).maybeSingle();
  if (error || !order) return null;
  if (normalizePhone(order.customer_phone) !== normalized) return null;
  const { data: items, error: itemError } = await supabase.from("order_items").select("*,order_item_selections(*)").eq("order_id", order.id).order("id");
  if (itemError) throw itemError;
  return { ...order, order_items: items ?? [] };
}

async function loadReservation(supabase: any, restaurantId: string, locationId: string, reservationNumber: number, phone: string) {
  const normalized = requirePhone(phone);
  const { data: reservation, error } = await supabase.from("reservations").select("*").eq("restaurant_id", restaurantId).eq("location_id", locationId).eq("reservation_number", reservationNumber).limit(1).maybeSingle();
  if (error || !reservation) return null;
  if (normalizePhone(reservation.customer_phone) !== normalized) return null;
  return reservation;
}

function localParts(iso: string | undefined, timezone: string) {
  const date = iso ? new Date(iso) : new Date();
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
  const get = (type: string) => parts.find(p => p.type === type)?.value ?? "";
  const weekday = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(get("weekday"));
  return { weekday, date: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour").padStart(2,"0")}:${get("minute").padStart(2,"0")}` };
}

function assertRestaurantOpen(info: any, scheduledFor?: string) {
  const local = localParts(scheduledFor, info.restaurant.timezone);
  if (!local) throw new Error("Invalid scheduled order time");
  const windows = (info.hours ?? []).filter((h:any) => h.day_of_week === local.weekday && !h.is_closed && h.opens_at && h.closes_at);
  const open = windows.some((h:any) => { const openTime=h.opens_at.slice(0,5); const closeTime=h.closes_at.slice(0,5); return openTime <= closeTime ? local.time >= openTime && local.time < closeTime : local.time >= openTime || local.time < closeTime; });
  if (!open) throw new Error("Restaurant is outside restaurant hours");
}

function assertFulfillmentEnabled(info: any, type: string) {
  if (type === "pickup" && !info.settings?.pickup_enabled) throw new Error("Pickup is currently unavailable");
  if (type === "dine_in" && !info.settings?.dine_in_enabled) throw new Error("Dine-in is currently unavailable");
  if (type === "delivery") {
    if (!info.settings?.delivery_enabled) throw new Error("Delivery is currently unavailable");
    if (info.settings?.delivery_radius_km == null || Number(info.settings.delivery_radius_km) <= 0) throw new Error("Delivery area is not configured");
    throw new Error("Delivery distance validation is not configured");
  }
}

function assertScheduledOrderAllowed(info: any, scheduledFor?: string) {
  if (!scheduledFor) return;
  if (!info.settings?.scheduled_orders_enabled) throw new Error("Scheduled orders are currently unavailable");
  const date = new Date(scheduledFor);
  if (Number.isNaN(date.getTime()) || date.getTime() < Date.now()) throw new Error("Scheduled order time must be in the future");
}

async function restaurantInfo(supabase: any, restaurantId: string, locationId: string) {
  const [{ data: restaurant, error: re }, { data: location, error: le }, { data: settings, error: se }, { data: hours, error: he }] = await Promise.all([
    supabase.from("restaurants").select("id,name,phone,email,website_url,logo_url,timezone,max_online_party_size").eq("id", restaurantId).single(),
    supabase.from("restaurant_locations").select("id,name,address_line1,city,province,postal_code,phone,email,is_active").eq("id", locationId).single(),
    supabase.from("restaurant_settings").select("pickup_enabled,delivery_enabled,dine_in_enabled,scheduled_orders_enabled,large_order_approval_threshold,reservations_enabled,reservations_auto_confirm,reservations_max_auto_party_size,reservation_capacity,delivery_radius_km,delivery_minimum_order,free_delivery_threshold,delivery_distance_pricing,ai_enabled,ai_escalation_settings,ai_approval_rules").eq("restaurant_id", restaurantId).single(),
    supabase.from("restaurant_hours").select("day_of_week,opens_at,closes_at,is_closed").eq("location_id", locationId).order("day_of_week"),
  ]);
  if (re || le || se || he || !restaurant || !location) throw new Error("Restaurant information is not configured");
  return { restaurant, location, settings, hours: hours ?? [] };
}

async function reservationAvailability(supabase: any, restaurantId: string, locationId: string, input: { party_size: number; requested_date: string; requested_time: string }, info?: any) {
  const restaurantInfoData = info ?? await restaurantInfo(supabase, restaurantId, locationId);
  if (!restaurantInfoData.settings?.reservations_enabled) return { available:false, reason:"reservations_disabled", requires_manual_confirmation:true };
  if (input.party_size > Number(restaurantInfoData.restaurant.max_online_party_size ?? 0)) return { available:false, reason:"party_size_limit", max_party_size:restaurantInfoData.restaurant.max_online_party_size, requires_manual_confirmation:true };
  const day = new Date(`${input.requested_date}T12:00:00Z`).getUTCDay();
  const hour = input.requested_time.slice(0,5);
  const hours = (restaurantInfoData.hours ?? []).filter((h:any)=>h.day_of_week===day);
  if (!hours.length || hours.every((h:any)=>h.is_closed || !h.opens_at || !h.closes_at || !(hour >= h.opens_at.slice(0,5) && hour < h.closes_at.slice(0,5)))) return { available:false, reason:"outside_restaurant_hours", requires_manual_confirmation:true };
  const { data: existing } = await supabase.from("reservations").select("party_size,status,requested_time").eq("restaurant_id",restaurantId).eq("location_id",locationId).eq("requested_date",input.requested_date).in("status",["pending","confirmed","alternative_proposed"]);
  const capacity = restaurantInfoData.settings.reservation_capacity == null ? null : Number(restaurantInfoData.settings.reservation_capacity);
  const used = (existing ?? []).filter((r:any)=>r.requested_time?.slice(0,5)===hour).reduce((sum:number,r:any)=>sum+Number(r.party_size),0);
  const capacityAvailable = capacity == null ? null : used + input.party_size <= capacity;
  return { available:capacityAvailable, availability_verifiable:capacity!==null, capacity_configured:capacity!==null, capacity_remaining:capacity===null ? null : Math.max(capacity-used,0), requires_manual_confirmation:true, requested_date:input.requested_date, requested_time:input.requested_time };
}

export async function handleAiRequest(request: Request, operation: string[]) {
  const auth = await authorize(request);
  if (auth.error) return auth.error;
  const { context, args, payload } = auth as { context: AiContext; args: JsonObject; payload: JsonObject };
  const { supabase, restaurantId, locationId, agentId } = context;
  const op = operation.join("/");

  try {
    if (op === "restaurant") return response(await restaurantInfo(supabase, restaurantId, locationId));
    if (op === "menu") {
      const input = z.object({ category: z.string().trim().max(100).optional(), item: z.string().trim().max(120).optional(), search: z.string().trim().max(120).optional(), modifier_group: z.string().trim().max(120).optional() }).parse(args);
      const info = await restaurantInfo(supabase, restaurantId, locationId);
      let categoryQuery = supabase.from("menu_categories").select("id,name").eq("restaurant_id", restaurantId).eq("is_active", true).order("display_order");
      if (input.category) categoryQuery = categoryQuery.ilike("name", `%${input.category}%`);
      const { data: categories, error: categoryError } = await categoryQuery; if (categoryError) throw categoryError;
      const categoryIds = (categories ?? []).map((c:any)=>c.id);
      let itemQuery = supabase.from("menu_items").select("id,category_id,name,description,price,dietary_tags,is_available,item_type").in("category_id",categoryIds.length?categoryIds:["00000000-0000-0000-0000-000000000000"]).order("display_order").limit(30);
      if (input.item) itemQuery=itemQuery.ilike("name",`%${input.item}%`); else if (input.search) itemQuery=itemQuery.or(`name.ilike.%${input.search}%,description.ilike.%${input.search}%`);
      const { data: items, error: itemError } = await itemQuery; if(itemError) throw itemError;
      const itemIds=(items??[]).map((i:any)=>i.id);
      const [{data:sizes},{data:links},{data:groups}]=await Promise.all([
        supabase.from("menu_item_sizes").select("id,menu_item_id,name,price,is_available").in("menu_item_id",itemIds.length?itemIds:["00000000-0000-0000-0000-000000000000"]).order("display_order"),
        supabase.from("menu_item_modifier_groups").select("menu_item_id,modifier_group_id,min_selections,max_selections,required,free_selections").in("menu_item_id",itemIds.length?itemIds:["00000000-0000-0000-0000-000000000000"]),
        supabase.from("modifier_groups").select("id,name,description,selection_type,min_selections,max_selections").eq("restaurant_id",restaurantId).eq("is_active",true).order("display_order")]);
      const groupIds=(links??[]).map((l:any)=>l.modifier_group_id);
      let modifierQuery=supabase.from("modifiers").select("id,modifier_group_id,name,description,price_delta,max_quantity,is_available,action").in("modifier_group_id",groupIds.length?groupIds:["00000000-0000-0000-0000-000000000000"]).order("display_order");
      if(input.modifier_group) modifierQuery=modifierQuery.ilike("name",`%${input.modifier_group}%`);
      const {data:modifiers,error:modifierError}=await modifierQuery; if(modifierError) throw modifierError;
      const categoryMap=new Map((categories??[]).map((c:any)=>[c.id,c.name]));
      return response({restaurant:{id:info.restaurant.id,name:info.restaurant.name},categories:(categories??[]).map((c:any)=>({id:c.id,name:c.name})),items:(items??[]).map((item:any)=>({id:item.id,category:categoryMap.get(item.category_id),name:item.name,description:item.description,base_price:item.price,dietary_tags:item.dietary_tags,available:item.is_available,item_type:item.item_type,sizes:(sizes??[]).filter((s:any)=>s.menu_item_id===item.id),modifier_groups:(links??[]).filter((l:any)=>l.menu_item_id===item.id).map((l:any)=>({...l,group:(groups??[]).find((g:any)=>g.id===l.modifier_group_id)??null,modifiers:(modifiers??[]).filter((m:any)=>m.modifier_group_id===l.modifier_group_id)}))}))});
    }
    if (op === "menu/availability") {
      const input=z.object({menu_item_id:z.string().uuid(),size_id:z.string().uuid().optional(),modifier_ids:z.array(z.string().uuid()).optional(),scheduled_for:z.string().datetime().optional()}).parse(args);
      const info=await restaurantInfo(supabase,restaurantId,locationId); const local=localParts(input.scheduled_for,info.restaurant.timezone);
      const {data:item}=await supabase.from("menu_items").select("id,name,is_available").eq("id",input.menu_item_id).single(); if(!item)return fail("ITEM_NOT_FOUND","That menu item could not be found.",404); if(!item.is_available)return response({available:false,reason:"item_unavailable"});
      if(local){const {data:windows}=await supabase.from("menu_item_availability_windows").select("starts_at,ends_at").eq("menu_item_id",item.id).eq("day_of_week",local.weekday); if((windows??[]).length&&!(windows??[]).some((w:any)=>local.time>=w.starts_at.slice(0,5)&&local.time<w.ends_at.slice(0,5)))return response({available:false,reason:"outside_item_availability_window"});}
      if(input.size_id){const {data:size}=await supabase.from("menu_item_sizes").select("id,name,is_available").eq("id",input.size_id).eq("menu_item_id",item.id).maybeSingle();if(!size)return fail("INVALID_SIZE","That size is not available for this item.");if(!size.is_available)return response({available:false,reason:"size_unavailable",size});}
      if(input.modifier_ids?.length){const {data:modifiers}=await supabase.from("modifiers").select("id,name,is_available,modifier_group_id").in("id",input.modifier_ids);if((modifiers??[]).length!==input.modifier_ids.length)return fail("MODIFIER_NOT_FOUND","One or more modifiers could not be found.");if((modifiers??[]).some((m:any)=>!m.is_available))return response({available:false,reason:"modifier_unavailable",modifiers});const {data:links}=await supabase.from("menu_item_modifier_groups").select("modifier_group_id").eq("menu_item_id",item.id);const allowed=new Set((links??[]).map((l:any)=>l.modifier_group_id));if((modifiers??[]).some((m:any)=>!allowed.has(m.modifier_group_id)))return response({available:false,reason:"modifier_not_applicable"});}
      return response({available:true,item});
    }
    if(op==="order/quote"){
      const input=z.object({customer_name:z.string().trim().min(1).max(120),customer_phone:z.string().trim().min(10).max(30),customer_email:z.string().email().max(320).optional(),fulfillment_type:z.enum(["pickup","delivery","dine_in"]),notes:z.string().max(1000).optional(),scheduled_for:z.string().datetime().optional(),delivery_address_line1:z.string().max(200).optional(),delivery_address_line2:z.string().max(200).optional(),delivery_city:z.string().max(100).optional(),delivery_province:z.string().max(100).optional(),delivery_postal_code:z.string().max(30).optional(),delivery_instructions:z.string().max(1000).optional(),table_number:z.string().max(30).optional(),items:itemsSchema}).parse(args);
      const phone=await resolveCustomerPhone(supabase,restaurantId,input.customer_phone); const info=await restaurantInfo(supabase,restaurantId,locationId); assertFulfillmentEnabled(info,input.fulfillment_type); assertScheduledOrderAllowed(info,input.scheduled_for); assertRestaurantOpen(info,input.scheduled_for);
      const {data,error}=await supabase.rpc("quote_complex_order_atomic",{p_restaurant_id:restaurantId,p_location_id:locationId,p_customer_name:input.customer_name,p_customer_phone:phone,p_fulfillment_type:input.fulfillment_type,p_notes:input.notes??null,p_scheduled_for:input.scheduled_for??null,p_delivery_address_line1:input.delivery_address_line1??null,p_delivery_address_line2:input.delivery_address_line2??null,p_delivery_city:input.delivery_city??null,p_delivery_province:input.delivery_province??null,p_delivery_postal_code:input.delivery_postal_code??null,p_delivery_instructions:input.delivery_instructions??null,p_table_number:input.table_number??null,p_items:input.items});if(error)throw error; return response({quote:data,quote_token:quoteToken({...input,customer_phone:phone})});
    }
    if(op==="order/create"){
      const input=z.object({customer_name:z.string().trim().min(1).max(120),customer_phone:z.string().trim().min(10).max(30),customer_email:z.string().email().max(320).optional(),fulfillment_type:z.enum(["pickup","delivery","dine_in"]),notes:z.string().max(1000).optional(),scheduled_for:z.string().datetime().optional(),delivery_address_line1:z.string().max(200).optional(),delivery_address_line2:z.string().max(200).optional(),delivery_city:z.string().max(100).optional(),delivery_province:z.string().max(100).optional(),delivery_postal_code:z.string().max(30).optional(),delivery_instructions:z.string().max(1000).optional(),table_number:z.string().max(30).optional(),items:itemsSchema,idempotency_key:z.string().trim().min(8).max(200).optional(),customer_confirmed:z.literal(true),quote_token:z.string().regex(/^[a-f0-9]{64}$/i)}).parse(args);
      const phone=await resolveCustomerPhone(supabase,restaurantId,input.customer_phone); const info=await restaurantInfo(supabase,restaurantId,locationId); assertFulfillmentEnabled(info,input.fulfillment_type); assertScheduledOrderAllowed(info,input.scheduled_for); assertRestaurantOpen(info,input.scheduled_for);
      const quoteInput={customer_name:input.customer_name,customer_phone:phone,customer_email:input.customer_email,fulfillment_type:input.fulfillment_type,notes:input.notes,scheduled_for:input.scheduled_for,delivery_address_line1:input.delivery_address_line1,delivery_address_line2:input.delivery_address_line2,delivery_city:input.delivery_city,delivery_province:input.delivery_province,delivery_postal_code:input.delivery_postal_code,delivery_instructions:input.delivery_instructions,table_number:input.table_number,items:input.items}; const expectedQuoteToken=quoteToken(quoteInput); if(!timingSafeEqual(Buffer.from(expectedQuoteToken),Buffer.from(input.quote_token))) return fail("QUOTE_MISMATCH","The order changed, so the total must be recalculated before placing it.",409,true);
      const requestHash=hash({...input,customer_phone:phone,idempotency_key:undefined,customer_confirmed:undefined,quote_token:undefined}); const callId=payload?.call?.call_id; const idempotencyKey=input.idempotency_key??(callId?hash(`${callId}:order.create:${requestHash}`).slice(0,48):null); if(!idempotencyKey)return fail("IDEMPOTENCY_KEY_REQUIRED","A unique order request identifier is required before creating an order.",400,false);
      const {data,error}=await supabase.rpc("create_ai_order_idempotent",{p_agent_id:agentId,p_restaurant_id:restaurantId,p_location_id:locationId,p_idempotency_key:idempotencyKey,p_request_hash:requestHash,p_customer_name:input.customer_name,p_customer_phone:phone,p_fulfillment_type:input.fulfillment_type,p_notes:input.notes??null,p_scheduled_for:input.scheduled_for??null,p_delivery_address_line1:input.delivery_address_line1??null,p_delivery_address_line2:input.delivery_address_line2??null,p_delivery_city:input.delivery_city??null,p_delivery_province:input.delivery_province??null,p_delivery_postal_code:input.delivery_postal_code??null,p_delivery_instructions:input.delivery_instructions??null,p_table_number:input.table_number??null,p_items:input.items});if(error)throw error; const order=data as any; if(input.customer_email&&order?.id){await supabase.from("customers").update({email:input.customer_email,first_name:input.customer_name.split(/\s+/)[0]??null,last_name:input.customer_name.split(/\s+/).slice(1).join(" ")||null,updated_at:new Date().toISOString()}).eq("restaurant_id",restaurantId).eq("phone_normalized",normalizePhone(phone));await supabase.from("orders").update({customer_email:input.customer_email}).eq("id",order.id).eq("restaurant_id",restaurantId);} return response({order},201);
    }
    if(op==="order/lookup"){const input=z.object({order_number:z.coerce.number().int().positive(),customer_phone:z.string().min(10).max(30)}).parse(args);const order=await loadOrder(supabase,restaurantId,locationId,input.order_number,input.customer_phone);if(!order)return fail("ORDER_NOT_FOUND","I could not find an order matching that order number and phone number.",404);return response({order});}
    if(op==="order/modify"){
      const input=z.object({order_number:z.coerce.number().int().positive(),customer_phone:z.string().min(10).max(30),customer_name:z.string().trim().min(1).max(120).optional(),customer_email:z.string().email().max(320).optional(),fulfillment_type:z.enum(["pickup","delivery","dine_in"]).optional(),notes:z.string().max(1000).optional(),scheduled_for:z.string().datetime().optional(),delivery_address_line1:z.string().max(200).optional(),delivery_address_line2:z.string().max(200).optional(),delivery_city:z.string().max(100).optional(),delivery_province:z.string().max(100).optional(),delivery_postal_code:z.string().max(30).optional(),delivery_instructions:z.string().max(1000).optional(),table_number:z.string().max(30).optional(),items:itemsSchema,customer_confirmed:z.literal(true),quote_token:z.string().regex(/^[a-f0-9]{64}$/i)}).parse(args);
      const order=await loadOrder(supabase,restaurantId,locationId,input.order_number,input.customer_phone);if(!order)return fail("ORDER_NOT_FOUND","I could not find an order matching that order number and phone number.",404);const phone=await resolveCustomerPhone(supabase,restaurantId,input.customer_phone);const info=await restaurantInfo(supabase,restaurantId,locationId);const fulfillment=input.fulfillment_type??order.fulfillment_type;assertFulfillmentEnabled(info,fulfillment);assertScheduledOrderAllowed(info,input.scheduled_for??order.scheduled_for);assertRestaurantOpen(info,input.scheduled_for??order.scheduled_for);
      const quoteInput={customer_name:input.customer_name??order.customer_name,customer_phone:phone,customer_email:input.customer_email??order.customer_email,fulfillment_type:fulfillment,notes:input.notes??order.notes,scheduled_for:input.scheduled_for??order.scheduled_for,delivery_address_line1:input.delivery_address_line1??order.delivery_address_line1,delivery_address_line2:input.delivery_address_line2??order.delivery_address_line2,delivery_city:input.delivery_city??order.delivery_city,delivery_province:input.delivery_province??order.delivery_province,delivery_postal_code:input.delivery_postal_code??order.delivery_postal_code,delivery_instructions:input.delivery_instructions??order.delivery_instructions,table_number:input.table_number??order.table_number,items:input.items}; const expectedQuoteToken=quoteToken(quoteInput); if(!timingSafeEqual(Buffer.from(expectedQuoteToken),Buffer.from(input.quote_token)))return fail("QUOTE_MISMATCH","The order changed, so the total must be recalculated before applying the change.",409,true);
      const {data,error}=await supabase.rpc("modify_ai_order_atomic",{p_agent_id:agentId,p_restaurant_id:restaurantId,p_location_id:locationId,p_order_id:order.id,p_customer_phone:phone,p_customer_name:quoteInput.customer_name,p_customer_email:quoteInput.customer_email,p_fulfillment_type:quoteInput.fulfillment_type,p_notes:quoteInput.notes,p_scheduled_for:quoteInput.scheduled_for,p_delivery_address_line1:quoteInput.delivery_address_line1,p_delivery_address_line2:quoteInput.delivery_address_line2,p_delivery_city:quoteInput.delivery_city,p_delivery_province:quoteInput.delivery_province,p_delivery_postal_code:quoteInput.delivery_postal_code,p_delivery_instructions:quoteInput.delivery_instructions,p_table_number:quoteInput.table_number,p_items:input.items});if(error)throw error;return response({order:data});
    }
    if(op==="order/cancel"){const input=z.object({order_number:z.coerce.number().int().positive(),customer_phone:z.string().min(10).max(30),reason:z.string().max(500).optional()}).parse(args);const order=await loadOrder(supabase,restaurantId,locationId,input.order_number,input.customer_phone);if(!order)return fail("ORDER_NOT_FOUND","I could not find an order matching that order number and phone number.",404);const {data,error}=await supabase.rpc("cancel_ai_order",{p_agent_id:agentId,p_restaurant_id:restaurantId,p_location_id:locationId,p_order_id:order.id,p_customer_phone:requirePhone(input.customer_phone),p_reason:input.reason??null});if(error)throw error;return response({order:data});}
    if(op==="reservation/check"){const input=z.object({party_size:z.coerce.number().int().min(1).max(50),requested_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),requested_time:z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/)}).parse(args);return response(await reservationAvailability(supabase,restaurantId,locationId,input));}
    if(op==="reservation/create"){
      const input=z.object({customer_name:z.string().trim().min(1).max(120),customer_phone:z.string().min(10).max(30),customer_email:z.string().email().max(320).optional(),party_size:z.coerce.number().int().min(1).max(50),requested_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/),requested_time:z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),seating_preference:z.enum(["indoor","patio","booth","no_preference"]).optional(),customer_notes:z.string().max(1000).optional(),special_request:z.string().max(1000).optional()}).parse(args);
      const phone=await resolveCustomerPhone(supabase,restaurantId,input.customer_phone);const info=await restaurantInfo(supabase,restaurantId,locationId);if(!info.settings?.reservations_enabled)return fail("RESERVATIONS_DISABLED","Reservations are currently unavailable.",409);const availability=await reservationAvailability(supabase,restaurantId,locationId,{party_size:input.party_size,requested_date:input.requested_date,requested_time:input.requested_time},info);if(availability.available===false)return fail("RESERVATION_UNAVAILABLE",availability.reason==="outside_restaurant_hours"?"The requested reservation time is outside restaurant hours.":availability.reason==="party_size_limit"?"That party size is above the restaurant's online reservation limit.":"That reservation time is not available.",409);const {data,error}=await supabase.rpc("create_reservation_atomic",{p_restaurant_id:restaurantId,p_location_id:locationId,p_customer_name:input.customer_name,p_customer_phone:phone,p_party_size:input.party_size,p_requested_date:input.requested_date,p_requested_time:input.requested_time,p_customer_notes:[input.customer_notes,input.special_request].filter(Boolean).join(" | ")||null,p_source:"ai_phone"});if(error)throw error;const reservationId=(data as any)?.id;if(reservationId){await supabase.from("reservations").update({seating_preference:input.seating_preference??null,customer_email:input.customer_email??null}).eq("id",reservationId).eq("restaurant_id",restaurantId);if(input.customer_email)await supabase.from("customers").update({email:input.customer_email,updated_at:new Date().toISOString()}).eq("restaurant_id",restaurantId).eq("phone_normalized",normalizePhone(phone));}return response({reservation:data,request_only:true,requires_staff_confirmation:true},201);
    }
    if(op==="reservation/lookup"){const input=z.object({reservation_number:z.coerce.number().int().positive(),customer_phone:z.string().min(10).max(30)}).parse(args);const reservation=await loadReservation(supabase,restaurantId,locationId,input.reservation_number,input.customer_phone);if(!reservation)return fail("RESERVATION_NOT_FOUND","I could not find a reservation matching that reservation number and phone number.",404);return response({reservation});}
    if(op==="reservation/update"){
      const input=z.object({reservation_number:z.coerce.number().int().positive(),customer_phone:z.string().min(10).max(30),operation:z.enum(["request_cancel","request_time_change"]),requested_date:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),requested_time:z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),note:z.string().max(1000).optional()}).parse(args);const reservation=await loadReservation(supabase,restaurantId,locationId,input.reservation_number,input.customer_phone);if(!reservation)return fail("RESERVATION_NOT_FOUND","I could not find a reservation matching that reservation number and phone number.",404);if(input.operation==="request_time_change"&&(!input.requested_date||!input.requested_time))return fail("REQUESTED_TIME_REQUIRED","A requested date and time are required for a reservation change request.");
      const requestText=input.operation==="request_cancel"?`Customer requested reservation cancellation${input.note?`: ${input.note}`:""}`:`Customer requested reservation change to ${input.requested_date} at ${input.requested_time}${input.note?`: ${input.note}`:""}`;const combined=[reservation.customer_notes,requestText].filter(Boolean).join(" | ");const {data,error}=await supabase.from("reservations").update({customer_notes:combined,updated_at:new Date().toISOString()}).eq("id",reservation.id).eq("restaurant_id",restaurantId).eq("location_id",locationId).select("*").single();if(error)throw error;await supabase.from("reservation_events").insert({reservation_id:reservation.id,from_status:reservation.status,to_status:reservation.status,actor_type:"ai_request",note:requestText});return response({reservation:data,request_only:true,requires_staff_confirmation:true});
    }
    return fail("UNKNOWN_OPERATION","That AI operation is not available.",404,false);
  } catch(error) { console.error(`AI ${op}`,error); const message=userError(error); const status=message.includes("not found")?404:message.includes("requires")||message.includes("cannot")||message.includes("can no longer")||message.includes("not configured")||message.includes("outside")?409:400; return fail("REQUEST_REJECTED",message,status,true); }
}
