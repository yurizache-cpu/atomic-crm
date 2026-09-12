// The escape hatch.
//
// It matters as much as the check: a guard with no legitimate override gets
// deleted the first time someone needs the thing it blocks. So there is one,
// and it is PER-VIOLATION rather than per-file or per-rule. You silence one
// exact thing, never a category, and you cannot pre-emptively silence something
// that does not exist, because you cannot guess an id the engine has not
// emitted.
//
// FIVE CONDITIONS, all required:
//   1. `-- SECURITY-INVARIANT-OVERRIDE: <id> ADR-00NN <reason>` within 10 lines
//      ABOVE the offending statement, in the file that produces it.
//   2. `<id>` equals the engine-generated id EXACTLY — no wildcards, no
//      prefixes, no rule-level ids.
//   3. `docs/adr/00NN-*.md` exists AND its header says **Accepted**.
//   4. That ADR names this migration's filename, so the two artifacts reference
//      each other and an old unrelated ADR path cannot be recycled.
//   5. The same {invariantId, adr, migrationFile} triple is in
//      `declaration.json#overrides`.
//
// AND IN REVERSE, so the ledger self-prunes instead of rotting into a blanket:
// a ledger entry matching no live finding fails, a marker matching no live
// finding fails, and a malformed marker fails. A broken override never degrades
// to "no override present"; it degrades to red.
//
// Non-overridable by design: anything the guard could not READ. An override is
// scoped to an object, and a statement with no reliable object has nothing to
// scope to, so the only remedy is to make the SQL readable.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { finding } from "./rules.mjs";

export const OVERRIDE_TOKEN = "SECURITY-INVARIANT-OVERRIDE";
const OVERRIDE_RE = new RegExp(
  `--\\s*${OVERRIDE_TOKEN}:\\s*(\\S+)\\s+(ADR-\\d{4})\\s+(.+?)\\s*$`,
);
const OVERRIDE_WINDOW = 10;

/** Collect every marker in the corpus, reporting malformed ones. */
function collectMarkers(corpus) {
  const markers = [];
  const malformed = [];
  for (const migration of corpus) {
    migration.sql.split("\n").forEach((text, index) => {
      if (!text.includes(OVERRIDE_TOKEN)) return;
      const m = OVERRIDE_RE.exec(text);
      if (!m) {
        malformed.push(
          finding(
            `override:malformed:${migration.file}:${index + 1}`,
            "override",
            migration.file,
            index + 1,
            `malformed ${OVERRIDE_TOKEN} marker. The exact form is: -- ${OVERRIDE_TOKEN}: <invariant-id> ADR-00NN <one-line reason>`,
            false,
          ),
        );
        return;
      }
      markers.push({
        invariantId: m[1],
        adr: m[2],
        reason: m[3],
        migrationFile: migration.file,
        line: index + 1,
      });
    });
  }
  return { markers, malformed };
}

/** Check the ADR half of the contract. Returns a finding, or null when valid. */
function checkAdr(marker, repoRoot) {
  const reject = (id, message) =>
    finding(
      `override:${id}:${marker.invariantId}`,
      "override",
      marker.migrationFile,
      marker.line,
      message,
      false,
    );

  const adrDir = join(repoRoot, "docs", "adr");
  const number = marker.adr.slice(4);
  const file = existsSync(adrDir)
    ? readdirSync(adrDir).find(
        (f) => f.startsWith(`${number}-`) && f.endsWith(".md"),
      )
    : undefined;
  if (!file) {
    return reject(
      "no-adr",
      `${marker.adr} names no file under docs/adr/. Approving a regression means writing and committing the decision first.`,
    );
  }
  const text = readFileSync(join(adrDir, file), "utf8");
  if (!/\*\*Status:\*\*\s*\**\s*Accepted/.test(text)) {
    return reject(
      "adr-not-accepted",
      `docs/adr/${file} is not Accepted. A Proposed ADR approves nothing.`,
    );
  }
  if (!text.includes(marker.migrationFile)) {
    return reject(
      "adr-does-not-name-migration",
      `docs/adr/${file} does not name ${marker.migrationFile}. The two artifacts must reference each other, or the path of an old unrelated ADR can simply be pasted in.`,
    );
  }
  return null;
}

/**
 * @param {{findings: object[], corpus: object[], declaration: object, repoRoot: string}} input
 * @returns {{active: object[], hatchFindings: object[]}}
 */
export function reconcileOverrides({
  findings,
  corpus,
  declaration,
  repoRoot,
}) {
  const { markers, malformed } = collectMarkers(corpus);
  const hatchFindings = [...malformed];
  const active = [];

  for (const marker of markers) {
    const target = findings.find(
      (f) =>
        f.id === marker.invariantId &&
        f.file === marker.migrationFile &&
        f.overridable &&
        // `line === 0` marks a finding about an END STATE rather than a single
        // statement; proximity cannot apply, so the file match plus the ledger
        // and ADR checks carry it.
        (f.line === 0 ||
          (marker.line < f.line && f.line - marker.line <= OVERRIDE_WINDOW)),
    );
    if (!target) {
      hatchFindings.push(
        finding(
          `override:dead:${marker.invariantId}`,
          "override",
          marker.migrationFile,
          marker.line,
          `this ${OVERRIDE_TOKEN} names "${marker.invariantId}", which is not a live, overridable finding in this file within ${OVERRIDE_WINDOW} lines below the marker. A dead override cannot be left to accumulate, and a statement the guard could not read is never overridable.`,
          false,
        ),
      );
      continue;
    }

    const adrProblem = checkAdr(marker, repoRoot);
    if (adrProblem) {
      hatchFindings.push(adrProblem);
      continue;
    }

    const ledgered = declaration.overrides.some(
      (o) =>
        o.invariantId === marker.invariantId &&
        o.adr === marker.adr &&
        o.migrationFile === marker.migrationFile,
    );
    if (!ledgered) {
      hatchFindings.push(
        finding(
          `override:unledgered:${marker.invariantId}`,
          "override",
          marker.migrationFile,
          marker.line,
          `no matching entry in declaration.json#overrides for {invariantId: "${marker.invariantId}", adr: "${marker.adr}", migrationFile: "${marker.migrationFile}"}. Two committed files must change together: the migration carries the local justification, the declaration carries the global ledger, and this test fails if they disagree in EITHER direction.`,
          false,
        ),
      );
      continue;
    }
    active.push(marker);
  }

  for (const entry of declaration.overrides) {
    const covered = active.some(
      (m) =>
        m.invariantId === entry.invariantId &&
        m.adr === entry.adr &&
        m.migrationFile === entry.migrationFile,
    );
    if (covered) continue;
    hatchFindings.push(
      finding(
        `override:stale-ledger:${entry.invariantId}`,
        "override",
        "declaration.json",
        0,
        `declaration.json#overrides still lists {invariantId: "${entry.invariantId}", migrationFile: "${entry.migrationFile}"}, which is no longer a live, approved violation. Remove it — the ledger self-prunes or it becomes a permanent blanket.`,
        false,
      ),
    );
  }

  return { active, hatchFindings };
}
