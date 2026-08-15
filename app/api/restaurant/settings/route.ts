import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = createServerSupabase();
    const { data: restaurant, error: restaurantError } = await supabase.from("restaurants").select("id").limit(1).single();
    if (restaurantError || !restaurant) throw restaurantError ?? new Error("Restaurant not configured");
    const { data: settings, error } = await supabase.from("restaurant_settings").select("*").eq("restaurant_id", restaurant.id).single();
    if (error) throw error;
    return NextResponse.json(settings);
  } catch (error) {
    console.error("GET /api/restaurant/settings", error);
    return NextResponse.json({ error: "Unable to load restaurant settings." }, { status: 500 });
  }
}
