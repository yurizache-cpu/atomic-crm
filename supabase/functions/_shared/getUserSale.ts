import { createClient, type User } from "jsr:@supabase/supabase-js@2";

/**
 * Get the sale of the caller, read AS the caller: through the Data API with the
 * request's own token, so the row-security policy on `sales` decides, and that
 * policy answers only a session that holds multi-factor assurance (Production
 * Security Gate A.1). An account-management call at a lower level therefore
 * finds no sale and is refused, however valid the token is otherwise. The
 * service-role client is never used to decide who the caller is.
 */
export const getCallerSale = async (req: Request, user: User) => {
  const callerClient = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SB_PUBLISHABLE_KEY") ?? "",
    {
      global: {
        headers: { Authorization: req.headers.get("Authorization") ?? "" },
      },
      auth: { autoRefreshToken: false, persistSession: false },
    },
  );
  return (
    await callerClient.from("sales").select("*").eq("user_id", user.id).single()
  )?.data;
};
