import "./globals.css";
import { DashboardShell } from "@/components/dashboard-shell";
import { createServerSupabase } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

export async function generateMetadata() {
  const supabase = createServerSupabase();
  const { data: restaurant } = await supabase.from("restaurants").select("name").limit(1).single();
  const name = restaurant?.name ?? "Restaurant";
  return { title: `${name} | Operations`, description: `${name} restaurant operations dashboard` };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) { return <html lang="en"><body><DashboardShell>{children}</DashboardShell></body></html>; }
