import { Link } from "react-router";

import { ScreenLayout } from "../../components/display";
import { QueryView } from "../../components/queryStates";
import { RecordNotFound } from "../../components/RecordNotFound";
import { LIST_PATHS, recordPath } from "../../components/recordPaths";
import { useRouteRecordId } from "../../components/routeRecord";
import { useConversation } from "../../query/useConversation";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import { ConversationView } from "./ConversationView";
import { BACK_TO_INBOX, CONVERSATION_TITLE, TASK_LINK } from "./inboxCopy";
import { useConversationActs } from "./useConversationActs";

// The explicit open of one conversation (ADR 0026 §E): the route carries only
// the task reference a waiting-list row named, never navigation state, and
// the conversation is read only while this page is open. What the member is
// writing and what the acts last answered live here, above the read's loading
// and error states, so a failed poll shows its error and a retry gives the
// text back; the page is keyed by the reference, so another conversation
// starts empty.

const ConversationPage = ({ taskRef }: { taskRef: string }) => {
  const conversation = useConversation(taskRef);
  const current = useIsStateCurrent(conversation.dataUpdatedAt);
  const acts = useConversationActs(taskRef);
  return (
    <QueryView query={conversation} what="a conversa">
      {(data) => (
        <ConversationView conversation={data} current={current} acts={acts} />
      )}
    </QueryView>
  );
};

export const ConversationRoute = () => {
  const taskRef = useRouteRecordId("ref");
  const taskPath = taskRef === null ? null : recordPath("task", taskRef);
  return (
    <ScreenLayout title={CONVERSATION_TITLE}>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <Link to={LIST_PATHS.inbox} className="underline underline-offset-4">
          {BACK_TO_INBOX}
        </Link>
        {taskPath === null ? null : (
          <Link to={taskPath} className="underline underline-offset-4">
            {TASK_LINK}
          </Link>
        )}
      </div>
      {taskRef === null ? (
        <RecordNotFound />
      ) : (
        <ConversationPage key={taskRef} taskRef={taskRef} />
      )}
    </ScreenLayout>
  );
};
