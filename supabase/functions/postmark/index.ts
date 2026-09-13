// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  getForwardedMailContent,
  stripSubjectForwardingPrefix,
} from "./forwardedParser.ts";
import { extractMailContactData } from "./extractMailContactData.ts";
import { getExpectedAuthorization } from "./getExpectedAuthorization.ts";
import { getNoteContent } from "./getNoteContent.ts";
import { extractAndUploadAttachments } from "./extractAndUploadAttachments.ts";
import { supabaseAdmin } from "../_shared/supabaseAdmin.ts";
import {
  collectRecipientResults,
  escalateUnrecordedFailure,
  foldOutcomes,
  httpStatusForOutcome,
  isUsableIdempotencyKey,
  ledgerStatusForOutcome,
  SYNTHETIC_KEY_PREFIX,
  type RecipientOutcome,
  type RecipientResult,
} from "./ingestionOutcome.ts";
import { recordMessageFailure } from "./inboundEmailLedger.ts";
import { ingestRecipient } from "./ingestRecipient.ts";

// Inbound email is the only untrusted external channel that reaches this
// database. It used to answer 200 to every ingestion failure — the return
// value of `addNoteToContact` was discarded — so a lost message left no trace,
// no retry and no alert. The semantics implemented here are
// docs/design/postmark-ingestion.md:
//
//   ingested / duplicate -> 200
//   permanently invalid  -> 200 + a durable ledger row holding the raw payload
//   transient            -> 500, the only case Postmark should retry
//   auth rejected        -> 401/405, before any processing

const webhookUser = Deno.env.get("POSTMARK_WEBHOOK_USER");
const webhookPassword = Deno.env.get("POSTMARK_WEBHOOK_PASSWORD");
const INBOUND_EMAIL = (Deno.env.get("VITE_INBOUND_EMAIL") || "").toLowerCase();
if (!webhookUser || !webhookPassword) {
  throw new Error(
    "Missing POSTMARK_WEBHOOK_USER or POSTMARK_WEBHOOK_PASSWORD env variable",
  );
}

const rawAuthorizedIPs = Deno.env.get("POSTMARK_WEBHOOK_AUTHORIZED_IPS");
if (!rawAuthorizedIPs) {
  throw new Error("Missing POSTMARK_WEBHOOK_AUTHORIZED_IPS env variable");
}

/** Cap on the body kept for a payload that is not valid JSON. */
const MAX_UNPARSED_BODY_CHARS = 64_000;

Deno.serve(async (req) => {
  const startedAt = Date.now();

  const rejected = checkRequestTypeAndHeaders(req);
  if (rejected) return rejected;

  // Read the body as text first. A payload that fails to parse still has to be
  // recorded, and `req.json()` consumes the stream before we could keep it.
  const rawBody = await req.text();
  const json = parseJson(rawBody);
  const payload: Record<string, unknown> = json ?? {
    unparsed_body: rawBody.slice(0, MAX_UNPARSED_BODY_CHARS),
  };
  const messageId = getMessageId(json);

  const finish = (
    outcome: RecipientOutcome,
    detail: { reason?: string; results?: RecipientResult[] } = {},
  ) => {
    const status = httpStatusForOutcome(outcome);
    // One structured line per delivery (design §6). The states in the ledger
    // are the queryable interface; this is the stream that points at them.
    // Deliberate stdout logging: one JSON object per line.
    // eslint-disable-next-line no-console
    console.log(
      JSON.stringify({
        event: "postmark.inbound",
        message_id: messageId,
        outcome,
        status,
        reason: detail.reason,
        recipients: detail.results?.length ?? 0,
        results: detail.results ?? [],
        duration_ms: Date.now() - startedAt,
      }),
    );
    return new Response(outcome, { status });
  };

  /** Records a failure that belongs to the delivery, not to one recipient. */
  const failDelivery = async (
    outcome: "permanent" | "transient",
    reason: string,
  ) => {
    const recorded = await recordMessageFailure({
      messageId,
      payload,
      status: ledgerStatusForOutcome(outcome),
      detail: reason,
    });
    // A permanent failure we could not write down is a silent drop — exactly
    // the bug being removed here — so it is escalated to transient and Postmark
    // delivers again, giving the ledger another chance.
    return finish(escalateUnrecordedFailure(outcome, recorded), { reason });
  };

  if (!json) {
    return await failDelivery("permanent", "body is not valid JSON");
  }

  const bodyProblem = checkBody(json);
  if (bodyProblem) return await failDelivery("permanent", bodyProblem);

  const { FromFull, Attachments } = json;
  let { ToFull, TextBody, Subject } = json;

  const salesEmail = (FromFull.Email || "").toLowerCase();
  if (!salesEmail) {
    return await failDelivery(
      "permanent",
      "could not extract a sender email from FromFull",
    );
  }

  const allSales = await supabaseAdmin.from("sales").select("email");
  if (allSales.error) {
    // Previously `?? []`, which silently turned an unreachable database into
    // "there are no sales users" and changed the forwarding decision below.
    return await failDelivery(
      "transient",
      `could not read sales: ${allSales.error.message}`,
    );
  }
  const salesEmails =
    allSales.data?.map((s: { email: string }) => s.email) ?? [];

  const firstToEmail = (ToFull[0]?.Email || "").toLowerCase();

  // If we have an INBOUND_EMAIL and the email is sent only to the inbound email address, and the sender is a known sales email,
  // then we can try to extract the real recipient email from the body of the email
  if (
    INBOUND_EMAIL &&
    ToFull.length === 1 &&
    firstToEmail === INBOUND_EMAIL &&
    salesEmails.includes(salesEmail)
  ) {
    const emailRegex = /[\w.+%-]+@[\w.-]+\.[a-zA-Z]{2,}/g;
    const emailsInBody = TextBody.match(emailRegex) || [];

    const candidateEmails = emailsInBody
      .map((email: string) => email.toLowerCase())
      .filter(
        (email: string) =>
          email !== INBOUND_EMAIL && !salesEmails?.includes(email),
      );
    if (candidateEmails.length === 0) {
      return await failDelivery(
        "permanent",
        "could not extract a recipient email from the forwarded email body",
      );
    }
    ToFull = [
      {
        Email: candidateEmails[0],
        Name: "",
      },
    ];
    TextBody = getForwardedMailContent(TextBody);
    Subject = stripSubjectForwardingPrefix(Subject);
  }

  let attachments;
  try {
    attachments = await extractAndUploadAttachments(Attachments);
  } catch (error) {
    // Upload failures are recoverable. Before this, the throw escaped the
    // handler, nothing was recorded, and the runtime answered for us.
    return await failDelivery(
      "transient",
      `attachment upload failed: ${errorMessage(error)}`,
    );
  }

  const noteContent = getNoteContent(Subject, TextBody);
  const contacts = extractMailContactData(ToFull);

  // Every recipient is visited and every outcome is kept. The rejected
  // implementation returned from inside this loop, which discarded a
  // transient recipient the moment a later one produced anything else.
  const results = await collectRecipientResults(
    contacts,
    (contact) =>
      ingestRecipient({
        messageId,
        payload,
        salesEmail,
        noteContent,
        attachments,
        contact,
      }),
    (contact, error) => ({
      email: contact.email ?? "",
      outcome: "transient",
      detail: `unhandled error: ${errorMessage(error)}`,
    }),
  );

  return finish(foldOutcomes(results.map((result) => result.outcome)), {
    results,
  });
});

const checkRequestTypeAndHeaders = (req: Request) => {
  // Only allow known IP addresses
  // We can use the x-forwarded-for header as it is populated by Supabase
  // https://supabase.com/docs/guides/api/securing-your-api#accessing-request-information
  const forwardedFor = req.headers.get("x-forwarded-for");
  if (!forwardedFor) {
    return new Response("Unauthorized", { status: 401 });
  }
  const ips = forwardedFor.split(",").map((ip) => ip.trim());
  const authorizedIPs = rawAuthorizedIPs
    .split(",")
    .map((ip: string) => ip.trim());
  if (!ips.some((ip) => authorizedIPs.includes(ip))) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Only allow POST requests
  if (req.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  // Check the Authorization header
  const expectedAuthorization = getExpectedAuthorization(
    webhookUser,
    webhookPassword,
  );
  const authorization = req.headers.get("Authorization");
  if (authorization !== expectedAuthorization) {
    return new Response("Unauthorized", { status: 401 });
  }
};

// deno-lint-ignore no-explicit-any
const parseJson = (rawBody: string): any | null => {
  try {
    const parsed = JSON.parse(rawBody);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * The idempotency key. Postmark supplies `MessageID` on every request and it is
 * stable across its retries; nothing else in the payload is.
 *
 * A payload without one is permanently invalid, so it will never be retried and
 * has nothing to deduplicate against. The synthetic key exists only so the
 * durable record can still be written instead of the message vanishing.
 */
// deno-lint-ignore no-explicit-any
const getMessageId = (json: any | null): string => {
  const messageId = json?.MessageID;
  return typeof messageId === "string" && messageId
    ? messageId
    : `${SYNTHETIC_KEY_PREFIX}${crypto.randomUUID()}`;
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Returns the reason the payload is permanently invalid, or undefined.
 *
 * It used to return a 403 Response directly. Permanent invalidity now answers
 * 200 with a durable ledger row (design §2): both stop Postmark retrying, but
 * only one of them leaves something to replay.
 */
// deno-lint-ignore no-explicit-any
const checkBody = (json: any): string | undefined => {
  const { ToFull, FromFull, Subject, TextBody, MessageID } = json;

  // MessageID is checked HERE, not left to `getMessageId`'s synthetic fallback,
  // and that distinction is the whole point. `unkeyed:<uuid>` is unique per
  // DELIVERY, so a payload that reached the ingest path under one would be
  // re-ingested on every Postmark redelivery — a duplicate note each time,
  // which is precisely what the ledger exists to prevent. Failing here routes
  // such a payload to `failDelivery("permanent", …)`: 200, a durable record
  // under the synthetic key, and no work. The fallback then covers only the
  // paths that never ingest (unparseable body, permanently-invalid payload).
  if (!isUsableIdempotencyKey(MessageID)) {
    return "missing parameter: MessageID";
  }
  if (!ToFull || !ToFull.length) return "missing parameter: ToFull";
  if (!FromFull) return "missing parameter: FromFull";
  if (!Subject) return "missing parameter: Subject";
  if (!TextBody) return "missing parameter: TextBody";
};

/* To invoke locally:
  1. Run `make start`
  2. Make sure to have a Sales with email "support@postmarkapp.com" (create it if needed)
  3. OPTIONAL: Create a Contact with email "firstname.lastname@marmelab.com"
  4. In another terminal, run `make start-supabase-functions`
  5. In another terminal, make an HTTP request:
  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/postmark' \
    --header 'Content-Type: application/json' \
    --header 'Authorization: Basic dGVzdHVzZXI6dGVzdHB3ZA==' \
    --data '{
        "FromName": "Postmarkapp Support",
        "From": "support@postmarkapp.com",
        "FromFull": {
            "Email": "support@postmarkapp.com",
            "Name": "Postmarkapp Support",
            "MailboxHash": ""
        },
        "To": "\"Firstname Lastname\" <firstname.lastname@marmelab.com>",
        "ToFull": [
            {
            "Email": "firstname.lastname@marmelab.com",
            "Name": "Firstname Lastname",
            "MailboxHash": "SampleHash"
            }
        ],
        "Cc": "\"First Cc\" <firstcc@postmarkapp.com>, secondCc@postmarkapp.com",
        "CcFull": [
            {
            "Email": "firstcc@postmarkapp.com",
            "Name": "First Cc",
            "MailboxHash": ""
            },
            {
            "Email": "secondCc@postmarkapp.com",
            "Name": "",
            "MailboxHash": ""
            }
        ],
        "Bcc": "\"First Bcc\" <firstbcc@postmarkapp.com>, secondbcc@postmarkapp.com",
        "BccFull": [
            {
            "Email": "firstbcc@postmarkapp.com",
            "Name": "First Bcc",
            "MailboxHash": ""
            },
            {
            "Email": "secondbcc@postmarkapp.com",
            "Name": "",
            "MailboxHash": ""
            }
        ],
        "OriginalRecipient": "firstname.lastname@marmelab.com",
        "Subject": "Test subject",
        "MessageID": "73e6d360-66eb-11e1-8e72-a8904824019b",
        "ReplyTo": "replyto@postmarkapp.com",
        "MailboxHash": "SampleHash",
        "Date": "Fri, 1 Aug 2014 16:45:32 -04:00",
        "TextBody": "This is a test text body.",
        "HtmlBody": "<html><body><p>This is a test html body.</p></body></html>",
        "StrippedTextReply": "This is the reply text",
        "Tag": "TestTag",
        "Headers": [
            {
            "Name": "X-Header-Test",
            "Value": ""
            },
            {
            "Name": "X-Spam-Status",
            "Value": "No"
            },
            {
            "Name": "X-Spam-Score",
            "Value": "-0.1"
            },
            {
            "Name": "X-Spam-Tests",
            "Value": "DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS"
            }
        ],
        "Attachments": [
            {
            "Name": "test.txt",
            "Content": "VGhpcyBpcyBhdHRhY2htZW50IGNvbnRlbnRzLCBiYXNlLTY0IGVuY29kZWQu",
            "ContentType": "text/plain",
            "ContentLength": 45
            }
        ]
      }'


  To trigger the email forwarding feature, you can change the "To" and "ToFull" fields to have the INBOUND_EMAIL, and add an email address that is neither a sales nor the INBOUND_EMAIL, for example:
  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/postmark' \
    --header 'Content-Type: application/json' \
    --header 'Authorization: Basic dGVzdHVzZXI6dGVzdHB3ZA==' \
    --data '{
      "FromName": "Postmarkapp Support",
      "MessageStream": "inbound",
      "From": "support@postmarkapp.com",
      "FromFull": {
        "Email": "support@postmarkapp.com",
        "Name": "Postmarkapp Support",
        "MailboxHash": ""
      },
      "To": "2aff30e603e54dc3eb556bd9e03ee099@inbound.postmarkapp.com",
      "ToFull": [
        {
          "Email": "2aff30e603e54dc3eb556bd9e03ee099@inbound.postmarkapp.com",
          "Name": "",
          "MailboxHash": ""
        }
      ],
      "Cc": "",
      "CcFull": [],
      "Bcc": "",
      "BccFull": [],
      "OriginalRecipient": "2aff30e603e54dc3eb556bd9e03ee099@inbound.postmarkapp.com",
      "Subject": "Fwd: Test for forwarding mail",
      "MessageID": "32dcbecb-57d0-476e-9591-c747808cb599",
      "ReplyTo": "",
      "MailboxHash": "",
      "Date": "Thu, 5 Mar 2026 10:41:26 +0100",
      "TextBody": "---------- Forwarded message ---------\nFrom : Original Recipient <original.recipient@company.com>\nDate: Fri, 1 Aug 2014 16:45:32 -04:00\nSubject: Test for forwarding mail\nTo: Postmarkapp Support <support@postmarkapp.com>\n\n\nThe transferred message body\n",
      "HtmlBody": "<div dir=\"ltr\"><br><br><div class=\"gmail_quote gmail_quote_container\"><div dir=\"ltr\" class=\"gmail_attr\">---------- Forwarded message ---------<br>From: <strong class=\"gmail_sendername\" dir=\"auto\">Original Recipient</strong> <span dir=\"auto\">&lt;<a href=\"mailto:original.recipient@company.com\">original.recipient@company.com</a>&gt;</span><br>Date: Fri, 1 Aug 2014 16:45:32 -04:00<br>Subject: Test for forwarding mail<br>To: Postmarkapp Support &lt;<a href=\"mailto:support@postmarkapp.com\">support@postmarkapp.com</a>&gt;<br></div><br><br><div dir=\"ltr\">The transferred message body</div>\n</div></div>\n",
      "StrippedTextReply": "",
      "Tag": "",
      "Headers": [
            {
                "Name": "X-Header-Test",
                "Value": ""
            },
            {
                "Name": "X-Spam-Status",
                "Value": "No"
            },
            {
                "Name": "X-Spam-Score",
                "Value": "-0.1"
            },
            {
                "Name": "X-Spam-Tests",
                "Value": "DKIM_SIGNED,DKIM_VALID,DKIM_VALID_AU,SPF_PASS"
            }
      ],
      "Attachments": []
    }'

*/
