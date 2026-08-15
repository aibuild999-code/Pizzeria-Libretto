import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = createServerSupabase();
    const { data: restaurant, error: restaurantError } = await supabase.from("restaurants").select("*").limit(1).single();
    if (restaurantError) throw restaurantError;
    const [{ data: locations, error: locationError }, { data: settings, error: settingsError }] = await Promise.all([
      supabase.from("restaurant_locations").select("*").eq("restaurant_id", restaurant.id).eq("is_active", true),
      supabase.from("restaurant_settings").select("*").eq("restaurant_id", restaurant.id).single(),
    ]);
    if (locationError) throw locationError;
    if (settingsError) throw settingsError;
    return NextResponse.json({ ...restaurant, restaurant_locations: locations ?? [], settings });
  } catch (error) {
    console.error("GET /api/restaurant", error);
    return NextResponse.json({ error: "Unable to load restaurant information." }, { status: 500 });
  }
}
