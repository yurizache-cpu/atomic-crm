import { useSearchParams } from "react-router";

import { uuidOrNull } from "../format/labels";
import { useCompanyOsQuery } from "../query/useCompanyOsQuery";
import { SearchParamSelect } from "./SearchParamSelect";

/**
 * The agent filter of the Tasks and Agent runs lists: its options are the
 * tenant's agents as list_agents answered (not polled here). An agent filter
 * already in the address is always shown as the selected option: by name once
 * list_agents has answered with that agent, and as "agent <id>" before it
 * does, if it fails, or if the agent is not in the answer, so the select never
 * reads "All agents" while the list below is narrowed to one.
 */
export const AgentFilter = () => {
  const [params] = useSearchParams();
  const agents = useCompanyOsQuery("list_agents", {});
  const options =
    agents.data?.items.map((agent) => ({
      value: agent.id,
      label: agent.name,
    })) ?? [];
  const active = uuidOrNull(params.get("agent"));
  const shown =
    active === null || options.some((option) => option.value === active)
      ? options
      : [{ value: active, label: `agente ${active}` }, ...options];
  return (
    <SearchParamSelect
      label="Agente"
      param="agent"
      options={shown}
      allLabel="Todos os agentes"
    />
  );
};
