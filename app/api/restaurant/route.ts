import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = createServerSupabase();
    const { data: restaurant, error: restaurantError } = await supabase.from("restaurants").select("*").limit(1).single();
    if (restaurantError) throw restaurantError;
    const { data: locations, error: locationError } = await supabase.from("restaurant_locations").select("*").eq("restaurant_id", restaurant.id).eq("is_active", true);
    if (locationError) throw locationError;
    return NextResponse.json({ ...restaurant, restaurant_locations: locations ?? [] });
  } catch (error) {
    console.error("GET /api/restaurant", error);
    return NextResponse.json({ error: "Unable to load restaurant information." }, { status: 500 });
  }
}
