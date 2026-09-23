import { useParams } from "react-router";

import { UUID_PATTERN } from "../../../contracts/company-os-api/index.ts";

// A detail page's record id comes from the address, which anyone can type. An
// id the input contract would refuse (not a lower-case uuid) is never sent:
// the page says "Not found." exactly as it does for the server's OS404
// (RecordNotFound.tsx), and no read starts, so a malformed address never reads
// as a server failure, and never as a response that broke its contract.

/** The route parameter `name` when it is a uuid the contract accepts, else null. */
export const useRouteRecordId = (name: string): string | null => {
  const value = useParams()[name] ?? "";
  return UUID_PATTERN.test(value) ? value : null;
};
