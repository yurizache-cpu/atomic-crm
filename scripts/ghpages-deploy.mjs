// `npm run ghpages:deploy`: publishes dist through scripts/publish-pages.mjs,
// which scans it first and refuses on a finding. The exit code is propagated;
// this script used to log a failed publish and exit 0.
//
// DEPLOY_REPO_URL reaches gh-pages on the command line. Prefer a git credential
// helper to a token embedded in that URL.
import { publishPages } from "./publish-pages.mjs";

const args = ["-d", "dist", "-b", process.env.DEPLOY_BRANCH || "gh-pages"];
if (process.env.DEPLOY_REPO_URL) args.push("-r", process.env.DEPLOY_REPO_URL);

process.exit(publishPages(args));
