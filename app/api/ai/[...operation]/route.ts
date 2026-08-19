import { handleAiRequest } from "@/lib/ai";
import { isWorkingOrderOperation } from "@/lib/ai-operation-router";
import { handleMenuAvailabilityV2 } from "@/lib/menu-availability-v2";
import { handleWorkingOrderRequestV2 } from "@/lib/working-order-v2";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, context: { params: Promise<{ operation: string[] }> }) {
  const { operation } = await context.params;
  const op = operation.join("/");

  if (op === "menu/availability") return handleMenuAvailabilityV2(request);
  if (isWorkingOrderOperation(op)) return handleWorkingOrderRequestV2(request, operation);
  return handleAiRequest(request, operation);
}
