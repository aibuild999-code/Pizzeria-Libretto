import { NextResponse } from "next/server";
import { createServerSupabase } from "@/lib/supabase/server";

type AnyRow = Record<string, unknown>;

export async function GET() {
  try {
    const supabase = createServerSupabase();
    const { data: restaurant, error: restaurantError } = await supabase
      .from("restaurants")
      .select("id,name,slug")
      .limit(1)
      .single();
    if (restaurantError || !restaurant) throw restaurantError ?? new Error("Restaurant not configured");

    const { data: categories, error: categoryError } = await supabase
      .from("menu_categories")
      .select("id,name,display_order,is_active")
      .eq("restaurant_id", restaurant.id)
      .eq("is_active", true)
      .order("display_order");
    if (categoryError) throw categoryError;

    const categoryIds = (categories ?? []).map((c) => c.id);
    const { data: items, error: itemError } = categoryIds.length
      ? await supabase.from("menu_items").select("id,category_id,name,description,price,dietary_tags,is_available,display_order,image_url,item_type").in("category_id", categoryIds).order("display_order")
      : { data: [], error: null };
    if (itemError) throw itemError;

    const itemIds = (items ?? []).map((i) => i.id);
    const [sizes, ingredients, itemIngredients, itemGroups, groups, modifiers, sizeRules, itemAvailability, comboGroups, comboOptions, quantityLevels] = await Promise.all([
      itemIds.length ? supabase.from("menu_item_sizes").select("*").in("menu_item_id", itemIds).order("display_order") : Promise.resolve({ data: [], error: null }),
      supabase.from("menu_ingredients").select("id,name,allergens,dietary_tags,is_available"),
      itemIds.length ? supabase.from("menu_item_ingredients").select("*").in("menu_item_id", itemIds).order("display_order") : Promise.resolve({ data: [], error: null }),
      itemIds.length ? supabase.from("menu_item_modifier_groups").select("*").in("menu_item_id", itemIds).order("display_order") : Promise.resolve({ data: [], error: null }),
      supabase.from("modifier_groups").select("id,name,description,selection_type,min_selections,max_selections,allow_duplicate_selections,is_active,display_order").eq("restaurant_id", restaurant.id).eq("is_active", true).order("display_order"),
      supabase.from("modifiers").select("id,modifier_group_id,name,description,price_delta,max_quantity,is_available,display_order,action,target_ingredient_id,replacement_ingredient_id,pricing_mode,price_multiplier,side_pricing_factor").order("display_order"),
      itemIds.length ? supabase.from("menu_item_modifier_group_size_rules").select("*").in("menu_item_id", itemIds) : Promise.resolve({ data: [], error: null }),
      itemIds.length ? supabase.from("menu_item_availability_windows").select("*").in("menu_item_id", itemIds) : Promise.resolve({ data: [], error: null }),
      itemIds.length ? supabase.from("combo_groups").select("*").in("combo_item_id", itemIds).order("display_order") : Promise.resolve({ data: [], error: null }),
      supabase.from("combo_group_options").select("*").order("display_order"),
      supabase.from("modifier_quantity_levels").select("*").order("display_order"),
    ]);

    for (const result of [sizes, ingredients, itemIngredients, itemGroups, groups, modifiers, sizeRules, itemAvailability, comboGroups, comboOptions, quantityLevels]) {
      if (result.error) throw result.error;
    }

    const groupRows = (groups.data ?? []) as AnyRow[];
    const modifierRows = (modifiers.data ?? []) as AnyRow[];
    const itemGroupRows = (itemGroups.data ?? []) as AnyRow[];
    const sizeRuleRows = (sizeRules.data ?? []) as AnyRow[];
    const ingredientRows = (ingredients.data ?? []) as AnyRow[];
    const quantityRows = (quantityLevels.data ?? []) as AnyRow[];
    const comboGroupRows = (comboGroups.data ?? []) as AnyRow[];
    const comboOptionRows = (comboOptions.data ?? []) as AnyRow[];

    const enrichedItems = ((items ?? []) as AnyRow[]).map((item) => ({
      ...item,
      sizes: ((sizes.data ?? []) as AnyRow[]).filter((s) => s.menu_item_id === item.id),
      recipe: ((itemIngredients.data ?? []) as AnyRow[]).filter((r) => r.menu_item_id === item.id).map((r) => ({ ...r, ingredient: ingredientRows.find((ing) => ing.id === r.ingredient_id) ?? null })),
      availability_windows: ((itemAvailability.data ?? []) as AnyRow[]).filter((w) => w.menu_item_id === item.id),
      modifier_groups: itemGroupRows.filter((link) => link.menu_item_id === item.id).map((link) => ({
        ...link,
        group: groupRows.find((g) => g.id === link.modifier_group_id) ?? null,
        modifiers: modifierRows.filter((m) => m.modifier_group_id === link.modifier_group_id).map((m) => ({
          ...m,
          quantity_levels: quantityRows.filter((q) => q.modifier_id === m.id),
        })),
        size_rules: sizeRuleRows.filter((rule) => rule.menu_item_id === item.id && rule.modifier_group_id === link.modifier_group_id),
      })),
      combo_groups: comboGroupRows.filter((cg) => cg.combo_item_id === item.id).map((cg) => ({
        ...cg,
        options: comboOptionRows.filter((option) => option.combo_group_id === cg.id),
      })),
    }));

    const grouped = (categories ?? []).map((category) => ({
      ...category,
      menu_items: enrichedItems.filter((item) => item.category_id === category.id),
    }));

    return NextResponse.json({ restaurant, categories: grouped });
  } catch (error) {
    console.error("GET /api/menu", error);
    return NextResponse.json({ error: "Unable to load the menu." }, { status: 500 });
  }
}
