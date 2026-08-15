import { Sidebar } from "@/components/sidebar";

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-slate-50 md:flex"><Sidebar/><main className="min-w-0 flex-1"><header className="flex h-16 items-center border-b border-slate-200 bg-white px-5 md:px-8"><div><div className="text-sm font-semibold text-slate-950">Pizzeria Libretto</div><div className="text-xs text-slate-500">Operations dashboard</div></div></header><div className="p-5 md:p-8">{children}</div></main></div>;
}
