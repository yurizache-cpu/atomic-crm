// Owner-facing names for the English names the LOCAL development seed writes
// (its "dev" tenant and that tenant's two agents). Presentation only:
// the server's name stays the record's name, no id, slug or row changes, and a
// name these maps do not know is shown exactly as the server returned it. The
// seed never reaches a hosted project (SI-25), so only the local synthetic
// environment is renamed. Real tenants name themselves in their own data.

const TENANT_NAMES: ReadonlyMap<string, string> = new Map([
  ["Development tenant", "Clínica de Psicologia"],
]);

const AGENT_NAMES: ReadonlyMap<string, string> = new Map([
  ["Reception Agent", "Recepcionista IA"],
  ["Marketing Analyst", "Analista de Marketing"],
]);

/** The tenant's name as the owner reads it; the server's name when unmapped. */
export const tenantDisplayName = (name: string): string =>
  TENANT_NAMES.get(name) ?? name;

/** An agent's name as the owner reads it; the server's name when unmapped. */
export const agentDisplayName = (name: string): string =>
  AGENT_NAMES.get(name) ?? name;
