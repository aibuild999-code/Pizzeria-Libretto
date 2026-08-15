import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

type RestaurantScope = { id: string };
type LocationScope = { id: string };

const selectionSchema = z.object({
  modifier_id: z.string().uuid(),
  quantity: z.number().int().min(1).max(99).optional(),
  side: z.enum(["whole", "left", "right"]).optional(),
  quantity_level_id: z.string().uuid().optional(),
  notes: z.string().max(500).optional(),
});

const itemSchema = z.object({
  menu_item_id: z.string().uuid(),
  size_id: z.string().uuid().optional(),
  quantity: z.number().int().min(1).max(99),
  special_instructions: z.string().max(500).optional(),
  selections: z.array(selectionSchema).max(100).optional(),
});

const createOrderSchema = z.object({
  customer_name: z.string().trim().min(1).max(120),
  customer_phone: z.string().trim().min(7).max(30),
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
  items: z.array(itemSchema).min(1).max(50),
});

async function restaurantScope() {
  const supabase = createServerSupabase();
  const { data: rawRestaurant, error: restaurantError } = await supabase.from("restaurants").select("id").limit(1).single();
  if (restaurantError || !rawRestaurant) throw new Error("Restaurant not configured");
  const restaurant = rawRestaurant as RestaurantScope;
  const { data: rawLocation, error: locationError } = await supabase.from("restaurant_locations").select("id").eq("restaurant_id", restaurant.id).eq("is_active", true).limit(1).single();
  if (locationError || !rawLocation) throw new Error("Active restaurant location not configured");
  return { supabase, restaurantId: restaurant.id, locationId: (rawLocation as LocationScope).id };
}

export async function GET() {
  try {
    const { supabase, restaurantId, locationId } = await restaurantScope();
    const { data: orders, error } = await supabase.from("orders").select("*").eq("restaurant_id", restaurantId).eq("location_id", locationId).order("created_at", { ascending: false });
    if (error) throw error;
    const orderIds = (orders ?? []).map((order) => order.id);
    const { data: items, error: itemError } = orderIds.length ? await supabase.from("order_items").select("*").in("order_id", orderIds) : { data: [], error: null };
    if (itemError) throw itemError;
    const itemIds = (items ?? []).map((item) => item.id);
    const { data: selections, error: selectionError } = itemIds.length ? await supabase.from("order_item_selections").select("*").in("order_item_id", itemIds).order("created_at") : { data: [], error: null };
    if (selectionError) throw selectionError;
    return NextResponse.json({
      orders: (orders ?? []).map((order) => ({
        ...order,
        order_items: (items ?? []).filter((item) => item.order_id === order.id).map((item) => ({
          ...item,
          selections: (selections ?? []).filter((selection) => selection.order_item_id === item.id),
        })),
      })),
    });
  } catch (error) {
    console.error("GET /api/orders", error);
    return NextResponse.json({ error: "Unable to load orders." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const parsed = createOrderSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid order payload.", details: parsed.error.flatten() }, { status: 400 });
    const { supabase, restaurantId, locationId } = await restaurantScope();
    const { data, error } = await supabase.rpc("create_complex_order_atomic", {
      p_restaurant_id: restaurantId,
      p_location_id: locationId,
      p_customer_name: parsed.data.customer_name,
      p_customer_phone: parsed.data.customer_phone,
      p_fulfillment_type: parsed.data.fulfillment_type,
      p_notes: parsed.data.notes ?? null,
      p_scheduled_for: parsed.data.scheduled_for ?? null,
      p_delivery_address_line1: parsed.data.delivery_address_line1 ?? null,
      p_delivery_address_line2: parsed.data.delivery_address_line2 ?? null,
      p_delivery_city: parsed.data.delivery_city ?? null,
      p_delivery_province: parsed.data.delivery_province ?? null,
      p_delivery_postal_code: parsed.data.delivery_postal_code ?? null,
      p_delivery_instructions: parsed.data.delivery_instructions ?? null,
      p_table_number: parsed.data.table_number ?? null,
      p_items: parsed.data.items,
    });
    if (error) throw error;
    return NextResponse.json({ order: data }, { status: 201 });
  } catch (error) {
    console.error("POST /api/orders", error);
    const message = error instanceof Error ? error.message : "Unable to create order.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
