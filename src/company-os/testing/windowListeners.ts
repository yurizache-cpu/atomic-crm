/**
 * Counts the `type` listeners added to window from now on and not yet removed,
 * by identity: a router adds one popstate listener when it is created and only
 * `dispose()` removes it, so this is how a test sees an orphaned router. The
 * spies call through; vi.restoreAllMocks() ends the count.
 */
export const trackWindowListeners = (type: string): (() => number) => {
  const live = new Set<unknown>();
  const add = window.addEventListener.bind(window);
  const remove = window.removeEventListener.bind(window);
  vi.spyOn(window, "addEventListener").mockImplementation(
    (name: string, listener: unknown, options?: unknown) => {
      if (name === type) live.add(listener);
      add(name, listener as EventListener, options as AddEventListenerOptions);
    },
  );
  vi.spyOn(window, "removeEventListener").mockImplementation(
    (name: string, listener: unknown, options?: unknown) => {
      if (name === type) live.delete(listener);
      remove(name, listener as EventListener, options as EventListenerOptions);
    },
  );
  return () => live.size;
};
