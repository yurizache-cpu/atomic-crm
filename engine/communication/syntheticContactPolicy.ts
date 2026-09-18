// The Phase 2A consent source: a fixture the CALLER builds from trusted
// configuration, never anything a delivery says.
//
// WHY IT EXISTS. Consent is a property of the contact, recorded by the
// business, not a claim the message makes about itself. Phase 2A does not yet
// read the CRM, so the pilot needs SOME trusted source, and the one thing it
// must never be is the inbound envelope — a message could otherwise declare its
// own sender contactable.
//
// FAIL CLOSED. Only a contact explicitly listed as eligible, and not also
// listed as blocked, may be contacted. Everyone else — including every contact
// this fixture has never heard of — is do-not-contact. Phase 2A sends nothing
// either way; the point is that the boundary is right before a transport that
// could cross it exists.
//
// PHASE 2B replaces this with a read-only CRM lookup behind the same
// ContactPolicy interface. Nothing here reads the CRM, by instruction.

import type { ContactPolicy } from "./types.ts";

export interface SyntheticContactPolicyConfig {
  /** Contacts that may be contacted, unless also blocked. */
  readonly eligible?: readonly string[];
  /** Contacts that must not be contacted. Wins over `eligible`. */
  readonly blocked?: readonly string[];
}

export function createSyntheticContactPolicy(
  config: SyntheticContactPolicyConfig,
): ContactPolicy {
  // Copied into Sets at construction, so a caller that later mutates the arrays
  // it passed cannot change an answer already relied on.
  const eligible = new Set(config.eligible ?? []);
  const blocked = new Set(config.blocked ?? []);
  return Object.freeze({
    doNotContact: (contactRef: string): boolean =>
      blocked.has(contactRef) || !eligible.has(contactRef),
  });
}
