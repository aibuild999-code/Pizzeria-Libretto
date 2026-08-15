import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

type Category = { id: string; name: string; display_order: number; is_active: boolean };
type MenuItem = { id: string; category_id: string; name: string; description: string | null; price: number | string; dietary_tags: string[]; is_available: boolean; display_order: number; image_url: string | null };

export default async function MenuPage() {
  const supabase = createServerSupabase();
  const { data: rawCategories, error: categoryError } = await supabase.from("menu_categories").select("id,name,display_order,is_active").eq("is_active", true).order("display_order");
  if (categoryError) throw new Error("Unable to load the live menu.");
  const categories = (rawCategories ?? []) as Category[];
  const categoryIds = categories.map((category) => category.id);
  const { data: rawItems, error: itemError } = categoryIds.length ? await supabase.from("menu_items").select("id,category_id,name,description,price,dietary_tags,is_available,display_order,image_url").in("category_id", categoryIds).order("display_order") : { data: [], error: null };
  if (itemError) throw new Error("Unable to load the live menu.");
  const items = (rawItems ?? []) as MenuItem[];
  return <div><div className="mb-8"><p className="text-sm font-medium text-slate-500">Menu</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Live menu</h1><p className="mt-2 text-slate-500">Pulled directly from Supabase. Nothing is hardcoded.</p></div>{categories.length ? <div className="space-y-6">{categories.map((category) => { const categoryItems = items.filter((item) => item.category_id === category.id).sort((a,b) => a.display_order-b.display_order); return <section key={category.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm"><div className="border-b border-slate-200 px-5 py-4"><h2 className="font-semibold">{category.name}</h2></div><div className="divide-y divide-slate-100">{categoryItems.length ? categoryItems.map((item) => <div key={item.id} className="flex items-start justify-between gap-6 px-5 py-4"><div><div className="flex items-center gap-2"><h3 className="font-medium">{item.name}</h3><span className={`rounded-full px-2 py-0.5 text-xs ${item.is_available ? "bg-emerald-50 text-emerald-700" : "bg-slate-100 text-slate-500"}`}>{item.is_available ? "Available" : "Unavailable"}</span></div>{item.description && <p className="mt-1 max-w-2xl text-sm text-slate-500">{item.description}</p>}</div><div className="shrink-0 font-semibold">${Number(item.price).toFixed(2)}</div></div>) : <div className="px-5 py-8 text-sm text-slate-500">No menu items in this category.</div>}</div></section>; })}</div> : <div className="rounded-xl border border-dashed border-slate-300 bg-white p-12 text-center"><h2 className="font-semibold">No menu categories</h2><p className="mt-2 text-sm text-slate-500">No active menu categories are currently available.</p></div>}</div>;
}
