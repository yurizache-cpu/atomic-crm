import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { sql, type Selectable } from "https://esm.sh/kysely@0.27.2";
import { runAsUser, type ContactsTable } from "../_shared/db.ts";
import { corsHeaders, OptionsMiddleware } from "../_shared/cors.ts";
import { createErrorResponse } from "../_shared/utils.ts";
import { AuthMiddleware, UserMiddleware } from "../_shared/authentication.ts";
import { mergeLeadProfile } from "./mergeLeadProfile.ts";

type Contact = Selectable<ContactsTable>;

// Helper functions to merge arrays
function mergeArraysUnique<T>(arr1: T[], arr2: T[]): T[] {
  return [...new Set([...arr1, ...arr2])];
}

function mergeObjectArraysUnique<T>(
  arr1: T[],
  arr2: T[],
  getKey: (item: T) => string,
): T[] {
  const map = new Map<string, T>();

  arr1.forEach((item) => {
    const key = getKey(item);
    if (key) map.set(key, item);
  });

  arr2.forEach((item) => {
    const key = getKey(item);
    if (key && !map.has(key)) {
      map.set(key, item);
    }
  });

  return Array.from(map.values());
}

function mergeContactData(winner: Contact, loser: Contact) {
  // Merge emails
  const mergedEmails = mergeObjectArraysUnique(
    winner.email_jsonb || [],
    loser.email_jsonb || [],
    (email: any) => email.email,
  );

  // Merge phones
  const mergedPhones = mergeObjectArraysUnique(
    winner.phone_jsonb || [],
    loser.phone_jsonb || [],
    (phone: any) => phone.number,
  );

  const selectedAvatar =
    winner.avatar && winner.avatar.src ? winner.avatar : loser.avatar;

  return {
    avatar: selectedAvatar ? (JSON.stringify(selectedAvatar) as any) : null,
    gender: winner.gender ?? loser.gender,
    first_name: winner.first_name ?? loser.first_name,
    last_name: winner.last_name ?? loser.last_name,
    title: winner.title ?? loser.title,
    company_id: winner.company_id ?? loser.company_id,
    email_jsonb: JSON.stringify(mergedEmails) as any,
    phone_jsonb: JSON.stringify(mergedPhones) as any,
    linkedin_url: winner.linkedin_url || loser.linkedin_url,
    background: winner.background ?? loser.background,
    has_newsletter: winner.has_newsletter ?? loser.has_newsletter,
    first_seen: winner.first_seen ?? loser.first_seen,
    last_seen:
      winner.last_seen && loser.last_seen
        ? winner.last_seen > loser.last_seen
          ? winner.last_seen
          : loser.last_seen
        : (winner.last_seen ?? loser.last_seen),
    sales_id: winner.sales_id ?? loser.sales_id,
    tags: mergeArraysUnique(winner.tags || [], loser.tags || []),
  };
}

async function mergeContacts(
  loserId: number,
  winnerId: number,
  userId: string,
) {
  try {
    // RLS applies: the whole merge runs as `authenticated`, as the caller.
    return await runAsUser(userId, async (trx) => {
      // Queries run one after another, never in parallel: the transaction owns
      // a single pooled session, and a rollback must not race a query still
      // queued behind a failed one.

      // 1. Fetch both contacts
      const winner = await trx
        .selectFrom("contacts")
        .selectAll()
        .where("id", "=", winnerId)
        .executeTakeFirstOrThrow();
      const loser = await trx
        .selectFrom("contacts")
        .selectAll()
        .where("id", "=", loserId)
        .executeTakeFirstOrThrow();

      // 2. Reassign tasks from loser to winner
      await trx
        .updateTable("tasks")
        .set({ contact_id: winnerId })
        .where("contact_id", "=", loserId)
        .execute();

      // 3. Reassign notes from loser to winner
      await trx
        .updateTable("contact_notes")
        .set({ contact_id: winnerId })
        .where("contact_id", "=", loserId)
        .execute();

      // 4. Update deals - replace loserId with winnerId in contact_ids array
      const deals = await trx
        .selectFrom("deals")
        .selectAll()
        .where(sql`contact_ids @> ARRAY[${loserId}]::bigint[]`)
        .execute();

      for (const deal of deals) {
        const newContactIds = [
          ...new Set(
            deal.contact_ids.filter((id) => id !== loserId).concat(winnerId),
          ),
        ];
        await trx
          .updateTable("deals")
          .set({ contact_ids: newContactIds })
          .where("id", "=", deal.id)
          .execute();
      }

      // 4b. Re-point the loser's acquisition trail. Every FK referencing
      // contacts is ON DELETE CASCADE, so anything not re-pointed here is
      // destroyed by step 6 — silently, because a cascade raises nothing.
      // acquisition_attributions is an append-only trail (source / medium /
      // campaign / gclid / utm_*) with NO unique constraint on contact_id, so
      // both sides' rows survive the merge and the winner keeps the full
      // history. Losing it would erase the only reason the table exists.
      await trx
        .updateTable("acquisition_attributions")
        .set({ contact_id: winnerId })
        .where("contact_id", "=", loserId)
        .execute();

      // 4c. Merge the lead profiles. Unlike the trail, contact_id here is
      // UNIQUE and a trigger creates exactly one row per contact — so BOTH
      // sides always have one, every merge, and the loser's is always
      // cascaded away. It must be folded into the winner's, not re-pointed.
      //
      // do_not_contact is the reason this is LGPD-sensitive: it is an opt-out,
      // and an opt-out is not recoverable by guessing. The rule is therefore
      // OR, never "winner wins" — if EITHER side asked not to be contacted,
      // the merged contact is opted out. Silently re-enabling contact because
      // the surviving row happened to be the winner's is the incident.
      const winnerProfile = await trx
        .selectFrom("lead_profiles")
        .selectAll()
        .where("contact_id", "=", winnerId)
        .executeTakeFirst();
      const loserProfile = await trx
        .selectFrom("lead_profiles")
        .selectAll()
        .where("contact_id", "=", loserId)
        .executeTakeFirst();

      if (winnerProfile && loserProfile) {
        await trx
          .updateTable("lead_profiles")
          .set(mergeLeadProfile(winnerProfile, loserProfile) as any)
          .where("contact_id", "=", winnerId)
          .execute();
      } else if (loserProfile && !winnerProfile) {
        // Winner has no profile (possible only if the trigger was bypassed):
        // re-point rather than drop.
        await trx
          .updateTable("lead_profiles")
          .set({ contact_id: winnerId })
          .where("contact_id", "=", loserId)
          .execute();
      }

      // 5. Merge and update winner contact
      const mergedData = mergeContactData(winner as Contact, loser as Contact);
      await trx
        .updateTable("contacts")
        .set(mergedData)
        .where("id", "=", winnerId)
        .execute();

      // 6. Delete loser contact
      await trx.deleteFrom("contacts").where("id", "=", loserId).execute();

      return { success: true, winnerId };
    });
  } catch (error) {
    console.error("Transaction failed:", error);
    throw error;
  }
}

Deno.serve(async (req: Request) =>
  OptionsMiddleware(req, async (req) =>
    AuthMiddleware(req, async (req) =>
      UserMiddleware(req, async (req, user) => {
        // Handle POST request
        if (req.method === "POST") {
          try {
            const { loserId, winnerId } = await req.json();

            if (!loserId || !winnerId) {
              return createErrorResponse(400, "Missing loserId or winnerId");
            }

            const result = await mergeContacts(loserId, winnerId, user.id);

            return new Response(JSON.stringify(result), {
              headers: { "Content-Type": "application/json", ...corsHeaders },
            });
          } catch (error) {
            console.error("Merge failed:", error);
            return createErrorResponse(
              500,
              `Failed to merge contacts: ${
                error instanceof Error ? error.message : "Unknown error"
              }`,
            );
          }
        }

        return createErrorResponse(405, "Method Not Allowed");
      }),
    ),
  ),
);
