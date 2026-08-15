"use client";

import { useEffect, useMemo, useState } from "react";

type Modifier = {
  id: string;
  name: string;
  action: string;
  is_available: boolean;
};

type ModifierGroup = {
  name: string;
  modifiers: Modifier[];
};

type Size = { id: string; name: string; price: string | number; is_available: boolean };
type MenuItem = { id: string; name: string; sizes: Size[]; modifier_groups: ModifierGroup[] };

type MenuResponse = {
  categories: Array<{ menu_items: MenuItem[] }>;
};

function findItem(menu: MenuResponse, name: string) {
  return menu.categories.flatMap((category) => category.menu_items).find((item) => item.name === name);
}

function findModifier(item: MenuItem, groupName: string, modifierName: string) {
  return item.modifier_groups.find((group) => group.name === groupName)?.modifiers.find((modifier) => modifier.name === modifierName);
}

export default function TemporaryRealtimeOrderTest() {
  const [menu, setMenu] = useState<MenuResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/menu", { credentials: "include" })
      .then(async (response) => {
        if (!response.ok) throw new Error("Unable to load the authenticated menu.");
        return (await response.json()) as MenuResponse;
      })
      .then((data) => {
        if (active) setMenu(data);
      })
      .catch((err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Unable to load the menu.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const payload = useMemo(() => {
    if (!menu) return null;
    const item = findItem(menu, "Pepperoni Classic");
    if (!item) return null;

    const medium = item.sizes.find((size) => size.name === 'Medium 12"' && size.is_available);
    const small = item.sizes.find((size) => size.name === 'Small 10"' && size.is_available);
    const thin = findModifier(item, "Pizza Crust", "Thin");
    const classicCrust = findModifier(item, "Pizza Crust", "Classic");
    const plainEdge = findModifier(item, "Pizza Crust Edge", "Plain");
    const garlicSauce = findModifier(item, "Pizza Sauce", "Garlic white sauce");
    const classicSauce = findModifier(item, "Pizza Sauce", "Classic tomato");
    const extraCheese = findModifier(item, "Pizza Cheese", "Extra cheese");
    const regularCheese = findModifier(item, "Pizza Cheese", "Regular");
    const extraPepperoni = findModifier(item, "Pizza Toppings", "Extra pepperoni");
    const removeMozzarella = findModifier(item, "Remove Ingredients: Pepperoni Classic", "Mozzarella");

    if (!medium || !small || !thin || !classicCrust || !plainEdge || !garlicSauce || !classicSauce || !extraCheese || !regularCheese || !extraPepperoni || !removeMozzarella) {
      return null;
    }

    return {
      customer_name: "Realtime Test Customer",
      customer_phone: "416-555-0199",
      customer_email: "realtime-test@example.com",
      fulfillment_type: "pickup" as const,
      notes: "TEMPORARY REALTIME TEST ORDER — REMOVE AFTER VERIFICATION",
      items: [
        {
          menu_item_id: item.id,
          size_id: medium.id,
          quantity: 1,
          special_instructions: "Temporary realtime test: cut normally.",
          selections: [
            { modifier_id: thin.id },
            { modifier_id: plainEdge.id },
            { modifier_id: garlicSauce.id },
            { modifier_id: extraCheese.id },
            { modifier_id: removeMozzarella.id },
          ],
        },
        {
          menu_item_id: item.id,
          size_id: small.id,
          quantity: 2,
          special_instructions: "Temporary realtime test: second customized copy.",
          selections: [
            { modifier_id: classicCrust.id },
            { modifier_id: plainEdge.id },
            { modifier_id: classicSauce.id },
            { modifier_id: regularCheese.id },
            { modifier_id: extraPepperoni.id, quantity: 2 },
          ],
        },
      ],
    };
  }, [menu]);

  async function createTestOrder() {
    if (!payload) return;
    setCreating(true);
    setError(null);
    setResult(null);
    try {
      const response = await fetch("/api/orders", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(body?.error ?? "Order creation failed.");
      setResult(`Order #${body.order.order_number} created. ID: ${body.order.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Order creation failed.");
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-50 p-8 text-slate-900">
      <div className="mx-auto max-w-2xl rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
        <div className="mb-6">
          <p className="text-xs font-semibold uppercase tracking-wider text-blue-600">Temporary test only</p>
          <h1 className="mt-2 text-2xl font-semibold">Authenticated Realtime Order Test</h1>
          <p className="mt-2 text-sm leading-6 text-slate-600">
            This page is intentionally outside the dashboard navigation and uses the existing protected POST /api/orders endpoint. It should be removed immediately after the realtime test is complete.
          </p>
        </div>

        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm">
          <p><strong>Test customer:</strong> Realtime Test Customer</p>
          <p><strong>Fulfillment:</strong> Pickup</p>
          <p><strong>Items:</strong> 1 medium Pepperoni Classic + 2 small Pepperoni Classics</p>
          <p><strong>Customizations:</strong> required crust/edge/sauce/cheese, paid sauce/cheese, ingredient removal, modifier quantity</p>
        </div>

        {loading && <p className="mt-6 text-sm text-slate-600">Loading the authenticated menu…</p>}
        {!loading && !payload && <p className="mt-6 rounded-lg bg-red-50 p-4 text-sm text-red-700">The expected test menu configuration was not found. No order was created.</p>}
        {error && <p className="mt-6 rounded-lg bg-red-50 p-4 text-sm text-red-700">{error}</p>}
        {result && <p className="mt-6 rounded-lg bg-emerald-50 p-4 text-sm text-emerald-700">{result}</p>}

        <button
          type="button"
          onClick={createTestOrder}
          disabled={!payload || creating || Boolean(result)}
          className="mt-6 w-full rounded-xl bg-blue-600 px-5 py-3 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {creating ? "Creating real test order…" : result ? "Test order created" : "Create real test order"}
        </button>
      </div>
    </main>
  );
}
