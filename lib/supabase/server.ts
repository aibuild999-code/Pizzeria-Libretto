import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/types/database";

function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

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
    },
  });
}
