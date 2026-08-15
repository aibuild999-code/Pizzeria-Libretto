import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

export async function GET() {
  try {
    const supabase = createServerSupabase();
    const { data, error } = await supabase.from("restaurants").select("*, restaurant_locations(*)").limit(1).single();
    if (error) throw error;
    return NextResponse.json(data);
  } catch (error) {
    console.error("GET /api/restaurant", error);
    return NextResponse.json({ error: "Unable to load restaurant information." }, { status: 500 });
  }
}
