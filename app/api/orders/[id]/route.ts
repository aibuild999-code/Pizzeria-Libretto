import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

const schema = z.object({
  status: z.enum(["pending", "preparing", "ready", "completed", "cancelled"]).optional(),
  action: z.enum(["approve", "reject"]).optional(),
  reason: z.string().max(500).optional(),
}).refine((value) => Boolean(value.action || value.status), { message: "A status or action is required." });

const transitions: Record<string, string[]> = {
  pending: ["preparing", "cancelled"],
  preparing: ["ready", "cancelled"],
  ready: ["completed", "cancelled"],
  completed: [],
  cancelled: [],
};

type Scope = { id: string; status: string; restaurant_id: string; location_id: string; approval_required: boolean };
type Update = { status: string; updated_at: string; completed_at?: string };

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid order id." }, { status: 400 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid order action.", details: parsed.error.flatten() }, { status: 400 });

    const s = createServerSupabase();
    const { data: raw, error: findError } = await s.from("orders").select("id,status,restaurant_id,location_id,approval_required").eq("id", id).limit(1).single();
    if (findError || !raw) return NextResponse.json({ error: "Order not found." }, { status: 404 });
    const order = raw as Scope;

    if (parsed.data.action === "approve") {
      if (!order.approval_required || order.status !== "pending") return NextResponse.json({ error: "Order is not awaiting approval." }, { status: 409 });
      const { data: approved, error } = await s.rpc("approve_order", { p_order_id: id });
      if (error) throw error;
      return NextResponse.json({ order: approved });
    }

    if (parsed.data.action === "reject") {
      if (!order.approval_required || order.status !== "pending") return NextResponse.json({ error: "Order is not awaiting approval." }, { status: 409 });
      const { data: rejected, error } = await s.rpc("reject_order", { p_order_id: id, p_reason: parsed.data.reason ?? null });
      if (error) throw error;
      return NextResponse.json({ order: rejected });
    }

    const nextStatus = parsed.data.status!;
    if (order.approval_required && order.status === "pending") return NextResponse.json({ error: "Order requires staff approval before status changes." }, { status: 409 });
    if (!transitions[order.status]?.includes(nextStatus)) return NextResponse.json({ error: `Cannot move order from ${order.status} to ${nextStatus}.` }, { status: 409 });

    const update: Update = { status: nextStatus, updated_at: new Date().toISOString() };
    if (nextStatus === "completed") update.completed_at = new Date().toISOString();
    const { data: updated, error } = await s.from("orders").update(update).eq("id", id).eq("restaurant_id", order.restaurant_id).eq("location_id", order.location_id).select("*").single();
    if (error) throw error;
    const { data: items, error: itemError } = await s.from("order_items").select("*,order_item_selections(*)").eq("order_id", id);
    if (itemError) throw itemError;
    return NextResponse.json({ order: { ...updated, order_items: items ?? [] } });
  } catch (error) {
    console.error("PATCH /api/orders/[id]", error);
    return NextResponse.json({ error: "Unable to update order." }, { status: 500 });
  }
}
