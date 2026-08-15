import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

type Restaurant = { id: string; name: string; slug: string };
type Category = { id: string; name: string; display_order: number; is_active: boolean };
type MenuItem = { id: string; category_id: string; name: string; description: string | null; price: number | string; dietary_tags: string[]; is_available: boolean; display_order: number; image_url: string | null };

export async function GET() {
  try {
    const supabase = createServerSupabase();
    const { data: rawRestaurant, error: restaurantError } = await supabase.from("restaurants").select("id,name,slug").limit(1).single();
    if (restaurantError) throw restaurantError;
    const restaurant = rawRestaurant as Restaurant;

    const { data: rawCategories, error: categoryError } = await supabase.from("menu_categories").select("id,name,display_order,is_active").eq("restaurant_id", restaurant.id).eq("is_active", true).order("display_order");
    if (categoryError) throw categoryError;
    const categories = (rawCategories ?? []) as Category[];
    const categoryIds = categories.map((category) => category.id);

    let items: MenuItem[] = [];
    if (categoryIds.length) {
      const { data: rawItems, error: itemError } = await supabase.from("menu_items").select("id,category_id,name,description,price,dietary_tags,is_available,display_order,image_url").in("category_id", categoryIds).order("display_order");
      if (itemError) throw itemError;
      items = (rawItems ?? []) as MenuItem[];
    }

    const grouped = categories.map((category) => ({ ...category, menu_items: items.filter((item) => item.category_id === category.id) }));
    return NextResponse.json({ restaurant, categories: grouped });
  } catch (error) {
    console.error("GET /api/menu", error);
    return NextResponse.json({ error: "Unable to load the menu." }, { status: 500 });
  }
}
