import { handleAiRequest } from "@/lib/ai";
import { handleWorkingOrderRequest } from "@/lib/working-order";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ operation: string[] }> }) {
  const { operation } = await context.params;
  const op = operation.join("/");

  // New-order calls use server-owned, call-scoped state. Menu reads and all
  // existing lookup/modify/cancel/reservation operations stay on the proven path.
  if (op === "order/state" || op === "order/item/add" || op === "order/item/update" || op === "order/item/remove" || op === "order/quote" || op === "order/create") {
    return handleWorkingOrderRequest(request, operation);
  }

  return handleAiRequest(request, operation);
}
