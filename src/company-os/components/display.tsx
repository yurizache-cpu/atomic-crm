import { useId, type ReactNode } from "react";
import { Link } from "react-router";

import { Badge } from "@/components/ui/badge";

import type { Money } from "../../../contracts/company-os-api/index.ts";
import { formatTimestamp, humanize, yesNo } from "../format/labels";
import { recordPath, type RecordKind } from "./recordPaths";
import { toneOf } from "./tones";

// The building blocks every Company OS screen renders with: React-escaped text
// only, badges for states, internal router links for ids, money and counts
// exactly as the server sent them (docs/PHASE_2C_BRIEF.md §6.2, §12).

export const ScreenLayout = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) => (
  <div className="flex flex-col gap-6">
    <div className="flex flex-col gap-1">
      <h1 className="text-xl font-semibold">{title}</h1>
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
    <section aria-labelledby={headingId} className="flex flex-col gap-3">
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
}) => <Badge variant={toneOf(value)}>{label ?? humanize(value)}</Badge>;

export const None = ({ children = "none" }: { children?: string }) => (
  <span className="text-muted-foreground">{children}</span>
);

export const Timestamp = ({ value }: { value: string | null }) =>
  value === null ? (
    <None />
  ) : (
    <time dateTime={value}>{formatTimestamp(value)}</time>
  );

/** The server's USD string, verbatim: the browser does no money arithmetic. */
export const MoneyText = ({ value }: { value: Money | null }) =>
  value === null ? <None /> : <span>{`${value.usd} USD`}</span>;

export const YesNo = ({ value }: { value: boolean }) => (
  <span>{yesNo(value)}</span>
);

/** An id as text, for a record the module has no page for. */
export const IdText = ({ id }: { id: string | null }) =>
  id === null ? <None /> : <span className="font-mono text-xs">{id}</span>;

/**
 * A record's id as an internal router link, or as text when it is not a uuid.
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
      className="font-mono text-xs underline underline-offset-4"
    >
      {children ?? id}
    </Link>
  );
};

/** Several run ids, each linking to its run; "none" when empty. */
export const RunLinks = ({ ids }: { ids: readonly string[] }) =>
  ids.length === 0 ? (
    <None />
  ) : (
    <span className="flex flex-wrap gap-2">
      {ids.map((id) => (
        <RecordLink key={id} kind="run" id={id} />
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
    className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[max-content_1fr]"
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
