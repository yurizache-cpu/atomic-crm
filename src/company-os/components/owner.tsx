import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { cn } from "@/lib/utils";

import type { Money } from "../../../contracts/company-os-api/index.ts";
import {
  exactMoney,
  exactTime,
  moneyLabel,
  relativeTime,
  type Tone,
} from "../format/ptBR";

// The owner experience's building blocks: human meaning first, technical
// evidence second. Every value is still the server's; these only present it.
// Colours follow one rule: green healthy, blue working, amber waiting or
// attention, red stopped or failed, gray inactive or idle. The label is always
// printed, so nothing depends on a colour.

const TONE_DOT: Record<Tone, string> = {
  green: "bg-emerald-500",
  blue: "bg-sky-500",
  amber: "bg-amber-500",
  red: "bg-rose-500",
  gray: "bg-muted-foreground/60",
};

const TONE_CHIP: Record<Tone, string> = {
  green:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  blue: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  amber:
    "border-amber-500/30 bg-amber-500/10 text-amber-800 dark:text-amber-300",
  red: "border-rose-500/30 bg-rose-500/10 text-rose-700 dark:text-rose-300",
  gray: "border-border bg-muted text-muted-foreground",
};

export const StatusChip = ({ tone, label }: { tone: Tone; label: string }) => (
  <span
    className={cn(
      "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium",
      TONE_CHIP[tone],
    )}
  >
    <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[tone])} />
    {label}
  </span>
);

export const OwnerCard = ({
  children,
  className,
  label,
}: {
  children: ReactNode;
  className?: string;
  label?: string;
}) => (
  <article
    aria-label={label}
    className={cn(
      "rounded-xl border bg-card p-4 text-card-foreground shadow-sm",
      className,
    )}
  >
    {children}
  </article>
);

/** A headline number that links to the list proving it; "desconhecido" when stale. */
export const StatCard = ({
  icon: Icon,
  label,
  value,
  to,
  tone = "gray",
  hint,
  current = true,
}: {
  icon: LucideIcon;
  label: string;
  value: string | number;
  to?: string;
  tone?: Tone;
  hint?: string;
  current?: boolean;
}) => {
  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className={cn("rounded-lg p-2", TONE_CHIP[tone])}>
          <Icon aria-hidden className="size-4" />
        </span>
      </div>
      <div className="mt-2 text-3xl font-semibold tracking-tight">
        {current ? value : "—"}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {current ? (hint ?? " ") : "Desconhecido"}
      </p>
    </>
  );
  const className =
    "block rounded-xl border bg-card p-4 shadow-sm transition-colors hover:bg-accent/40";
  return to !== undefined && current ? (
    <Link to={to} aria-label={`${label}: ${value}`} className={className}>
      {body}
    </Link>
  ) : (
    <div className={className}>{body}</div>
  );
};

/** The collapsed "Detalhes técnicos" every card keeps its evidence in. */
export const TechnicalDetails = ({
  rows,
  children,
}: {
  rows?: readonly (readonly [string, ReactNode])[];
  children?: ReactNode;
}) => (
  <details className="group mt-3 rounded-lg border border-dashed px-3 py-2 text-xs">
    <summary className="cursor-pointer select-none text-muted-foreground">
      Detalhes técnicos
    </summary>
    <dl className="mt-2 grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-[max-content_1fr]">
      {(rows ?? []).map(([term, value]) => (
        <div key={term} className="contents">
          <dt className="text-muted-foreground">{term}</dt>
          <dd className="min-w-0 break-all font-mono">{value}</dd>
        </div>
      ))}
    </dl>
    {children}
  </details>
);

export const RelativeTime = ({
  value,
  empty = "—",
}: {
  value: string | null;
  empty?: string;
}) =>
  value === null ? (
    <span className="text-muted-foreground">{empty}</span>
  ) : (
    <time dateTime={value} title={exactTime(value)}>
      {relativeTime(value)}
    </time>
  );

export const MoneyValue = ({ value }: { value: Money | null }) =>
  value === null ? (
    <span className="text-muted-foreground">—</span>
  ) : (
    <span title={exactMoney(value)}>{moneyLabel(value)}</span>
  );

export const EmptyState = ({
  icon: Icon,
  title,
  text,
}: {
  icon: LucideIcon;
  title: string;
  text?: string;
}) => (
  <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed px-6 py-10 text-center">
    <Icon aria-hidden className="size-8 text-muted-foreground" />
    <p className="font-medium">{title}</p>
    {text === undefined ? null : (
      <p className="max-w-md text-sm text-muted-foreground">{text}</p>
    )}
  </div>
);

/** A small "label: value" line inside a card. */
export const Meta = ({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) => (
  <span className="text-xs text-muted-foreground">
    {`${label}: `}
    <span className="text-foreground">{children}</span>
  </span>
);
