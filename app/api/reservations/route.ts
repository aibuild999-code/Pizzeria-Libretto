import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

const createSchema = z.object({
  customer_name: z.string().trim().min(1).max(120),
  customer_phone: z.string().trim().min(7).max(30),
  customer_email: z.string().trim().email().max(320).optional(),
  party_size: z.number().int().min(1).max(50),
  requested_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requested_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/),
  customer_notes: z.string().max(1000).optional(),
  source: z.string().max(50).optional(),
});
type RestaurantScope = { id: string; max_online_party_size: number };
type LocationScope = { id: string };

const scope = async () => {
  const supabase = createServerSupabase();
  const { data: rawRestaurant, error: re } = await supabase.from("restaurants").select("id,max_online_party_size").limit(1).single();
  if (re || !rawRestaurant) throw new Error("Restaurant not configured");
  const restaurant = rawRestaurant as RestaurantScope;
  const { data: rawLocation, error: le } = await supabase.from("restaurant_locations").select("id").eq("restaurant_id", restaurant.id).eq("is_active", true).limit(1).single();
  if (le || !rawLocation) throw new Error("Active restaurant location not configured");
  const location = rawLocation as LocationScope;
  return { supabase, restaurantId: restaurant.id, locationId: location.id, maxParty: restaurant.max_online_party_size };
};

export async function GET() {
  try {
    const { supabase, restaurantId, locationId } = await scope();
    const { data: reservations, error } = await supabase.from("reservations").select("*").eq("restaurant_id", restaurantId).eq("location_id", locationId).order("requested_date", { ascending: true }).order("requested_time", { ascending: true });
    if (error) throw error;
    const rows = reservations ?? [];
    const reservationIds = rows.map((reservation) => reservation.id);
    const { data: events, error: eventError } = reservationIds.length ? await supabase.from("reservation_events").select("*").in("reservation_id", reservationIds).order("created_at", { ascending: true }) : { data: [], error: null };
    if (eventError) throw eventError;
    return NextResponse.json({ reservations: rows.map((reservation) => ({ ...reservation, reservation_events: (events ?? []).filter((event) => event.reservation_id === reservation.id) })) });
  } catch (error) {
    console.error("GET /api/reservations", error);
    return NextResponse.json({ error: "Unable to load reservations." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid reservation payload.", details: parsed.error.flatten() }, { status: 400 });
    const { supabase, restaurantId, locationId, maxParty } = await scope();
    if (parsed.data.party_size > maxParty) return NextResponse.json({ error: `Maximum online party size is ${maxParty}.` }, { status: 400 });

    const { error: customerError } = await supabase.from("customers").upsert({
      restaurant_id: restaurantId,
      name: parsed.data.customer_name,
      phone: parsed.data.customer_phone,
      email: parsed.data.customer_email ?? null,
      updated_at: new Date().toISOString(),
    }, { onConflict: "restaurant_id,phone" });
    if (customerError) throw customerError;

    const { data, error } = await supabase.rpc("create_reservation_atomic", {
      p_restaurant_id: restaurantId,
      p_location_id: locationId,
      p_customer_name: parsed.data.customer_name,
      p_customer_phone: parsed.data.customer_phone,
      p_party_size: parsed.data.party_size,
      p_requested_date: parsed.data.requested_date,
      p_requested_time: parsed.data.requested_time,
      p_customer_notes: parsed.data.customer_notes ?? null,
      p_source: parsed.data.source ?? "ai_phone",
    });
    if (error) throw error;

    const reservationId = data && typeof data === "object" && "id" in data ? String((data as { id: string }).id) : null;
    if (reservationId && parsed.data.customer_email) {
      const { error: reservationEmailError } = await supabase.from("reservations").update({ customer_email: parsed.data.customer_email }).eq("id", reservationId).eq("restaurant_id", restaurantId);
      if (reservationEmailError) throw reservationEmailError;
    }

    return NextResponse.json({ reservation: data }, { status: 201 });
  } catch (error) {
    console.error("POST /api/reservations", error);
    return NextResponse.json({ error: error instanceof Error ? error.message : "Unable to create reservation." }, { status: 400 });
  }
}
