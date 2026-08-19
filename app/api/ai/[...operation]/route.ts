import { handleAiRequest } from "@/lib/ai";
import { handleWorkingOrderRequestV2 } from "@/lib/working-order-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ operation: string[] }> }) {
  const { operation } = await context.params;
  const op = operation.join("/");

  // Browse/info remains on the existing read-only implementation. Only explicit
  // new-order state operations use call-scoped authoritative working state.
  if (op === "order/state" || op === "order/item/add" || op === "order/item/update" || op === "order/item/remove" || op === "order/quote" || op === "order/create") {
    return handleWorkingOrderRequestV2(request, operation);
  }

  return handleAiRequest(request, operation);
}
