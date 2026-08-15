import { createServerSupabase } from "@/lib/supabase/server";

export default async function RestaurantPage() {
  const supabase = createServerSupabase();
  const [{ data: restaurant }, { data: location }, { data: hours }] = await Promise.all([
    supabase.from("restaurants").select("*").limit(1).single(),
    supabase.from("restaurant_locations").select("*").eq("is_active", true).limit(1).single(),
    supabase.from("restaurant_hours").select("*").order("day_of_week"),
  ]);
  const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  return <div><div className="mb-8"><p className="text-sm font-medium text-slate-500">Restaurant</p><h1 className="mt-1 text-3xl font-bold">{restaurant?.name ?? "Restaurant"}</h1></div><div className="grid gap-6 lg:grid-cols-2"><div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="font-semibold">Location</h2><div className="mt-4 space-y-2 text-sm text-slate-600"><p>{location?.name}</p><p>{location?.address_line1}</p><p>{location?.city}, {location?.province} {location?.postal_code}</p><p>{location?.phone ?? restaurant?.phone ?? "No phone configured"}</p></div></div><div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm"><h2 className="font-semibold">Hours</h2><div className="mt-4 space-y-2 text-sm">{hours?.map((h) => <div key={h.id} className="flex justify-between border-b border-slate-100 py-2"><span>{days[h.day_of_week]}</span><span className="text-slate-500">{h.is_closed ? "Closed" : `${h.opens_at?.slice(0,5)} – ${h.closes_at?.slice(0,5)}`}</span></div>)}</div></div></div></div>;
}
