"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BarChart3, Bot, CalendarDays, ClipboardList, Settings, Store, UtensilsCrossed } from "lucide-react";

const items = [
  ["Overview", "/", BarChart3], ["Orders", "/orders", ClipboardList], ["Reservations", "/reservations", CalendarDays], ["Menu", "/menu", UtensilsCrossed], ["Restaurant", "/restaurant", Store], ["AI Receptionist", "/ai-receptionist", Bot], ["Settings", "/settings", Settings],
] as const;

export function Sidebar({ restaurantName }: { restaurantName: string }) {
  const pathname = usePathname();
  return <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white md:block"><div className="flex h-full flex-col"><div className="border-b border-slate-200 px-6 py-5"><div className="text-lg font-bold tracking-tight text-slate-950">{restaurantName}</div><div className="mt-1 text-xs text-slate-500">Restaurant Operations</div></div><nav className="flex-1 space-y-1 p-3">{items.map(([label, href, Icon]) => { const active = href === "/" ? pathname === href : pathname.startsWith(href); return <Link key={href} href={href} className={`flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${active ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"}`}><Icon size={18}/>{label}</Link>; })}</nav><div className="border-t border-slate-200 p-4 text-xs text-slate-400">Live data • Supabase</div></div></aside>;
}
