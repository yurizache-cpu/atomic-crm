import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import type { ComponentType } from "react";
import { render } from "vitest-browser-react";

import { COMPANY_OS_OPERATION_NAMES } from "../../../contracts/company-os-api/index.ts";
import CompanyOsApp from "../CompanyOsApp";
import type { ScreenComponents } from "../screens/screens";
import type { FakeSession } from "./fakeSession";

// Mounts the whole Company OS (shell, router, adapter, contracts, query
// client) at `hash`, over a fake SessionPort: the screens' browser tests go
// through exactly what the browser runs, with nothing mocked but the port.

export interface RenderOptions {
  readonly screens?: Partial<ScreenComponents>;
  readonly clock?: () => number;
}

export const renderCompanyOs = async (
  session: FakeSession,
  hash: string,
  options: RenderOptions = {},
) => {
  history.replaceState(null, "", hash);
  return render(
    <CompanyOsApp
      session={session.port}
      screens={options.screens}
      clock={options.clock}
    />,
  );
};

/** A navigation inside the mounted module, as a typed address would be. */
export const goTo = (hash: string) => {
  window.location.hash = hash;
};

export interface CacheCapture {
  /** `Screen`, rendered unchanged, remembering the shell's query client. */
  wrap(Screen: ComponentType): ComponentType;
  client(): QueryClient;
}

/** Lets a test read what the shell's in-memory query cache still holds. */
export const createCacheCapture = (): CacheCapture => {
  let captured: QueryClient | undefined;
  return {
    wrap: (Screen) => {
      const Captured = () => {
        captured = useQueryClient();
        return <Screen />;
      };
      return Captured;
    },
    client: () => {
      if (captured === undefined) throw new Error("No screen was rendered.");
      return captured;
    },
  };
};

const isOperation = (part: unknown): part is string =>
  typeof part === "string" &&
  (COMPANY_OS_OPERATION_NAMES as readonly string[]).includes(part);

/** The operation of every query the cache holds, from its key. */
export const cachedOperations = (client: QueryClient): string[] =>
  client
    .getQueryCache()
    .getAll()
    .flatMap((query) => query.queryKey.filter(isOperation));
