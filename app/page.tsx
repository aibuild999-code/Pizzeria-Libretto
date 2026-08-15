import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

const cards = [
  ["New orders", "pending", "orders"], ["Preparing", "preparing", "orders"], ["Ready", "ready", "orders"], ["Completed", "completed", "orders"], ["Pending reservations", "pending", "reservations"], ["Confirmed reservations", "confirmed", "reservations"],
];

export default async function OverviewPage() {
  const supabase = createServerSupabase();
  const [{ count: pending }, { count: preparing }, { count: ready }, { count: completed }, { count: pendingRes }, { count: confirmedRes }, { data: restaurant }] = await Promise.all([
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "preparing"),
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "ready"),
    supabase.from("orders").select("id", { count: "exact", head: true }).eq("status", "completed"),
    supabase.from("reservations").select("id", { count: "exact", head: true }).eq("status", "pending"),
    supabase.from("reservations").select("id", { count: "exact", head: true }).eq("status", "confirmed"),
    supabase.from("restaurants").select("name").limit(1).single(),
  ]);
  const values = [pending, preparing, ready, completed, pendingRes, confirmedRes];
  return <div><div className="mb-8"><p className="text-sm font-medium text-slate-500">Overview</p><h1 className="mt-1 text-3xl font-bold tracking-tight">Good to see you.</h1><p className="mt-2 text-slate-500">Live operations for {restaurant?.name ?? "Restaurant"}.</p></div><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">{cards.map(([label], i) => <div key={label} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm"><p className="text-sm font-medium text-slate-500">{label}</p><p className="mt-3 text-3xl font-bold">{values[i] ?? 0}</p><p className="mt-1 text-xs text-slate-400">Live database count</p></div>)}</div><div className="mt-6 rounded-xl border border-slate-200 bg-white p-6"><h2 className="font-semibold">Restaurant status</h2><div className="mt-4 flex items-center gap-3"><span className="h-2.5 w-2.5 rounded-full bg-emerald-500"/><span className="text-sm text-slate-700">Configured and connected to Supabase</span></div></div></div>;
}
