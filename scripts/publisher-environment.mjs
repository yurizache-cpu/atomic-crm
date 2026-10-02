// The environment a frontend publisher hands to the third-party upload tool it
// runs (the Netlify uploader, Wrangler): what a Node or npx process needs to
// start and reach the network, plus the keys the caller names. Never the
// ambient shell's other values, such as a database URL, a model key or a
// service-role key, which an upload tool has no business seeing (PR #23
// review).

const BASE = Object.freeze([
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "SYSTEMROOT",
  "windir",
  "ComSpec",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "LANG",
  "TERM",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS",
  "npm_config_cache",
  "NPM_CONFIG_CACHE",
]);

/** Only the allowlisted variables of `env`, and the `extra` keys named. */
export function uploaderEnvironment(env, extra = []) {
  const allowed = {};
  for (const key of [...BASE, ...extra]) {
    if (env[key] !== undefined) allowed[key] = env[key];
  }
  return allowed;
}
