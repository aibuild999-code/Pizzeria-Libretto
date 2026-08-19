export type SelectionAction = "add" | "remove";
export type SelectionSide = "whole" | "left" | "right";

export type WorkingSelection = {
  modifier_id: string;
  modifier_name: string;
  modifier_group_id: string;
  action: SelectionAction;
  quantity?: number;
  side?: SelectionSide;
  quantity_level_id?: string;
  notes?: string;
  target_ingredient_id?: string;
  replacement_ingredient_id?: string;
  substitutes_for_modifier_id?: string;
  substitutes_for_name?: string;
};

export type WorkingRequirement = {
  modifier_group_id: string;
  group_name: string;
  selection_type: "single" | "multiple";
  min_selections: number;
  max_selections: number | null;
};

export type WorkingLine = {
  line_id: string;
  menu_item_id: string;
  item_name: string;
  size_id?: string;
  size_name?: string;
  quantity: number;
  special_instructions?: string;
  selections: WorkingSelection[];
  requirements: WorkingRequirement[];
};

export type WorkingOrderState = {
  id: string;
  call_id: string;
  agent_id: string;
  restaurant_id: string;
  location_id: string;
  items: WorkingLine[];
  revision: number;
  quoted_revision: number | null;
  quote_token: string | null;
  quote_payload: Record<string, any> | null;
  quote_result: Record<string, any> | null;
  status: "building" | "quoted" | "creating" | "created" | "abandoned";
  created_order_id: string | null;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

export type ResolvedModifierChange =
  | { operation: "remove"; modifier_name: string; modifier_group_id?: string }
  | { operation: "add"; selection: WorkingSelection };

export function normalizeName(value: string) {
  return value.trim().toLowerCase();
}

export function appendLine(items: WorkingLine[], line: WorkingLine): WorkingLine[] {
  if (items.some((item) => item.line_id === line.line_id)) throw new Error("DUPLICATE_LINE_ID");
  return [...items, line];
}

function ruleFor(requirements: WorkingRequirement[], groupId: string) {
  return requirements.find((requirement) => requirement.modifier_group_id === groupId);
}

function validateSelectionLimits(selections: WorkingSelection[], requirements: WorkingRequirement[]) {
  for (const requirement of requirements) {
    const active = selections.filter((selection) =>
      selection.modifier_group_id === requirement.modifier_group_id && selection.action === "add",
    );
    if (requirement.max_selections !== null && active.length > requirement.max_selections) {
      throw new Error(`MODIFIER_SELECTION_LIMIT:${requirement.group_name}`);
    }
  }
}

export function applyModifierChanges(
  selections: WorkingSelection[],
  changes: ResolvedModifierChange[],
  requirements: WorkingRequirement[] = [],
): WorkingSelection[] {
  let next = [...selections];
  for (const change of changes) {
    if (change.operation === "remove") {
      const name = normalizeName(change.modifier_name);
      next = next.filter((selection) => {
        if (change.modifier_group_id && selection.modifier_group_id !== change.modifier_group_id) return true;
        return normalizeName(selection.modifier_name) !== name;
      });
      continue;
    }

    const selection = change.selection;
    const rule = ruleFor(requirements, selection.modifier_group_id);

    if (selection.substitutes_for_modifier_id || selection.substitutes_for_name) {
      next = next.filter((current) => {
        if (current.modifier_group_id !== selection.modifier_group_id) return true;
        if (selection.substitutes_for_modifier_id && current.modifier_id === selection.substitutes_for_modifier_id) return false;
        if (selection.substitutes_for_name && normalizeName(current.modifier_name) === normalizeName(selection.substitutes_for_name)) return false;
        return true;
      });
    }

    const sameModifier = (current: WorkingSelection) =>
      current.modifier_group_id === selection.modifier_group_id && current.modifier_id === selection.modifier_id;

    // Repeating or refining one topping should only replace that exact selection.
    // Single-choice groups replace the current group selection; multi-select groups preserve peers.
    if (rule?.selection_type === "single" || rule?.max_selections === 1) {
      next = next.filter((current) => current.modifier_group_id !== selection.modifier_group_id);
    } else {
      next = next.filter((current) => !sameModifier(current));
    }
    next.push(selection);
    validateSelectionLimits(next, requirements);
  }
  return next;
}

export function updateLine(
  items: WorkingLine[],
  lineId: string,
  patch: {
    quantity?: number;
    size_id?: string;
    size_name?: string;
    special_instructions?: string;
    modifier_changes?: ResolvedModifierChange[];
  },
): WorkingLine[] {
  const index = items.findIndex((item) => item.line_id === lineId);
  if (index < 0) throw new Error("LINE_ITEM_NOT_FOUND");
  const current = items[index];
  const next = [...items];
  next[index] = {
    ...current,
    quantity: patch.quantity ?? current.quantity,
    size_id: patch.size_id ?? current.size_id,
    size_name: patch.size_name ?? current.size_name,
    special_instructions: patch.special_instructions ?? current.special_instructions,
    selections: patch.modifier_changes
      ? applyModifierChanges(current.selections, patch.modifier_changes, current.requirements)
      : current.selections,
  };
  return next;
}

export function replaceLineItem(items: WorkingLine[], lineId: string, replacement: Omit<WorkingLine, "line_id">): WorkingLine[] {
  const index = items.findIndex((item) => item.line_id === lineId);
  if (index < 0) throw new Error("LINE_ITEM_NOT_FOUND");
  const next = [...items];
  next[index] = { line_id: lineId, ...replacement };
  return next;
}

export function removeLine(items: WorkingLine[], lineId: string): WorkingLine[] {
  const next = items.filter((item) => item.line_id !== lineId);
  if (next.length === items.length) throw new Error("LINE_ITEM_NOT_FOUND");
  return next;
}

export function lineReadiness(line: WorkingLine) {
  const problems = line.requirements
    .map((requirement) => {
      const count = line.selections.filter(
        (selection) => selection.modifier_group_id === requirement.modifier_group_id && selection.action === "add",
      ).length;
      if (count < requirement.min_selections) {
        return { ...requirement, selected: count, missing: requirement.min_selections - count, problem: "MIN_NOT_MET" as const };
      }
      if (requirement.max_selections !== null && count > requirement.max_selections) {
        return { ...requirement, selected: count, excess: count - requirement.max_selections, problem: "MAX_EXCEEDED" as const };
      }
      return null;
    })
    .filter(Boolean);
  return { ready: problems.length === 0, missing: problems };
}

export function orderReadiness(items: WorkingLine[]) {
  if (items.length === 0) return { ready: false, reason: "EMPTY_ORDER", pending: [] as unknown[] };
  const pending = items.flatMap((line) => {
    const result = lineReadiness(line);
    return result.ready ? [] : [{ line_id: line.line_id, item_name: line.item_name, missing: result.missing }];
  });
  return { ready: pending.length === 0, reason: pending.length ? "MISSING_REQUIRED_SELECTIONS" : null, pending };
}

export function invalidateQuote<T extends Pick<WorkingOrderState, "revision" | "status" | "quoted_revision" | "quote_token" | "quote_payload" | "quote_result">>(state: T) {
  return {
    ...state,
    revision: state.revision + 1,
    status: "building" as const,
    quoted_revision: null,
    quote_token: null,
    quote_payload: null,
    quote_result: null,
  };
}

export function quoteIsCurrent(state: Pick<WorkingOrderState, "revision" | "quoted_revision" | "quote_token" | "status">, token: string) {
  return state.status === "quoted" && state.quoted_revision === state.revision && state.quote_token === token;
}

export function callScopeKey(restaurantId: string, locationId: string, callId: string) {
  return `${restaurantId}:${locationId}:${callId}`;
}

export function toRpcItems(items: WorkingLine[]) {
  return items.map(({ menu_item_id, size_id, quantity, special_instructions, selections }) => ({
    menu_item_id,
    size_id,
    quantity,
    special_instructions,
    selections: selections.map(({ modifier_id, quantity: selectionQuantity, side, quantity_level_id, notes }) => ({
      modifier_id,
      quantity: selectionQuantity,
      side,
      quantity_level_id,
      notes,
    })),
  }));
}

export function applyOptimisticRevision<T extends { revision: number }>(current: T, expectedRevision: number, mutate: (value: T) => T) {
  if (current.revision !== expectedRevision) throw new Error("WORKING_ORDER_CONFLICT");
  return mutate(current);
}
