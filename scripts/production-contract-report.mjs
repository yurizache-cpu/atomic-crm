// How the production commands report: one finding per line, by rule, severity
// and place, never a value; a count; and an exit status the caller can trust.
//
//   exit 0  no blocking finding
//   exit 1  at least one blocking finding
//   exit 2  the command could not check (a usage error, no build, no answer):
//           a gate that cannot look is never a pass

/** Writes the findings, then a summary, and returns the exit status. */
export function report(
  title,
  findings,
  { json = false, notVerified = [] } = {},
) {
  const blockingCount = findings.filter(
    (f) => f.severity === "blocking",
  ).length;
  const advisoryCount = findings.length - blockingCount;
  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          title,
          blocking: blockingCount,
          advisory: advisoryCount,
          findings,
          notVerified,
        },
        null,
        2,
      )}\n`,
    );
  } else {
    for (const f of findings) {
      const where = f.file === undefined ? "" : ` ${f.file}:`;
      console.error(
        `[${f.severity.toUpperCase()}] ${f.rule}${where} ${f.detail}`,
      );
    }
    console.error(
      `\n${title}: ${blockingCount} blocking, ${advisoryCount} advisory.`,
    );
    if (notVerified.length > 0) {
      console.error(
        "\nNot verified by this command (owner or account actions):",
      );
      for (const item of notVerified) console.error(`  - ${item}`);
    }
    console.error(
      blockingCount === 0
        ? "\nPASS: nothing this command checks blocks production."
        : "\nFAIL: do not deploy or sign this off.",
    );
  }
  return blockingCount === 0 ? 0 : 1;
}

/** A tiny flag reader: `--name value`, `--name=value` and bare `--flag`. */
export function parseFlags(argv, valueFlags) {
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new Error(`unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2);
    if (valueFlags.includes(name)) {
      const value = inline ?? argv[(i += 1)];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      flags[name] = value;
    } else {
      flags[name] = true;
    }
  }
  return flags;
}
