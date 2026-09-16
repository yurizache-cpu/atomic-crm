// The environment a driver-backed suite hands to a process it spawns.
//
// A spawned test worker runs the real handler registry, and a test runner's
// shell may export a provider key or model routing for `npm run worker`. None of
// that is needed by a test process, and none of it may reach one: a child that
// inherited AGENT_MODEL_PROVIDER and OPENAI_API_KEY is one code change away from
// a paid call on synthetic data. So the inherited copy drops every provider key
// and model routing variable; a case that needs one passes it explicitly.
//
// Names are matched ignoring case, because on win32 variable names are.

const MODEL_CONFIGURATION =
  /^(OPENAI_API_KEY|ANTHROPIC_API_KEY|AGENT_MODEL_.*)$/i;

type Env = Readonly<Record<string, string | undefined>>;

/** True for a provider key or model routing variable a spawned test process must not inherit. */
export function isModelConfigurationVariable(name: string): boolean {
  return MODEL_CONFIGURATION.test(name);
}

/**
 * A new environment: `inherited` without any provider key or model routing
 * variable, then `explicit` on top. Neither argument is changed.
 */
export function testChildEnvironment(
  inherited: Env,
  explicit: Readonly<Record<string, string>> = {},
): Record<string, string | undefined> {
  const kept = Object.entries(inherited).filter(
    ([name]) => !isModelConfigurationVariable(name),
  );
  return { ...Object.fromEntries(kept), ...explicit };
}
