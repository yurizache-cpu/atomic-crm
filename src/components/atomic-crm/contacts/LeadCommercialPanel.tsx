import { CreateBase, EditBase, Form, useGetList, useNotify } from "ra-core";
import { Card, CardContent } from "@/components/ui/card";
import { BooleanInput } from "@/components/admin/boolean-input";
import { DateTimeInput } from "@/components/admin/date-time-input";
import { SaveButton } from "@/components/admin/form";
import { TextInput } from "@/components/admin/text-input";
import { SelectInput } from "@/components/admin/select-input";

import type { AcquisitionAttribution, Contact, LeadProfile } from "../types";

const operationalStatusChoices = [
  { id: "active", name: "Ativo" },
  { id: "awaiting_lead", name: "Aguardando lead" },
  { id: "follow_up_due", name: "Acompanhamento pendente" },
  { id: "maturing", name: "Em maturação" },
  { id: "paused", name: "Pausado" },
];

/**
 * Commercial metadata is intentionally kept separate from the contact's
 * free-form fields. It exposes the minimum lead information without creating
 * a clinical record or a second follow-up system.
 */
export const LeadCommercialPanel = ({ contact }: { contact: Contact }) => {
  const { data: profiles, isPending: profilePending } = useGetList<LeadProfile>(
    "lead_profiles",
    {
      filter: { contact_id: contact.id },
      pagination: { page: 1, perPage: 1 },
      sort: { field: "id", order: "ASC" },
    },
  );
  const { data: attributions, isPending: attributionPending } =
    useGetList<AcquisitionAttribution>("acquisition_attributions", {
      filter: { contact_id: contact.id },
      pagination: { page: 1, perPage: 1 },
      sort: { field: "acquired_at", order: "DESC" },
    });

  if (profilePending || attributionPending) return null;

  const profile = profiles?.[0];
  const attribution = attributions?.[0];

  return (
    <Card className="mt-4">
      <CardContent className="space-y-6">
        <div>
          <h3 className="text-base font-semibold">Perfil comercial</h3>
          <p className="text-xs text-muted-foreground mt-1">
            Use somente informações comerciais e administrativas. Este sistema
            não é um prontuário clínico.
          </p>
        </div>
        {profile ? (
          <LeadProfileForm profile={profile} />
        ) : (
          <p className="text-sm text-muted-foreground">
            O perfil comercial será criado ao salvar o lead.
          </p>
        )}
        <div className="border-t pt-5">
          <h3 className="text-base font-semibold mb-4">Origem de aquisição</h3>
          {attribution ? (
            <AttributionForm attribution={attribution} />
          ) : (
            <AttributionCreateForm contactId={contact.id} />
          )}
        </div>
      </CardContent>
    </Card>
  );
};

const LeadProfileForm = ({ profile }: { profile: LeadProfile }) => {
  const notify = useNotify();

  return (
    <EditBase
      resource="lead_profiles"
      id={profile.id}
      mutationMode="pessimistic"
      mutationOptions={{
        onSuccess: () => notify("Perfil comercial atualizado."),
      }}
    >
      <Form>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <SelectInput
            source="operational_status"
            label="Status operacional"
            choices={operationalStatusChoices}
            helperText="Não altera a etapa comercial no Kanban."
          />
          <DateTimeInput
            source="next_action_at"
            label="Próxima ação"
            helperText="Crie e conclua a tarefa correspondente na área de tarefas."
          />
          <DateTimeInput source="acquired_at" label="Adquirido em" />
          <DateTimeInput
            source="last_interaction_at"
            label="Última interação"
          />
          <BooleanInput source="do_not_contact" label="Não contatar" />
        </div>
        <SaveButton label="Salvar perfil comercial" />
      </Form>
    </EditBase>
  );
};

const AttributionFields = () => (
  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
    <TextInput source="source" label="Origem" helperText={false} />
    <TextInput source="medium" label="Canal" helperText={false} />
    <TextInput source="campaign" label="Campanha" helperText={false} />
    <TextInput source="campaign_id" label="ID da campanha" helperText={false} />
    <TextInput source="landing_page" label="Landing page" helperText={false} />
    <TextInput source="gclid" label="GCLID" helperText={false} />
    <DateTimeInput source="acquired_at" label="Adquirido em" />
  </div>
);

const AttributionForm = ({
  attribution,
}: {
  attribution: AcquisitionAttribution;
}) => {
  const notify = useNotify();

  return (
    <EditBase
      resource="acquisition_attributions"
      id={attribution.id}
      mutationMode="pessimistic"
      mutationOptions={{ onSuccess: () => notify("Origem atualizada.") }}
    >
      <Form>
        <AttributionFields />
        <SaveButton label="Salvar origem" />
      </Form>
    </EditBase>
  );
};

const AttributionCreateForm = ({ contactId }: { contactId: Contact["id"] }) => {
  const notify = useNotify();

  return (
    <CreateBase
      resource="acquisition_attributions"
      record={{ contact_id: contactId }}
      redirect={false}
      mutationOptions={{ onSuccess: () => notify("Origem registrada.") }}
    >
      <Form defaultValues={{ contact_id: contactId }}>
        <AttributionFields />
        <SaveButton label="Registrar origem" />
      </Form>
    </CreateBase>
  );
};
