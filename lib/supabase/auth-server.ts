import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

export async function createAuthServerSupabase() {
  const cookieStore = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll() {
          // Session refresh is handled by middleware. Server components cannot safely
          // mutate response cookies here.
        },
      },
    }
  );
}
