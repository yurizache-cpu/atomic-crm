import {
  type Identifier,
  useDataProvider,
  useGetIdentity,
  useGetOne,
  useGetRecordRepresentation,
  useNotify,
  useTranslate,
  useUpdate,
} from "ra-core";
import { CreateSheet } from "../misc/CreateSheet";
import { foreignKeyMapping } from "../notes/foreignKeyMapping";
import { TaskFormContent } from "./TaskFormContent";
import { useQueryClient } from "@tanstack/react-query";
import type { LeadProfile } from "../types";

export interface TaskCreateSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contact_id?: Identifier;
}

export const TaskCreateSheet = ({
  open,
  onOpenChange,
  contact_id,
}: TaskCreateSheetProps) => {
  const { identity } = useGetIdentity();
  const translate = useTranslate();
  const getContactRepresentation = useGetRecordRepresentation("contacts");

  const selectContact = contact_id == null;
  const { data: contact } = useGetOne(
    "contacts",
    { id: contact_id! },
    { enabled: !selectContact },
  );
  const [update] = useUpdate();
  const dataProvider = useDataProvider();
  const queryClient = useQueryClient();
  const notify = useNotify();

  if (!identity) return null;

  const handleSuccess = async (data: any) => {
    const referenceRecordId = data[foreignKeyMapping["contacts"]];
    if (!referenceRecordId) return;
    const { data: contact } = await dataProvider.getOne("contacts", {
      id: referenceRecordId,
    });
    if (!contact) return;
    await update("contacts", {
      id: referenceRecordId as unknown as Identifier,
      data: { last_seen: new Date().toISOString() },
      previousData: contact,
    });
    const { data: profiles } = await dataProvider.getList<LeadProfile>(
      "lead_profiles",
      {
        filter: { contact_id: referenceRecordId },
        pagination: { page: 1, perPage: 1 },
        sort: { field: "id", order: "ASC" },
      },
    );
    const profile = profiles[0];
    if (profile) {
      await dataProvider.update("lead_profiles", {
        id: profile.id,
        data: { next_action_at: data.due_date },
        previousData: profile,
      });
    }
    queryClient.invalidateQueries({
      queryKey: ["contacts", "getOne"],
    });

    notify("resources.tasks.added");
    // No redirect, only close the sheet
    onOpenChange(false);
  };

  return (
    <CreateSheet
      resource="tasks"
      title={
        <span className="text-xl font-semibold truncate pr-10">
          {!selectContact
            ? translate("resources.tasks.dialog.create_for", {
                name: getContactRepresentation(contact!),
              })
            : translate("resources.tasks.dialog.create")}
        </span>
      }
      redirect={false}
      record={{
        type: "none",
        contact_id,
        due_date: new Date().toISOString(),
        sales_id: identity.id,
      }}
      mutationOptions={{
        onSuccess: handleSuccess,
      }}
      open={open}
      onOpenChange={onOpenChange}
    >
      <TaskFormContent selectContact={selectContact} />
    </CreateSheet>
  );
};
