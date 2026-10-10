import { Link } from "react-router";

import type {
  WaitingList,
  WaitingListItem,
} from "../../../../contracts/company-os-api/index.ts";
import { Note, Section } from "../../components/display";
import { RelativeTime } from "../../components/owner";
import { recordPath } from "../../components/recordPaths";
import {
  WAITING_LIST_EMPTY,
  WAITING_LIST_TITLE,
  WAITING_WINDOW_CLOSED,
  waitingListTruncatedNote,
  waitingMessages,
  waitingWindowOpen,
} from "../../copy";
import {
  clockTime,
  waitingKindLabel,
  waitingNotificationLabel,
} from "../../format/ptBR";

// ADR 0026 §D: who waits for a person now, oldest first, as the overview
// reports it: the kinds and their counts, since when, the 24-hour window the
// contact's last message opened, and the state of the owner's notification.
// Read only: each row opens the conversation in the Fila de atendimento
// (ADR 0026 §E), by the task of its oldest open episode; the conversation is
// read only once it is opened. No text, number or name is shown here.

const windowText = (item: WaitingListItem, asOf: string): string =>
  item.windowEndsAt === null || item.windowEndsAt <= asOf
    ? WAITING_WINDOW_CLOSED
    : waitingWindowOpen(clockTime(item.windowEndsAt));

const countsText = (item: WaitingListItem): string =>
  item.kinds
    .map(
      (kind) =>
        `${waitingKindLabel(kind)} (${waitingMessages(item.counts[kind] ?? 0)})`,
    )
    .join(" · ");

const WaitingRow = ({
  item,
  asOf,
}: {
  item: WaitingListItem;
  asOf: string;
}) => {
  const to = recordPath("conversation", item.ref);
  const label = countsText(item);
  return (
    <li className="flex flex-col gap-1 rounded-lg border px-3 py-2 text-sm">
      {to === null ? (
        <span className="font-medium">{label}</span>
      ) : (
        <Link
          to={to}
          className="font-medium text-primary underline-offset-4 hover:underline"
        >
          {label}
        </Link>
      )}
      <span className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
        <span>
          na fila <RelativeTime value={item.waitingSince} />
        </span>
        <span>{windowText(item, asOf)}</span>
        <span>
          {waitingNotificationLabel(item.notification.state)}
          {item.notification.at === null ? null : (
            <>
              {" "}
              <RelativeTime value={item.notification.at} />
            </>
          )}
        </span>
      </span>
    </li>
  );
};

/**
 * The waiting conversations, oldest first, each opening its conversation; the
 * empty and truncated notes. Shared by the overview and the Fila de
 * atendimento.
 */
export const WaitingListItems = ({
  list,
  asOf,
}: {
  list: WaitingList;
  asOf: string;
}) =>
  list.items.length === 0 ? (
    <Note>{WAITING_LIST_EMPTY}</Note>
  ) : (
    <>
      <ul className="flex flex-col gap-2">
        {list.items.map((item) => (
          <WaitingRow key={item.ref} item={item} asOf={asOf} />
        ))}
      </ul>
      {list.total > list.items.length ? (
        <Note>{waitingListTruncatedNote(list.total, list.items.length)}</Note>
      ) : null}
    </>
  );

/** The overview's waiting list; nothing when the database does not carry it yet. */
export const WaitingListSection = ({
  list,
  asOf,
  current,
}: {
  list: WaitingList | undefined;
  asOf: string;
  current: boolean;
}) => {
  if (list === undefined) return null;
  return (
    <Section title={WAITING_LIST_TITLE}>
      {current ? (
        <WaitingListItems list={list} asOf={asOf} />
      ) : (
        <Note>Desconhecido: aguardando uma resposta nova.</Note>
      )}
    </Section>
  );
};
