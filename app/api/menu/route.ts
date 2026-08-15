import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

type Restaurant = {
  id: string;
  name: string;
  slug: string;
};

export async function GET() {
  try {
    const supabase = createServerSupabase();
    const { data, error: restaurantError } = await supabase
      .from("restaurants")
      .select("id,name,slug")
      .limit(1)
      .single();

    if (restaurantError) throw restaurantError;
    const restaurant = data as Restaurant;

    const { data: categories, error } = await supabase
      .from("menu_categories")
      .select(
        "id,name,display_order,is_active,menu_items(id,name,description,price,dietary_tags,is_available,display_order,image_url)"
      )
      .eq("restaurant_id", restaurant.id)
      .eq("is_active", true)
      .order("display_order");

    if (error) throw error;
    return NextResponse.json({ restaurant, categories: categories ?? [] });
  } catch (error) {
    console.error("GET /api/menu", error);
    return NextResponse.json({ error: "Unable to load the menu." }, { status: 500 });
  }
}
