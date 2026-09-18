// The WhatsApp webhook gateway process (Phase 2B).
//
//   npm run whatsapp:gateway
//
// ENVIRONMENT, read once, never printed:
//   OPS_GATEWAY_DATABASE_URL  a LOGIN role that is a member of ops_gateway
//                             (scripts/provision-gateway-role.mjs). Never the
//                             owner, never service_role: the process refuses to
//                             start on a superuser, a BYPASSRLS role or a role
//                             that is not a member of ops_gateway.
//   WHATSAPP_APP_SECRET       the Meta app secret: verifies X-Hub-Signature-256.
//   WHATSAPP_VERIFY_TOKEN     the token Meta echoes in the subscription handshake.
//   WHATSAPP_GATEWAY_HOST     default 127.0.0.1. Put TLS and the public name in
//                             front of it (a reverse proxy or tunnel); the gateway
//                             itself binds to loopback unless told otherwise.
//   WHATSAPP_GATEWAY_PORT     default 8787.
//   WHATSAPP_GATEWAY_PATH     default /webhooks/whatsapp.
//
// No dependency: node:http, a bounded body, and the pure handler in
// engine/communication/whatsapp/webhookGateway.ts. Logs are one JSON object
// per line with counts and outcomes only.

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { WorkerDatabase } from "../db/types.ts";
import { createWorkerDatabase } from "../db/workerDatabase.ts";
import { WEBHOOK_MAX_BODY_BYTES } from "../communication/whatsapp/metaApi.ts";
import {
  handleWebhookRequest,
  type GatewayConfig,
  type GatewayLogger,
  type GatewayStore,
} from "../communication/whatsapp/webhookGateway.ts";
import {
  createGatewayStore,
  GATEWAY_ROLE,
} from "../domain/whatsappGatewayStore.ts";
import { isEntryPoint, jsonLine } from "./cliOutput.ts";

export const GATEWAY_DATABASE_URL = "OPS_GATEWAY_DATABASE_URL";
export const DEFAULT_GATEWAY_PATH = "/webhooks/whatsapp";
export const DEFAULT_GATEWAY_PORT = 8787;

class BodyTooLarge extends Error {}

/**
 * The request body, or BodyTooLarge past `limit` bytes. Past the limit nothing
 * more is kept, and the rest is read and discarded so that the 413 reaches the
 * sender; destroying the socket instead would answer nothing at all (measured
 * in whatsappGateway.test.ts). The server's request timeout bounds a sender
 * that never stops.
 */
function readBody(
  request: IncomingMessage,
  limit: number,
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    request.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BodyTooLarge());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

/** A delivery that takes longer than this, headers included, is cut off. */
export const GATEWAY_REQUEST_TIMEOUT_MS = 30_000;
export const GATEWAY_HEADERS_TIMEOUT_MS = 10_000;

export interface GatewayServerOptions {
  readonly config: GatewayConfig;
  readonly store: GatewayStore;
  readonly log: GatewayLogger;
  readonly maxBodyBytes?: number;
}

/** The HTTP server, unstarted. Exported for the server-level tests. */
export function createGatewayServer(options: GatewayServerOptions): Server {
  const limit = options.maxBodyBytes ?? WEBHOOK_MAX_BODY_BYTES;
  const server = createServer((request, response) => {
    void (async () => {
      let status = 500;
      let body = "";
      try {
        const raw =
          request.method === "POST"
            ? await readBody(request, limit)
            : new Uint8Array();
        const signature = request.headers["x-hub-signature-256"];
        const answer = await handleWebhookRequest(
          {
            method: request.method ?? "",
            url: request.url ?? "/",
            signature: typeof signature === "string" ? signature : undefined,
            body: raw,
          },
          options.config,
          options.store,
          options.log,
        );
        status = answer.status;
        body = answer.body;
      } catch (error) {
        status = error instanceof BodyTooLarge ? 413 : 500;
        options.log("gateway.rejected", {
          reason: error instanceof BodyTooLarge ? "too_large" : "internal",
        });
      }
      if (!response.headersSent) {
        response.writeHead(status, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          ...(status === 413 ? { Connection: "close" } : {}),
        });
      }
      response.end(body);
    })();
  });
  server.requestTimeout = GATEWAY_REQUEST_TIMEOUT_MS;
  server.headersTimeout = GATEWAY_HEADERS_TIMEOUT_MS;
  return server;
}

const IDENTITY_SQL = `select r.rolsuper as is_superuser, r.rolbypassrls as bypasses_rls,
       pg_has_role(current_user, $1, 'member') as is_member,
       current_user = $1 as is_role_itself
  from pg_roles r where r.rolname = current_user`;

/** Refuses a connection that is not a constrained member of ops_gateway. */
export async function assertGatewayIdentity(db: WorkerDatabase): Promise<void> {
  const row = await db.withTransaction(async (tx) => {
    const { rows } = await tx.query<{
      is_superuser: boolean;
      bypasses_rls: boolean;
      is_member: boolean;
      is_role_itself: boolean;
    }>(IDENTITY_SQL, [GATEWAY_ROLE]);
    return rows[0];
  });
  if (
    !row ||
    row.is_superuser ||
    row.bypasses_rls ||
    !row.is_member ||
    row.is_role_itself
  ) {
    throw new Error(
      `${GATEWAY_DATABASE_URL} must name a LOGIN role that is a member of ${GATEWAY_ROLE}, with no SUPERUSER and no BYPASSRLS (scripts/provision-gateway-role.mjs); never the owner or service_role`,
    );
  }
}

const required = (
  env: Readonly<Record<string, string | undefined>>,
  name: string,
): string => {
  const value = env[name];
  if (typeof value !== "string" || value === "") {
    throw new Error(`${name} is required`);
  }
  return value;
};

export async function startWhatsAppGateway(
  env: Readonly<Record<string, string | undefined>>,
  write: (line: string) => void,
): Promise<{ readonly server: Server; readonly close: () => Promise<void> }> {
  const connectionString = required(env, GATEWAY_DATABASE_URL);
  const config: GatewayConfig = Object.freeze({
    appSecret: required(env, "WHATSAPP_APP_SECRET"),
    verifyToken: required(env, "WHATSAPP_VERIFY_TOKEN"),
    path: env.WHATSAPP_GATEWAY_PATH ?? DEFAULT_GATEWAY_PATH,
  });
  const port = Number(env.WHATSAPP_GATEWAY_PORT ?? DEFAULT_GATEWAY_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("WHATSAPP_GATEWAY_PORT is not a port");
  }
  const host = env.WHATSAPP_GATEWAY_HOST ?? "127.0.0.1";

  const db = createWorkerDatabase({ connectionString, max: 4 });
  await assertGatewayIdentity(db);
  const log: GatewayLogger = (event, fields) =>
    write(jsonLine({ at: new Date().toISOString(), event, ...fields }));
  const server = createGatewayServer({
    config,
    store: createGatewayStore(db),
    log,
  });
  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  write(
    jsonLine({
      at: new Date().toISOString(),
      event: "gateway.started",
      host,
      port,
    }),
  );
  return {
    server,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.close();
    },
  };
}

if (await isEntryPoint(import.meta.url)) {
  try {
    const gateway = await startWhatsAppGateway(process.env, (line) =>
      process.stdout.write(`${line}\n`),
    );
    const stop = () => {
      void gateway.close().then(() => process.exit(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (error) {
    // Only this module's own messages are printed: they name a variable or a
    // rule, never a value. A driver or server error can quote the connection
    // string, so it is reported by its code alone.
    const code =
      typeof error === "object" &&
      error !== null &&
      typeof (error as { code?: unknown }).code === "string"
        ? String((error as { code: string }).code).slice(0, 40)
        : null;
    process.stderr.write(
      `${jsonLine(
        code === null && error instanceof Error
          ? { error: "gateway_start", message: error.message }
          : { error: "gateway_start", code: code ?? "unexpected" },
      )}\n`,
    );
    process.exitCode = 1;
  }
}
