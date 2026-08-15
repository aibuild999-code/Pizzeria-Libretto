import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

type Location = {
  id: string;
  restaurant_id: string;
  name: string;
};

export async function GET() {
  try {
    const supabase = createServerSupabase();
    const { data, error: locationError } = await supabase
      .from("restaurant_locations")
      .select("id,restaurant_id,name")
      .eq("is_active", true)
      .limit(1)
      .single();

    if (locationError) throw locationError;

    const location = data as Location;
    const { data: hours, error } = await supabase
      .from("restaurant_hours")
      .select("*")
      .eq("location_id", location.id)
      .order("day_of_week");

    if (error) throw error;
    return NextResponse.json({ location, hours: hours ?? [] });
  } catch (error) {
    console.error("GET /api/hours", error);
    return NextResponse.json({ error: "Unable to load restaurant hours." }, { status: 500 });
  }
}
