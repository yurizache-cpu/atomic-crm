import {
  AlarmClock,
  CalendarClock,
  CalendarDays,
  CalendarRange,
  ListChecks,
  RefreshCw,
} from "lucide-react";

import type {
  Agenda,
  BookingSummary,
  FollowUpSummary,
  OverviewSummary,
} from "../../../../contracts/company-os-api/index.ts";
import {
  Field,
  Fields,
  Note,
  RecordLink,
  ScreenLayout,
  Section,
} from "../../components/display";
import {
  EmptyState,
  OwnerCard,
  RelativeTime,
  StatCard,
  StatusChip,
  TechnicalDetails,
} from "../../components/owner";
import { QueryView } from "../../components/queryStates";
import { STATE_UNKNOWN_NOTE } from "../../copy";
import { useCompanyOsQuery } from "../../query/useCompanyOsQuery";
import { useIsStateCurrent } from "../../query/useIsStateCurrent";
import {
  bookingSpan,
  bookingStatusLabel,
  bookingStatusTone,
  byLocalDay,
  CALENDAR_STATE_TEXT,
  calendarAttention,
  calendarSyncLabel,
  followUpStateLabel,
  followUpStep,
  followUpTone,
  localDayTime,
  longDate,
  nextFreeSlot,
  reasonLabel,
} from "./agendaModel";

// Agenda (Phase 3A): what is booked today and next, which follow-ups need
// action, the next free times and whether a calendar mirrors the bookings.
// Every value is the overview's agenda, built by the database from its own
// rows; times are shown in the agenda's own time zone. READ ONLY: nothing here
// books, reschedules, cancels or completes anything (the browser has exactly
// its two acts, and neither is on this screen); every control is a link. The
// overview is read every 15 s while the tab is visible, and an answer older
// than two polling intervals shows every value as "Desconhecido".

const plural = (n: number, one: string, many: string): string =>
  `${n} ${n === 1 ? one : many}`;

const HeadlineCards = ({
  agenda,
  current,
}: {
  agenda: Agenda;
  current: boolean;
}) => {
  const next = nextFreeSlot(agenda.availability);
  const attention = calendarAttention(agenda);
  const { bookings, followUps } = agenda;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
      <StatCard
        icon={CalendarDays}
        label="Hoje"
        value={bookings.todayBooked}
        tone={bookings.todayBooked > 0 ? "blue" : "gray"}
        hint="Atendimentos agendados para hoje"
        current={current}
      />
      <StatCard
        icon={CalendarRange}
        label="Próximos 7 dias"
        value={bookings.next7DaysBooked}
        tone={bookings.next7DaysBooked > 0 ? "blue" : "gray"}
        hint="Atendimentos agendados a partir de amanhã"
        current={current}
      />
      <StatCard
        icon={AlarmClock}
        label="Follow-ups vencidos"
        value={followUps.overdue}
        tone={followUps.overdue > 0 ? "amber" : "green"}
        hint={
          followUps.due > 0
            ? `${plural(followUps.due, "precisa", "precisam")} de ação no total`
            : "Nenhum precisa de ação"
        }
        current={current}
      />
      <StatCard
        icon={ListChecks}
        label="Follow-ups hoje"
        value={followUps.dueToday}
        tone={followUps.dueToday > 0 ? "amber" : "gray"}
        hint="Vencem hoje, feitos ou não"
        current={current}
      />
      <StatCard
        icon={CalendarClock}
        label="Próximo horário livre"
        value={
          next === null
            ? "Sem horários"
            : localDayTime(next.startAt, agenda.timezone)
        }
        tone={next === null ? "gray" : "green"}
        hint={
          next === null
            ? "Nenhum horário livre nos próximos 14 dias"
            : `${next.pair.resource.label} · ${next.pair.bookingType.label}`
        }
        current={current}
      />
      <StatCard
        icon={RefreshCw}
        label="Sincronização"
        value={CALENDAR_STATE_TEXT[agenda.calendar.state].title}
        tone={attention > 0 ? "amber" : "gray"}
        hint={
          attention > 0
            ? `${plural(attention, "sincronização incerta ou com falha", "sincronizações incertas ou com falha")}`
            : "Google Agenda: não conectado"
        }
        current={current}
      />
    </div>
  );
};

const BookingRow = ({ booking }: { booking: BookingSummary }) => {
  const sync = calendarSyncLabel(booking.calendarSync);
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
      <span className="w-28 font-mono text-sm tabular-nums">
        {bookingSpan(booking)}
      </span>
      <span className="font-medium">{booking.bookingType.label}</span>
      <span className="text-sm text-muted-foreground">
        {booking.resource.label}
      </span>
      <StatusChip
        tone={bookingStatusTone(booking)}
        label={bookingStatusLabel(booking)}
      />
      {booking.cancelReason === null ? null : (
        <span className="text-xs text-muted-foreground">
          {`Motivo: ${reasonLabel(booking.cancelReason)}`}
        </span>
      )}
      {sync === null ? null : (
        <StatusChip tone={sync.tone} label={sync.label} />
      )}
      {booking.taskId === null ? null : (
        <RecordLink kind="task" id={booking.taskId} label="Tarefa relacionada">
          Tarefa
        </RecordLink>
      )}
    </li>
  );
};

const TodaySection = ({ agenda }: { agenda: Agenda }) => (
  <Section title="Agenda de hoje">
    <Note>{`${longDate(agenda.today)} · horários em ${agenda.timezone}`}</Note>
    {agenda.bookings.today.length === 0 ? (
      <EmptyState icon={CalendarDays} title="Nenhum atendimento hoje." />
    ) : (
      <ul aria-label="Atendimentos de hoje">
        {agenda.bookings.today.map((booking) => (
          <BookingRow key={booking.id} booking={booking} />
        ))}
      </ul>
    )}
  </Section>
);

const UpcomingSection = ({ agenda }: { agenda: Agenda }) => (
  <Section title="Próximos horários">
    {agenda.bookings.upcoming.length === 0 ? (
      <EmptyState
        icon={CalendarRange}
        title="Nenhum atendimento nos próximos 7 dias."
      />
    ) : (
      byLocalDay(agenda.bookings.upcoming).map((group) => (
        <div key={group.day} className="flex flex-col gap-1">
          <h3 className="text-sm font-medium capitalize">{group.day}</h3>
          <ul aria-label={`Atendimentos de ${group.day}`}>
            {group.items.map((booking) => (
              <BookingRow key={booking.id} booking={booking} />
            ))}
          </ul>
        </div>
      ))
    )}
    {agenda.bookings.changes.length === 0 ? null : (
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">
          Cancelados ou remarcados nesta semana
        </h3>
        <ul aria-label="Cancelados ou remarcados">
          {agenda.bookings.changes.map((booking) => (
            <BookingRow key={booking.id} booking={booking} />
          ))}
        </ul>
      </div>
    )}
  </Section>
);

const FollowUpRow = ({
  followUp,
  timeZone,
}: {
  followUp: FollowUpSummary;
  timeZone: string;
}) => (
  <li className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 last:border-b-0">
    <span className="font-medium">{followUpStep(followUp)}</span>
    <span className="text-sm text-muted-foreground">
      {followUp.policy.label}
    </span>
    <StatusChip
      tone={followUpTone(followUp)}
      label={followUpStateLabel(followUp)}
    />
    <span className="text-sm">
      {`${followUp.status === "scheduled" && !followUp.awaitingProcessing ? "Vence" : "Venceu"} ${localDayTime(followUp.dueAt, timeZone)}`}
    </span>
    {followUp.closeReason === null ? null : (
      <span className="text-xs text-muted-foreground">
        {`Motivo: ${reasonLabel(followUp.closeReason)}`}
      </span>
    )}
    {followUp.taskId === null ? null : (
      <RecordLink kind="task" id={followUp.taskId} label="Tarefa acompanhada">
        Tarefa
      </RecordLink>
    )}
  </li>
);

const FollowUpList = ({
  title,
  items,
  timeZone,
  empty,
}: {
  title: string;
  items: readonly FollowUpSummary[];
  timeZone: string;
  empty: string;
}) => (
  <div className="flex flex-col gap-1">
    <h3 className="text-sm font-medium">{title}</h3>
    {items.length === 0 ? (
      <p className="text-sm text-muted-foreground">{empty}</p>
    ) : (
      <ul aria-label={title}>
        {items.map((followUp) => (
          <FollowUpRow
            key={followUp.id}
            followUp={followUp}
            timeZone={timeZone}
          />
        ))}
      </ul>
    )}
  </div>
);

const FollowUpsSection = ({ agenda }: { agenda: Agenda }) => {
  const { followUps } = agenda;
  return (
    <Section title="Follow-ups">
      <Note>
        Um follow-up que precisa de ação é trabalho do operador: o Company OS
        não envia mensagens sozinho.
      </Note>
      <FollowUpList
        title="Precisam de ação"
        items={followUps.needingAction}
        timeZone={agenda.timezone}
        empty="Nenhum follow-up precisa de ação agora."
      />
      <FollowUpList
        title="Agendados"
        items={followUps.scheduled}
        timeZone={agenda.timezone}
        empty="Nenhum follow-up agendado para os próximos dias."
      />
      <FollowUpList
        title="Encerrados recentemente"
        items={followUps.recentlyClosed}
        timeZone={agenda.timezone}
        empty="Nenhum follow-up encerrado nesta semana."
      />
      {followUps.awaitingProcessing > 0 ? (
        <Note>
          {`${plural(followUps.awaitingProcessing, "follow-up já venceu e aguarda", "follow-ups já venceram e aguardam")} processamento: o trabalhador não está ativo, ou uma pausa segura o trabalho.`}
        </Note>
      ) : null}
    </Section>
  );
};

const AvailabilitySection = ({ agenda }: { agenda: Agenda }) => (
  <Section title="Disponibilidade">
    {agenda.availability.length === 0 ? (
      <EmptyState
        icon={CalendarClock}
        title="Nenhuma agenda com disponibilidade configurada."
      />
    ) : (
      <div className="grid gap-3 md:grid-cols-2">
        {agenda.availability.map((pair) => (
          <OwnerCard
            key={`${pair.resource.id}:${pair.bookingType.id}`}
            label={`${pair.resource.label} · ${pair.bookingType.label}`}
          >
            <p className="font-medium">{pair.resource.label}</p>
            <p className="text-sm text-muted-foreground">
              {`${pair.bookingType.label} · ${pair.bookingType.durationMinutes} min`}
            </p>
            {pair.nextSlots.length === 0 ? (
              <p className="mt-2 text-sm">
                Sem horários livres nos próximos 14 dias.
              </p>
            ) : (
              <ul
                className="mt-2 flex flex-wrap gap-2"
                aria-label="Próximos horários livres"
              >
                {pair.nextSlots.map((slot) => (
                  <li
                    key={slot.startAt}
                    className="rounded-md border px-2 py-1 text-sm tabular-nums"
                  >
                    {localDayTime(slot.startAt, agenda.timezone)}
                  </li>
                ))}
              </ul>
            )}
          </OwnerCard>
        ))}
      </div>
    )}
  </Section>
);

const CalendarSection = ({ agenda }: { agenda: Agenda }) => {
  const state = CALENDAR_STATE_TEXT[agenda.calendar.state];
  const syncs = agenda.calendar.upcomingSyncs;
  return (
    <Section title="Calendário">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip
          tone={agenda.calendar.state === "simulated" ? "blue" : "gray"}
          label={state.title}
        />
        <StatusChip tone="gray" label="Google Agenda: não conectado" />
        {syncs.indeterminate > 0 ? (
          <StatusChip
            tone="amber"
            label={plural(
              syncs.indeterminate,
              "sincronização incerta",
              "sincronizações incertas",
            )}
          />
        ) : null}
      </div>
      <Note>{state.text}</Note>
      {agenda.calendar.state === "local_only" ? null : (
        <Fields label="Sincronização dos próximos atendimentos">
          <Field term="Sincronizados">{syncs.synced}</Field>
          <Field term="Pendentes">{syncs.pending + syncs.running}</Field>
          <Field term="Sincronização incerta">{syncs.indeterminate}</Field>
          <Field term="Falharam">{syncs.failed}</Field>
          <Field term="Sem evento no calendário">{syncs.skipped}</Field>
        </Fields>
      )}
      <Note>
        Uma sincronização incerta não é repetida automaticamente: o serviço pode
        ter recebido o pedido, e repetir poderia duplicar o evento.
      </Note>
      <TechnicalDetails
        rows={[
          ["Fuso da agenda", agenda.timezone],
          ["Fuso configurado", agenda.timezoneConfigured ? "Sim" : "Não (UTC)"],
          [
            "Conflitos de horário",
            `${agenda.bookings.conflicts} (o banco impede sobreposição)`,
          ],
        ]}
      />
    </Section>
  );
};

const AgendaBody = ({
  data,
  receivedAt,
}: {
  data: OverviewSummary;
  receivedAt: number;
}) => {
  const current = useIsStateCurrent(receivedAt);
  const agenda = data.agenda;
  return (
    <>
      {current ? null : (
        <p role="status" className="text-sm font-medium">
          {STATE_UNKNOWN_NOTE}
        </p>
      )}
      <HeadlineCards agenda={agenda} current={current} />
      {current ? (
        <>
          <div className="grid gap-6 lg:grid-cols-2">
            <TodaySection agenda={agenda} />
            <FollowUpsSection agenda={agenda} />
          </div>
          <UpcomingSection agenda={agenda} />
          <div className="grid gap-6 lg:grid-cols-2">
            <AvailabilitySection agenda={agenda} />
            <CalendarSection agenda={agenda} />
          </div>
        </>
      ) : null}
      <p className="text-xs text-muted-foreground">
        Dados do próprio Company OS. Somente leitura: agendar, remarcar,
        cancelar e concluir follow-ups acontece fora do navegador. Atualizado{" "}
        <RelativeTime value={data.asOf} />
      </p>
    </>
  );
};

export const AgendaScreen = () => {
  const overview = useCompanyOsQuery("overview", {}, { poll: true });
  return (
    <ScreenLayout
      title="Agenda"
      description="Veja horários, próximos atendimentos e follow-ups que precisam de ação."
    >
      <QueryView query={overview} what="a agenda">
        {(data) => (
          <AgendaBody data={data} receivedAt={overview.dataUpdatedAt} />
        )}
      </QueryView>
    </ScreenLayout>
  );
};
