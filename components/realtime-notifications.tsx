"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BellRing } from "lucide-react";
import { createBrowserSupabase } from "@/lib/supabase/browser";

function playTone(kind: "order" | "reservation" | "attention") {
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return;

  const context = new AudioContextCtor();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const now = context.currentTime;
  const frequencies = kind === "attention" ? [660, 520] : kind === "reservation" ? [520, 660] : [440, 660];

  oscillator.type = "sine";
  oscillator.frequency.setValueAtTime(frequencies[0], now);
  oscillator.frequency.setValueAtTime(frequencies[1], now + 0.09);
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(0.045, now + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.22);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(now);
  oscillator.stop(now + 0.23);
  oscillator.addEventListener("ended", () => void context.close());
}

async function notify(title: string, body: string) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  new Notification(title, { body });
}

export function RealtimeNotifications({ restaurantId }: { restaurantId: string }) {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission | "unsupported">("default");
  const audioEnabled = useRef(false);

  useEffect(() => {
    if (typeof Notification !== "undefined") setPermission(Notification.permission);
    setEnabled(window.localStorage.getItem("junction-notifications-enabled") === "true");
  }, []);

  useEffect(() => {
    const supabase = createBrowserSupabase();

    const orderChannel = supabase
      .channel(`dashboard-orders-${restaurantId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "orders", filter: `restaurant_id=eq.${restaurantId}` }, async (payload) => {
        const order = payload.new as { order_number?: number; customer_name?: string; approval_required?: boolean };
        const attention = order.approval_required === true;
        const title = attention ? "Approval required" : "New order";
        const body = attention
          ? `Order #${order.order_number ?? "—"} from ${order.customer_name ?? "customer"} needs review.`
          : `Order #${order.order_number ?? "—"} from ${order.customer_name ?? "customer"} has arrived.`;
        if (audioEnabled.current) playTone(attention ? "attention" : "order");
        await notify(title, body);
        router.refresh();
      })
      .subscribe();

    const reservationChannel = supabase
      .channel(`dashboard-reservations-${restaurantId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "reservations", filter: `restaurant_id=eq.${restaurantId}` }, async (payload) => {
        const reservation = payload.new as { reservation_number?: number; customer_name?: string; party_size?: number; status?: string };
        if (reservation.status && reservation.status !== "pending") return;
        const body = `Party of ${reservation.party_size ?? "—"} for ${reservation.customer_name ?? "customer"} is waiting for review.`;
        if (audioEnabled.current) playTone("reservation");
        await notify("Reservation request", body);
        router.refresh();
      })
      .subscribe();

    return () => {
      void supabase.removeChannel(orderChannel);
      void supabase.removeChannel(reservationChannel);
    };
  }, [restaurantId, router]);

  async function enableNotifications() {
    if (typeof Notification !== "undefined") {
      const result = await Notification.requestPermission();
      setPermission(result);
    } else {
      setPermission("unsupported");
    }

    try {
      playTone("order");
      audioEnabled.current = true;
    } catch {
      audioEnabled.current = false;
    }

    window.localStorage.setItem("junction-notifications-enabled", "true");
    setEnabled(true);
  }

  if (enabled && (permission === "granted" || permission === "unsupported")) return null;

  return (
    <button onClick={enableNotifications} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-semibold text-slate-700 shadow-sm transition hover:border-blue-200 hover:text-blue-700">
      <BellRing size={15} />
      Enable notifications
    </button>
  );
}
