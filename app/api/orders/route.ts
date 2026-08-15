import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

const itemSchema = z.object({ menu_item_id: z.string().uuid(), quantity: z.number().int().min(1).max(99), special_instructions: z.string().max(500).optional() });
const createOrderSchema = z.object({ customer_name: z.string().trim().min(1).max(120), customer_phone: z.string().trim().min(7).max(30), fulfillment_type: z.enum(["pickup", "delivery", "dine_in"]), notes: z.string().max(1000).optional(), items: z.array(itemSchema).min(1).max(50) });

type RestaurantScope = { id: string };
type LocationScope = { id: string };

const restaurantScope = async () => {
  const supabase = createServerSupabase();
  const { data: rawRestaurant, error: re } = await supabase.from("restaurants").select("id").limit(1).single();
  if (re || !rawRestaurant) throw new Error("Restaurant not configured");
  const restaurant = rawRestaurant as RestaurantScope;
  const { data: rawLocation, error: le } = await supabase.from("restaurant_locations").select("id").eq("restaurant_id", restaurant.id).eq("is_active", true).limit(1).single();
  if (le || !rawLocation) throw new Error("Active restaurant location not configured");
  const location = rawLocation as LocationScope;
  return { supabase, restaurantId: restaurant.id, locationId: location.id };
};

export async function GET() {
  try {
    const { supabase, restaurantId, locationId } = await restaurantScope();
    const { data, error } = await supabase.from("orders").select("*, order_items(*)").eq("restaurant_id", restaurantId).eq("location_id", locationId).order("created_at", { ascending: false });
    if (error) throw error;
    return NextResponse.json({ orders: data ?? [] });
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
    const { data, error } = await supabase.rpc("create_order_atomic", { p_restaurant_id: restaurantId, p_location_id: locationId, p_customer_name: parsed.data.customer_name, p_customer_phone: parsed.data.customer_phone, p_fulfillment_type: parsed.data.fulfillment_type, p_notes: parsed.data.notes ?? null, p_items: parsed.data.items });
    if (error) throw error;
    return NextResponse.json({ order: data }, { status: 201 });
  } catch (error) {
    console.error("POST /api/orders", error);
    const message = error instanceof Error ? error.message : "Unable to create order.";
    return NextResponse.json({ error: message.includes("Menu item") || message.includes("Invalid") ? message : "Unable to create order." }, { status: 400 });
  }
}
