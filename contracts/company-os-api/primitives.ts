// The shapes every Company OS projection is built from (docs/PHASE_2C_BRIEF.md
// §9, §11): ids, timestamps, money, counts, the `{ v, asOf }` envelope and the
// opaque page cursor, each exactly as the SQL emits it.
//
// Every object schema in this directory is STRICT: a key the contract does not
// name fails parsing, so a projection that grows a field renders an error
// instead of the value. That is a tripwire, not the boundary; the boundary is
// the projection itself.

import { z } from "zod";

/** A uuid as PostgreSQL prints it: lower-case hex, hyphenated. */
export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const UuidSchema = z.string().regex(UUID_PATTERN);

/** ops.cos_ts: UTC, six fractional digits, 'Z' (YYYY-MM-DDTHH:MM:SS.ffffffZ). */
export const TimestampSchema = z.iso.datetime({ precision: 6 });

/** A SQL count: a non-negative integer, never a string. */
export const CountSchema = z.int().nonnegative();

const codePoints = (value: string): number => [...value].length;

/**
 * Free text the database bounds only by char_length, which counts code points
 * (a zod `.max()` counts UTF-16 units and would refuse a valid astral
 * character). The empty string included: a decision note is stored as given.
 */
export const textUpToSchema = (maxCodePoints: number) =>
  z.string().refine((value) => codePoints(value) <= maxCodePoints, {
    message: `at most ${maxCodePoints} characters`,
  });

/** Free text of 1 to `maxCodePoints` characters. */
export const boundedTextSchema = (maxCodePoints: number) =>
  z
    .string()
    .min(1)
    .refine((value) => codePoints(value) <= maxCodePoints, {
      message: `at most ${maxCodePoints} characters`,
    });

/**
 * An owner-typed configuration label: a company, department or agent name
 * (1 to 200 characters once trimmed). A tenant's name has no such check in
 * the database, so OperatorContext takes any string for it.
 */
export const NameSchema = z.string().min(1);

/** ops.communication_channels.label: 1 to 100 printable ASCII characters, not all blank. */
export const ChannelLabelSchema = z
  .string()
  .regex(/^[\x20-\x7e]{1,100}$/)
  .regex(/\S/);

/** A kebab-case slug (ops.agents.slug and its siblings). */
export const SlugSchema = z
  .string()
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

/** A dotted identifier: a task type or a capability. */
export const DottedNameSchema = z
  .string()
  .max(100)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/);

/** A snake_case reason or class code (blocked_reason, error_class, ...). */
export const ReasonCodeSchema = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);

const MICROS_PATTERN = /^(0|-?[1-9][0-9]{0,18})$/;
const USD_PATTERN = /^-?(0|[1-9][0-9]*)\.[0-9]{6}$/;

/**
 * ops.cos_money's USD string for a micros string: the sign, the whole dollars
 * and exactly six decimals. The browser never does this arithmetic; the
 * contract only checks the server did it consistently.
 */
export const formatMicrosAsUsd = (micros: string): string => {
  const negative = micros.startsWith("-");
  const digits = (negative ? micros.slice(1) : micros).padStart(7, "0");
  const whole = digits.slice(0, -6).replace(/^0+(?=[0-9])/, "");
  // Concatenation rather than a template: the production-scope guard reads a
  // template that joins interpolations around a dot as a brace glob.
  return (negative ? "-" : "") + whole + "." + digits.slice(-6);
};

/** Money: bigint micros as a string, plus the USD string SQL formatted from it. */
export const MoneySchema = z
  .strictObject({
    micros: z.string().regex(MICROS_PATTERN),
    usd: z.string().regex(USD_PATTERN),
  })
  .refine((money) => money.usd === formatMicrosAsUsd(money.micros), {
    message: "usd does not match micros",
    path: ["usd"],
  });

/** Every response starts with the envelope. */
export const ENVELOPE_SHAPE = {
  v: z.literal(1),
  asOf: TimestampSchema,
} as const;

export const EnvelopeSchema = z.strictObject(ENVELOPE_SHAPE);

/** A row of the caller's own tenant, by id alone. */
export const IdRefSchema = z.strictObject({ id: UuidSchema });

/** A row of the caller's own tenant, by id and its configuration label. */
export const NamedRefSchema = z.strictObject({
  id: UuidSchema,
  name: NameSchema,
});

/** The cursor kind of each paged read (brief §11). */
export const CURSOR_KINDS = {
  tasks: "tk",
  runs: "rn",
  reviews: "rv",
  events: "ev",
  stops: "st",
} as const;

export type CursorKind = (typeof CURSOR_KINDS)[keyof typeof CURSOR_KINDS];

/** `<kind>1:<uuid of the last row returned>`: nothing else can hide in it. */
export const cursorOf = (kind: CursorKind, id: string): string =>
  `${kind}1:${id}`;

export const cursorSchema = (kind: CursorKind) =>
  z.string().regex(new RegExp(`^${kind}1:${UUID_PATTERN.source.slice(1)}`));

/** 1 to 100; the server's default is 50. */
export const PageLimitSchema = z.int().min(1).max(100);

const pageShape = <T extends z.ZodType<{ id: string }>>(
  kind: CursorKind,
  item: T,
) => ({
  items: z.array(item).max(100),
  nextCursor: cursorSchema(kind).nullable(),
});

const nextCursorIsLastItem =
  (kind: CursorKind) =>
  (page: {
    items: readonly { id: string }[];
    nextCursor: string | null;
  }): boolean =>
    page.nextCursor === null ||
    (page.items.length > 0 &&
      page.nextCursor === cursorOf(kind, page.items[page.items.length - 1].id));

const NEXT_CURSOR_MESSAGE = {
  message: "nextCursor must name the last item",
  path: ["nextCursor"],
};

/** A page nested in another response: `{ items, nextCursor }`. */
export const pageSchema = <T extends z.ZodType<{ id: string }>>(
  kind: CursorKind,
  item: T,
) =>
  z
    .strictObject(pageShape(kind, item))
    .refine(nextCursorIsLastItem(kind), NEXT_CURSOR_MESSAGE);

/** A paged response: `{ v, asOf, items, nextCursor }`. */
export const envelopedPageSchema = <T extends z.ZodType<{ id: string }>>(
  kind: CursorKind,
  item: T,
) =>
  z
    .strictObject({ ...ENVELOPE_SHAPE, ...pageShape(kind, item) })
    .refine(nextCursorIsLastItem(kind), NEXT_CURSOR_MESSAGE);

export type Money = z.infer<typeof MoneySchema>;
export type NamedRef = z.infer<typeof NamedRefSchema>;
