"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, BarChart3, BellRing, Bot, CalendarDays, ClipboardList, Gauge, Settings, Store, Truck, UtensilsCrossed } from "lucide-react";

const items = [["Overview", "/", Gauge],["Attention Required", "/attention", BellRing],["Orders", "/orders", ClipboardList],["Reservations", "/reservations", CalendarDays],["Menu", "/menu", UtensilsCrossed],["Delivery", "/delivery", Truck],["AI Calls", "/ai-calls", Bot],["Analytics", "/analytics", BarChart3],["Restaurant", "/restaurant", Store],["Settings", "/settings", Settings]] as const;

export function Sidebar({ restaurantName }: { restaurantName: string }) {
  const pathname = usePathname();
  return <aside className="hidden w-64 shrink-0 border-r border-slate-200 bg-white md:flex"><div className="sticky top-0 flex h-screen w-full flex-col"><div className="border-b border-slate-200 px-5 py-5"><div className="flex items-center gap-3"><img src="/junction-kitchen.svg" alt="The Junction Kitchen" className="h-11 w-11 rounded-xl object-cover"/><div className="min-w-0"><div className="truncate text-sm font-bold text-slate-950">{restaurantName}</div><div className="mt-0.5 text-xs text-slate-500">AI restaurant operations</div></div></div></div><nav className="flex-1 space-y-1 overflow-y-auto p-3">{items.map(([label, href, Icon])=>{const active=href==="/"?pathname===href:pathname.startsWith(href);return <Link key={href} href={href} className={`flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition ${active?"bg-blue-600 text-white shadow-sm":"text-slate-600 hover:bg-slate-50 hover:text-slate-950"}`}><Icon size={18} strokeWidth={1.9}/>{label}</Link>})}</nav><div className="border-t border-slate-200 p-4"><div className="flex items-center gap-2 text-xs text-slate-500"><Activity size={14} className="text-emerald-500"/>Live data connected</div><div className="mt-1 text-[11px] text-slate-400">Supabase operations</div></div></div></aside>;
}
