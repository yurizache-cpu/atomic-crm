import { Link } from "react-router";

import { LIST_PATHS } from "../components/recordPaths";

/** A path below #/company-os that no screen owns. */
export const NotFoundScreen = () => (
  <div className="flex flex-col gap-2">
    <h1 className="text-xl font-semibold">Página não encontrada</h1>
    <Link
      to={LIST_PATHS.overview}
      className="text-sm underline underline-offset-4"
    >
      Company OS overview
    </Link>
  </div>
);
