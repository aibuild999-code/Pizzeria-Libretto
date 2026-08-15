import { createServerSupabase } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";

export async function DashboardShell({ children }: { children: React.ReactNode }) {
  const supabase=createServerSupabase();
  const {data:restaurant}=await supabase.from("restaurants").select("name,logo_url").limit(1).single();
  const restaurantName=restaurant?.name??"Restaurant";
  return <div className="min-h-screen bg-slate-50 md:flex"><Sidebar restaurantName={restaurantName}/><main className="min-w-0 flex-1"><header className="sticky top-0 z-20 flex min-h-16 items-center justify-between border-b border-slate-200 bg-white/95 px-5 backdrop-blur md:px-8"><div className="flex items-center gap-3"><img src={restaurant?.logo_url||"/junction-kitchen.svg"} alt="" className="h-8 w-8 rounded-lg object-cover"/><div><div className="text-sm font-semibold text-slate-950">{restaurantName}</div><div className="text-xs text-slate-500">Restaurant operations</div></div></div><div className="hidden items-center gap-2 text-xs text-slate-500 sm:flex"><span className="h-2 w-2 rounded-full bg-emerald-500"/>Live workspace</div></header><div className="relative overflow-hidden p-5 md:p-8"><div className="pointer-events-none absolute right-10 top-10 opacity-[0.025]"><img src="/junction-kitchen.svg" alt="" className="w-80"/></div><div className="relative">{children}</div></div></main></div>;
}
