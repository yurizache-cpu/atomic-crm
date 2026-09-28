import { useRuntime } from "../session/runtime";
import { BackToCrmLink, SignedOutState } from "./AccessStates";
import { SecondFactorFlow } from "./SecondFactorFlow";

// Production Security Gate A: the Company OS server refuses a session below
// multi-factor assurance level 2 as "not signed in" (ops.operator_scope). When
// the auth provider still holds a session that lacks its second factor, the
// shared flow (SecondFactorFlow.tsx) completes it with the provider's own
// authenticator-app factor. Anything else is the plain signed-out state.

/** The signed-out state, or the second factor a live session still needs. */
export const SignedOutOrSecondFactor = ({
  signOutFailed,
}: {
  signOutFailed: boolean;
}) => {
  const { mfa } = useRuntime();
  const signedOut = <SignedOutState signOutFailed={signOutFailed} />;
  if (mfa === undefined || signOutFailed) return signedOut;
  return (
    <SecondFactorFlow
      mfa={mfa}
      subject="O Company OS"
      footer={<BackToCrmLink />}
      fallback={signedOut}
    />
  );
};
