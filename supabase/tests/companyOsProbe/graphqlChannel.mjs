// What the Data API's /graphql/v1 answers when pg_graphql is not installed.
// Supabase keeps a placeholder graphql_public.graphql() (its event trigger
// issue_graphql_placeholder) that returns exactly this error with status 200.
// Supabase on PostgreSQL 17, hosted and the local image alike, no longer
// installs pg_graphql, so the GraphQL channel reaches nothing at all (measured
// 2026-10-01). Only this exact answer counts as the channel's absence; any
// other answer without a schema is still "not measured", and an installed
// pg_graphql brings every reflection check back.

export const PG_GRAPHQL_ABSENT_MESSAGE = "pg_graphql extension is not enabled.";

/** True only for the placeholder's exact answer. */
export const graphqlChannelAbsent = (response) =>
  response.status === 200 &&
  response.json?.data === undefined &&
  Array.isArray(response.json?.errors) &&
  response.json.errors.length === 1 &&
  response.json.errors[0]?.message === PG_GRAPHQL_ABSENT_MESSAGE;
