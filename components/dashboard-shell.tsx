import { createServerSupabase } from "@/lib/supabase/server";
import { Sidebar } from "@/components/sidebar";

export async function DashboardShell({ children }: { children: React.ReactNode }) {
  const supabase = createServerSupabase();
  const { data: restaurant } = await supabase.from("restaurants").select("name").limit(1).single();
  const restaurantName = restaurant?.name ?? "Restaurant";

  return <div className="min-h-screen bg-slate-50 md:flex"><Sidebar restaurantName={restaurantName}/><main className="min-w-0 flex-1"><header className="flex h-16 items-center border-b border-slate-200 bg-white px-5 md:px-8"><div><div className="text-sm font-semibold text-slate-950">{restaurantName}</div><div className="text-xs text-slate-500">Operations dashboard</div></div></header><div className="p-5 md:p-8">{children}</div></main></div>;
}
