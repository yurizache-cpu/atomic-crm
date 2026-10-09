import { Route, Routes } from "react-router";

import { ConversationRoute } from "./ConversationRoute";
import { InboxList } from "./InboxList";

// The Fila de atendimento (ADR 0026 §E): the waiting list, and one
// conversation on explicit open at #/company-os/inbox/<task reference>.

export const InboxScreen = () => (
  <Routes>
    <Route index element={<InboxList />} />
    <Route path=":ref" element={<ConversationRoute />} />
  </Routes>
);
