import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { AuthMiddleware, UserMiddleware } from "../_shared/authentication.ts";
import { getUserSale } from "../_shared/getUserSale.ts";
import {
  inviteUser,
  patchUser,
  type Outcome,
  type SaleRecord,
  type UserManagementPorts,
} from "./userManagement.ts";

// The authorization rules and their order live in userManagement.ts (Phase 2C
// S7); this file only adapts them to the Auth admin API and the sales table.

const firstSale = (rows: SaleRecord[] | null) => rows?.at(0) ?? null;

const ports: UserManagementPorts = {
  async findSaleById(id) {
    const { data } = await supabaseAdmin
      .from("sales")
      .select("*")
      .eq("id", id)
      .maybeSingle();
    return data ?? null;
  },
  async findSaleByUserId(userId) {
    const { data } = await supabaseAdmin
      .from("sales")
      .select("*")
      .eq("user_id", userId)
      .maybeSingle();
    return data ?? null;
  },
  async updateAuthUser(userId, attributes) {
    const { data, error } = await supabaseAdmin.auth.admin.updateUserById(
      userId,
      attributes,
    );
    if (error || !data?.user) console.error("Error patching user:", error);
    return { ok: !error && !!data?.user };
  },
  async updateSale(userId, patch) {
    const { data, error } = await supabaseAdmin
      .from("sales")
      .update(patch)
      .eq("user_id", userId)
      .select("*");
    if (error) console.error("Error updating sale:", error);
    return error ? null : firstSale(data);
  },
  async createAuthUser(email, metadata) {
    const { data, error } = await supabaseAdmin.auth.admin.createUser({
      email,
      user_metadata: metadata,
    });
    if (error || !data?.user) {
      if (error?.code !== "email_exists") {
        console.error("Error inviting user:", error);
      }
      return { error: error?.code ?? "no_user" };
    }
    return { userId: data.user.id };
  },
  async findAuthUserIdByEmail(email) {
    const { data, error } = await supabaseAdmin.rpc("get_user_id_by_email", {
      email,
    });
    if (error) console.error("Error finding user by email:", error);
    return (!error && data?.[0]?.id) || null;
  },
  async insertSale(record) {
    const { data, error } = await supabaseAdmin
      .from("sales")
      .insert(record)
      .select("*");
    if (error) console.error("Error creating sale:", error);
    return error ? null : firstSale(data);
  },
  async inviteUserByEmail(email) {
    const { error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email);
    if (error) console.error("Error sending the invitation:", error);
    return { ok: !error };
  },
  async deleteSaleByUserId(userId) {
    const { error } = await supabaseAdmin
      .from("sales")
      .delete()
      .eq("user_id", userId);
    return { ok: !error };
  },
  async deleteAuthUser(userId) {
    const { error } = await supabaseAdmin.auth.admin.deleteUser(userId);
    return { ok: !error };
  },
};

const respond = ({ status, body }: Outcome) =>
  status === 200
    ? new Response(JSON.stringify(body), {
        headers: { "Content-Type": "application/json", ...corsHeaders },
      })
    : createErrorResponse(status, body.message ?? "Error", {
        code: body.code,
      });

Deno.serve(async (req: Request) =>
  OptionsMiddleware(req, async (req) =>
    AuthMiddleware(req, async (req) =>
      UserMiddleware(req, async (req, user) => {
        const currentUserSale = await getUserSale(user);
        if (!currentUserSale) {
          return createErrorResponse(401, "Unauthorized");
        }

        if (req.method === "POST") {
          return respond(
            await inviteUser(ports, currentUserSale, await req.json()),
          );
        }

        if (req.method === "PATCH") {
          return respond(
            await patchUser(ports, currentUserSale, await req.json()),
          );
        }

        return createErrorResponse(405, "Method Not Allowed");
      }),
    ),
  ),
);
