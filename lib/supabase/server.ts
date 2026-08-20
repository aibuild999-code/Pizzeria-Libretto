import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

const machineFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init);
  if (process.env.CI && !response.ok) {
    let body = "";
    try { body = await response.clone().text(); } catch { body = "<unreadable>"; }
    const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    let safeTarget = rawUrl;
    try {
      const parsed = new URL(rawUrl);
      safeTarget = `${parsed.origin}${parsed.pathname}${parsed.search}`;
    } catch {}
    console.error(`[MACHINE_SUPABASE] ${init?.method ?? "GET"} ${safeTarget} -> ${response.status} ${body}`);
  }
  return response;
};

/**
 * Privileged server-only Supabase client for machine-to-machine backend work.
 *
 * Retell requests must never inherit browser cookies/user sessions. The
 * service-role/secret credential is therefore supplied explicitly as both the
 * client API key and Authorization bearer token, matching Supabase's guidance
 * for isolated administrative/server clients.
 */
export function createServerSupabase() {
  const url = process.env.SUPABASE_URL || required("NEXT_PUBLIC_SUPABASE_URL");
  const serviceKey = required("SUPABASE_SERVICE_ROLE_KEY");

  if (process.env.CI) {
    const keyKind = serviceKey.startsWith("eyJ") ? "jwt" : serviceKey.startsWith("sb_") ? "opaque" : "other";
    console.info(`[MACHINE_SUPABASE_CLIENT] url=${url} key_kind=${keyKind}`);
  }

  return createClient<Database>(url, serviceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${serviceKey}`,
      },
      fetch: machineFetch,
    },
  });
}
