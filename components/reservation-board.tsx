"use client";
import { useMemo, useState } from "react";

type Reservation = { id: string; reservation_number: number; customer_id: string | null; customer_name: string; customer_phone: string; customer_email: string | null; party_size: number; requested_date: string; requested_time: string; status: string; proposed_date: string | null; proposed_time: string | null; customer_notes: string | null; staff_notes: string | null; source: string; created_at: string };
const next: Record<string, string[]> = { pending: ["confirmed", "alternative_proposed", "declined", "cancelled"], confirmed: ["completed", "cancelled"], alternative_proposed: ["confirmed", "declined", "cancelled"], declined: [], completed: [], cancelled: [] };
const tabs = ["all", "pending", "confirmed", "alternative_proposed", "completed", "cancelled"];

export function ReservationBoard({ initial }: { initial: Reservation[] }) {
  const [rows, setRows] = useState(initial);
  const [tab, setTab] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const visible = useMemo(() => tab === "all" ? rows : rows.filter(r => r.status === tab), [rows, tab]);
  async function update(id: string, status: string) {
    setBusy(id);
    try {
      const r = await fetch(`/api/reservations/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ status }) });
      const b = await r.json(); if (!r.ok) throw new Error(b.error || "Update failed");
      setRows(v => v.map(x => x.id === id ? b.reservation : x));
    } catch (e) { alert(e instanceof Error ? e.message : "Update failed"); }
    finally { setBusy(null); }
  }
  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm">{tabs.map(t => <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-2 text-xs font-semibold capitalize ${tab === t ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{t.replace("_", " ")}</button>)}</div>
    {visible.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-14 text-center"><h2 className="font-semibold">No {tab === "all" ? "reservations" : tab.replace("_", " ")} yet</h2><p className="mt-1 text-sm text-slate-500">Real reservation requests will appear here.</p></div> : visible.map(r => <article key={r.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm"><div className="flex flex-wrap justify-between gap-4"><div><div className="flex items-center gap-3"><h2 className="font-semibold">Reservation #{r.reservation_number}</h2><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium capitalize">{r.status.replace("_", " ")}</span></div><p className="mt-1 text-sm text-slate-500">{r.customer_name} · {r.customer_phone}{r.customer_email ? ` · ${r.customer_email}` : ""} · party of {r.party_size}</p></div><div className="text-right"><div className="font-semibold">{r.requested_date} at {r.requested_time.slice(0, 5)}</div><div className="text-xs text-slate-400">Source: {r.source}</div></div></div>{r.customer_notes && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{r.customer_notes}</p>}{r.proposed_date && <p className="mt-3 rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-800">Alternative proposed: {r.proposed_date} at {r.proposed_time?.slice(0, 5)}</p>}<div className="mt-4 flex flex-wrap gap-2">{next[r.status]?.map(s => <button key={s} disabled={busy === r.id} onClick={() => update(r.id, s)} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold capitalize hover:bg-slate-50 disabled:opacity-50">{busy === r.id ? "Updating…" : s.replace("_", " ")}</button>)}</div></article>)}
  </div>;
}
