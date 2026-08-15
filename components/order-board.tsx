"use client";
import { useMemo, useState } from "react";

type Sel = { id: string; selection_name: string | null; quantity: number; unit_price_delta: number | string; total_price_delta: number | string; action: string | null; side: string | null; notes: string | null };
type Item = { id: string; item_name: string; quantity: number; unit_price: number | string; line_total: number | string; special_instructions: string | null; menu_item_size_id: string | null; order_item_selections: Sel[] };
type Order = { id: string; order_number: number; customer_name: string; customer_phone: string; customer_email: string | null; fulfillment_type: string; status: string; approval_required: boolean; approval_reason: string | null; notes: string | null; subtotal: number | string; tax: number | string; delivery_fee: number | string; total: number | string; created_at: string; scheduled_for: string | null; order_items: Item[] };

const next: Record<string, string[]> = { pending: ["preparing", "cancelled"], preparing: ["ready", "cancelled"], ready: ["completed", "cancelled"], completed: [], cancelled: [] };
const label: Record<string, string> = { pending: "New", preparing: "Preparing", ready: "Ready", completed: "Completed", cancelled: "Cancelled" };
const tabs = ["all", "pending", "preparing", "ready", "completed", "cancelled"];

export function OrderBoard({ initial }: { initial: Order[] }) {
  const [orders, setOrders] = useState(initial);
  const [tab, setTab] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const visible = useMemo(() => tab === "all" ? orders : orders.filter(o => o.status === tab), [orders, tab]);

  async function mutate(id: string, payload: { status?: string; action?: "approve" | "reject"; reason?: string }) {
    setBusy(id);
    try {
      const r = await fetch(`/api/orders/${id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || "Update failed");
      setOrders(v => v.map(o => o.id === id ? body.order : o));
    } catch (e) { alert(e instanceof Error ? e.message : "Update failed"); }
    finally { setBusy(null); }
  }

  return <div className="space-y-4">
    <div className="flex flex-wrap gap-2 rounded-xl border border-slate-200 bg-white p-2 shadow-sm">{tabs.map(t => <button key={t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-2 text-xs font-semibold capitalize ${tab === t ? "bg-blue-600 text-white" : "text-slate-600 hover:bg-slate-50"}`}>{t === "all" ? "All" : label[t] ?? t}</button>)}</div>
    {visible.length === 0 ? <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-14 text-center"><h2 className="font-semibold">No {tab === "all" ? "orders" : (label[tab] ?? tab).toLowerCase() + " orders"} yet</h2><p className="mt-1 text-sm text-slate-500">Real orders will appear here when they are created.</p></div> : visible.map(o => <article key={o.id} className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      {o.approval_required && o.status === "pending" && <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 p-4"><div className="font-semibold text-amber-900">Human approval required</div><p className="mt-1 text-sm text-amber-800">{o.approval_reason || "This order requires staff approval."}</p><div className="mt-3 flex flex-wrap gap-2"><button disabled={busy === o.id} onClick={() => mutate(o.id, { action: "approve" })} className="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white disabled:opacity-50">{busy === o.id ? "Updating…" : "Approve order"}</button><button disabled={busy === o.id} onClick={() => mutate(o.id, { action: "reject", reason: "Rejected by staff" })} className="rounded-lg border border-amber-300 px-3 py-2 text-xs font-semibold text-amber-900 disabled:opacity-50">Reject order</button></div></div>}
      <div className="flex flex-wrap items-start justify-between gap-4"><div><div className="flex items-center gap-3"><h2 className="font-semibold">Order #{o.order_number}</h2><span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium">{label[o.status] ?? o.status}</span></div><p className="mt-1 text-sm text-slate-500">{o.customer_name} · {o.customer_phone}{o.customer_email ? ` · ${o.customer_email}` : ""} · {o.fulfillment_type.replace("_", " ")}{o.scheduled_for ? ` · Scheduled ${new Date(o.scheduled_for).toLocaleString()}` : ""}</p></div><div className="text-right"><div className="text-lg font-bold">${Number(o.total).toFixed(2)}</div><div className="text-xs text-slate-400">{new Date(o.created_at).toLocaleString()}</div></div></div>
      <div className="mt-4 divide-y divide-slate-100 rounded-xl border border-slate-100">{o.order_items?.map(i => <div key={i.id} className="px-4 py-4"><div className="flex justify-between gap-4 text-sm"><span className="font-medium">{i.quantity} × {i.item_name}</span><span className="font-semibold">${Number(i.line_total).toFixed(2)}</span></div>{i.order_item_selections?.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{i.order_item_selections.map(s => <span key={s.id} className="rounded-md bg-slate-100 px-2 py-1 text-[11px] text-slate-600">{s.action ? `${s.action}: ` : ""}{s.selection_name}{s.quantity > 1 ? ` ×${s.quantity}` : ""}{s.side ? ` · ${s.side}` : ""}</span>)}</div>}{i.special_instructions && <div className="mt-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Special instructions: {i.special_instructions}</div>}</div>)}</div>
      <div className="mt-4 flex flex-wrap items-center justify-between gap-3"><div className="text-xs text-slate-500">Subtotal ${Number(o.subtotal).toFixed(2)} · Tax ${Number(o.tax).toFixed(2)} · Delivery ${Number(o.delivery_fee || 0).toFixed(2)}</div><div className="flex flex-wrap gap-2">{!o.approval_required && next[o.status]?.map(s => <button key={s} disabled={busy === o.id} onClick={() => mutate(o.id, { status: s })} className="rounded-lg border border-slate-200 px-3 py-2 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50">{busy === o.id ? "Updating…" : `Mark ${label[s]}`}</button>)}</div></div>
      {o.notes && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">Order note: {o.notes}</p>}
    </article>)}
  </div>;
}
