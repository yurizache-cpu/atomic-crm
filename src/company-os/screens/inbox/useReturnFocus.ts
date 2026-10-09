import { useEffect, useRef, type RefObject } from "react";

/**
 * Gives the keyboard focus back when a confirmation closes: to the button that
 * opened it, or, while that button is disabled (the act is on its way), to the
 * act's group, so the member never lands on the top of the page.
 */
export const useReturnFocus = (
  open: boolean,
  trigger: RefObject<HTMLButtonElement | null>,
  group: RefObject<HTMLDivElement | null>,
) => {
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const button = trigger.current;
      if (button !== null && !button.disabled) button.focus();
      else group.current?.focus();
    }
    wasOpen.current = open;
  }, [open, trigger, group]);
};
