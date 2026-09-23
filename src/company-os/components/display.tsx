import { useId, type ReactNode } from "react";
import { Link } from "react-router";

import type { Money } from "../../../contracts/company-os-api/index.ts";
import { stateLabel, toneOfState, yesNoLabel } from "../format/ptBR";
import { MoneyValue, RelativeTime, StatusChip } from "./owner";
import { recordPath, type RecordKind } from "./recordPaths";

// The building blocks every Company OS screen renders with: React-escaped text
// only, status chips for states, internal router links for ids, money and
// counts exactly as the server sent them (docs/PHASE_2C_BRIEF.md §6.2, §12),
// presented in Brazilian Portuguese for the owner.

export const ScreenLayout = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) => (
  <div className="mx-auto flex w-full max-w-6xl flex-col gap-6">
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
      {description === undefined ? null : (
        <p className="text-sm text-muted-foreground">{description}</p>
      )}
    </div>
    {children}
  </div>
);

export const Section = ({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) => {
  const headingId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-xl border bg-card p-4 shadow-sm"
    >
      <h2 id={headingId} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
};

/** A fixed explanation next to the data; never a control. */
export const Note = ({ children }: { children: ReactNode }) => (
  <p className="text-sm text-muted-foreground">{children}</p>
);

export const StateBadge = ({
  value,
  label,
}: {
  value: string;
  label?: string;
}) => (
  <StatusChip tone={toneOfState(value)} label={label ?? stateLabel(value)} />
);

export const None = ({ children = "—" }: { children?: string }) => (
  <span className="text-muted-foreground">{children}</span>
);

export const Timestamp = ({ value }: { value: string | null }) => (
  <RelativeTime value={value} />
);

/** The server's amount, formatted for the owner; the exact figure is its title. */
export const MoneyText = ({ value }: { value: Money | null }) => (
  <MoneyValue value={value} />
);

export const YesNo = ({ value }: { value: boolean }) => (
  <span>{yesNoLabel(value)}</span>
);

/** An id as text, for a record the module has no page for. */
export const IdText = ({ id }: { id: string | null }) =>
  id === null ? <None /> : <span className="font-mono text-xs">{id}</span>;

/**
 * A record as an internal router link, or as text when it is not a uuid.
 * The link never leaves #/company-os (components/recordPaths.ts).
 */
export const RecordLink = ({
  kind,
  id,
  children,
  label,
}: {
  kind: RecordKind;
  id: string;
  children?: string;
  label?: string;
}) => {
  const path = recordPath(kind, id);
  if (path === null) return <IdText id={id} />;
  return (
    <Link
      to={path}
      aria-label={label}
      className={
        children === undefined
          ? "font-mono text-xs text-primary underline underline-offset-4"
          : "font-medium text-primary underline-offset-4 hover:underline"
      }
    >
      {children ?? id}
    </Link>
  );
};

/** Several runs, each linking to its run; "—" when empty. */
export const RunLinks = ({ ids }: { ids: readonly string[] }) =>
  ids.length === 0 ? (
    <None />
  ) : (
    <span className="flex flex-wrap gap-2">
      {ids.map((id, index) => (
        <RecordLink key={id} kind="run" id={id} label={`Execução ${id}`}>
          {`Execução ${index + 1}`}
        </RecordLink>
      ))}
    </span>
  );

export const Fields = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <dl
    aria-label={label}
    className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[max-content_1fr]"
  >
    {children}
  </dl>
);

export const Field = ({
  term,
  children,
}: {
  term: string;
  children: ReactNode;
}) => (
  <>
    <dt className="text-sm text-muted-foreground">{term}</dt>
    <dd className="min-w-0 text-sm break-words">{children}</dd>
  </>
);
