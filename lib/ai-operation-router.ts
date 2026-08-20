const WORKING_ORDER_OPERATIONS = new Set([
  "order/state",
  "order/item/add",
  "order/item/update",
  "order/item/remove",
  "order/quote",
  "order/create",
]);

export function isWorkingOrderOperation(operation: string) {
  return WORKING_ORDER_OPERATIONS.has(operation);
}

export function classifyAiOperation(operation: string): "working-order" | "read-or-existing" {
  return isWorkingOrderOperation(operation) ? "working-order" : "read-or-existing";
}
