import { NextResponse } from "next/server";
import { z } from "zod";
import { createServerSupabase } from "@/lib/supabase/server";

const schema = z.object({ status: z.enum(["pending", "preparing", "ready", "completed", "cancelled"]) });
const transitions: Record<string, string[]> = { pending: ["preparing", "cancelled"], preparing: ["ready", "cancelled"], ready: ["completed", "cancelled"], completed: [], cancelled: [] };

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "Invalid order id." }, { status: 400 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    const supabase = createServerSupabase();
    const { data: order, error: findError } = await supabase.from("orders").select("id,status,restaurant_id,location_id").eq("id", id).limit(1).single();
    if (findError || !order) return NextResponse.json({ error: "Order not found." }, { status: 404 });
    if (!transitions[order.status]?.includes(parsed.data.status)) return NextResponse.json({ error: `Cannot move order from ${order.status} to ${parsed.data.status}.` }, { status: 409 });
    const update: Record<string, string> = { status: parsed.data.status, updated_at: new Date().toISOString() };
    if (parsed.data.status === "completed") update.completed_at = new Date().toISOString();
    const { data, error } = await supabase.from("orders").update(update).eq("id", id).eq("restaurant_id", order.restaurant_id).eq("location_id", order.location_id).select("*, order_items(*)").single();
    if (error) throw error;
    return NextResponse.json({ order: data });
  } catch (error) {
    console.error("PATCH /api/orders/[id]", error);
    return NextResponse.json({ error: "Unable to update order." }, { status: 500 });
  }
}
