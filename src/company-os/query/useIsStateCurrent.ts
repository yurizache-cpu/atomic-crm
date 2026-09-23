import { useEffect, useState } from "react";

import { useRuntime } from "../session/runtime";
import { FRESHNESS_TICK_MS, isStateCurrent } from "./freshness";

/**
 * Whether live state received at `receivedAt` (a query's dataUpdatedAt) may
 * still be shown as current. It re-reads the runtime clock every second, so a
 * tab left open with polling stopped turns "unknown" on its own.
 */
export const useIsStateCurrent = (receivedAt: number): boolean => {
  const { now } = useRuntime();
  const [time, setTime] = useState(now);

  useEffect(() => {
    const timer = setInterval(() => setTime(now()), FRESHNESS_TICK_MS);
    return () => clearInterval(timer);
  }, [now]);

  return isStateCurrent(receivedAt, Math.max(time, receivedAt));
};
