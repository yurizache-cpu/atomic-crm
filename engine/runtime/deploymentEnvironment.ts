// Where a worker or WhatsApp gateway process runs, and what that environment
// may not carry (Production Hosting Gate B, SI-76 and SI-77).
//
//   DEPLOYMENT_ENVIRONMENT  unset or "local" (a developer machine, the tests),
//                           "staging" (synthetic data only) or "production".
//
// The container image sets "production" (Dockerfile), so a deployed process is
// held to the strictest rules unless its deployment says otherwise on purpose.
// A misspelt value is refused, never read as "local".
//
// The same rules serve two readers: the process itself at start
// (assertDeploymentEnvironment, which refuses to run), and the operator's
// preflight over a service environment (scripts/production-contract-env.mjs,
// which reports). One source, so the two cannot disagree.
//
// A finding names a variable and a rule, never a value: a misconfigured
// variable is exactly where a pasted secret or connection string ends up.

export type DeploymentEnvironment = "local" | "staging" | "production";

export type ServiceRole = "worker" | "gateway";

export interface EnvironmentFinding {
  readonly rule: string;
  readonly severity: "blocking" | "advisory";
  readonly detail: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const VALUES: readonly DeploymentEnvironment[] = [
  "local",
  "staging",
  "production",
];

/** The declared environment; unset or empty is local, anything unknown throws. */
export function deploymentEnvironmentFromEnv(env: Env): DeploymentEnvironment {
  const raw = env.DEPLOYMENT_ENVIRONMENT;
  if (raw === undefined || raw === "") return "local";
  if ((VALUES as readonly string[]).includes(raw)) {
    return raw as DeploymentEnvironment;
  }
  throw new Error(
    'DEPLOYMENT_ENVIRONMENT must be unset, "local", "staging" or "production"; refusing to start',
  );
}

/** Names that resolve only on a developer's own machine or network. */
const NON_PUBLIC_HOST =
  /^(localhost|.*\.localhost|.*\.local|.*\.test|.*\.internal|host\.docker\.internal|kong|0\.0\.0\.0|\[::1?\])$/i;
const PRIVATE_IPV4 =
  /^(127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|169\.254\.\d+\.\d+)$/;

/** True when a hostname cannot be a public production origin or database. */
export const isNonPublicHost = (hostname: string): boolean =>
  NON_PUBLIC_HOST.test(hostname) || PRIVATE_IPV4.test(hostname);

/** The ports a local Supabase stack publishes its database on. */
const LOCAL_DATABASE_PORTS = /^(5432\d|5433\d|5434\d)$/;

const DATABASE_URLS = [
  "ADMIN_DATABASE_URL",
  "OPS_WORKER_DATABASE_URL",
  "OPS_GATEWAY_DATABASE_URL",
] as const;

const blocking = (rule: string, detail: string): EnvironmentFinding => ({
  rule,
  severity: "blocking",
  detail,
});
const advisory = (rule: string, detail: string): EnvironmentFinding => ({
  rule,
  severity: "advisory",
  detail,
});

const hostnameOf = (value: string): string | null => {
  try {
    return new URL(value).hostname;
  } catch {
    return null;
  }
};

/** What only production refuses: a test provider or a synthetic door. */
function productionOnlyFindings(env: Env): EnvironmentFinding[] {
  const findings: EnvironmentFinding[] = [];
  for (const name of ["DECISION_SHADOW_PROVIDER", "CALENDAR_PROVIDER"]) {
    const value = env[name];
    if (value === "fake") {
      findings.push(
        blocking(
          "fake-provider",
          `${name} is "fake": a deterministic test provider cannot stand in for a production one`,
        ),
      );
    } else if (value === "jev" || value === "google") {
      findings.push(
        advisory(
          "unconnected-provider",
          `${name} is "${value}": that boundary is not connected (no approved contract) and calls nothing`,
        ),
      );
    }
  }
  if (env.COMPANY_OS_SYNTHETIC_INGRESS === "enabled") {
    findings.push(
      blocking(
        "synthetic-ingress",
        'COMPANY_OS_SYNTHETIC_INGRESS is "enabled": production admits no synthetic message',
      ),
    );
  }
  return findings;
}

/** What every deployed environment refuses: a database on a developer machine. */
function deployedFindings(env: Env): EnvironmentFinding[] {
  const findings: EnvironmentFinding[] = [];
  for (const name of DATABASE_URLS) {
    const value = env[name];
    if (value === undefined || value === "") continue;
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      findings.push(blocking("database-url", `${name} is not a URL`));
      continue;
    }
    if (
      isNonPublicHost(parsed.hostname) ||
      LOCAL_DATABASE_PORTS.test(parsed.port)
    ) {
      findings.push(
        blocking(
          "local-database",
          `${name} names a local or private database (host or a local Supabase port)`,
        ),
      );
    }
  }
  const telemetry = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (telemetry !== undefined && telemetry !== "") {
    const host = hostnameOf(telemetry);
    if (host !== null && isNonPublicHost(host)) {
      findings.push(
        advisory(
          "local-telemetry-endpoint",
          "OTEL_EXPORTER_OTLP_ENDPOINT is a local collector: fine beside the worker, meaningless if the worker runs elsewhere",
        ),
      );
    }
  }
  return findings;
}

/**
 * Every finding for a service environment judged AS production: the operator's
 * preflight (`production-preflight --services`) asks this question whatever the
 * environment variable says.
 */
export function productionServiceFindings(env: Env): EnvironmentFinding[] {
  return [...productionOnlyFindings(env), ...deployedFindings(env)];
}

/** Every finding for a service environment in the environment it declares. */
export function serviceEnvironmentFindings(
  env: Env,
  environment: DeploymentEnvironment,
): EnvironmentFinding[] {
  if (environment === "local") return [];
  if (environment === "staging") return deployedFindings(env);
  return productionServiceFindings(env);
}

/**
 * The start gate for a worker or gateway: the declared environment, or a
 * refusal naming every blocking rule it breaks. Advisory findings do not stop a
 * start; they are returned for the caller to log.
 */
export function assertDeploymentEnvironment(
  env: Env,
  role: ServiceRole,
): {
  readonly environment: DeploymentEnvironment;
  readonly advisories: readonly EnvironmentFinding[];
} {
  const environment = deploymentEnvironmentFromEnv(env);
  const findings = serviceEnvironmentFindings(env, environment);
  const refused = findings.filter((f) => f.severity === "blocking");
  if (refused.length > 0) {
    throw new Error(
      `Refusing to start the ${role} in ${environment}: ${refused.map((f) => f.detail).join("; ")}`,
    );
  }
  return {
    environment,
    advisories: findings.filter((f) => f.severity === "advisory"),
  };
}
