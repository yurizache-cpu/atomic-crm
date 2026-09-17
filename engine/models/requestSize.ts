// The size of the text a model request carries, in UTF-8 bytes.
//
// The database reserves spend for an agent run before its call, and bounds the
// run's input tokens by `ops.agent_run_input_token_ceiling` (ADR 0017 §2). That
// bound rests on one fact: a byte-level tokenizer never emits more tokens than
// its text has UTF-8 bytes. This function measures exactly the text the model
// reads, so a driver-backed test can prove a real request stays under the
// database's ceiling, including for adversarial task text.
//
// Every part is measured on its own and the sizes are summed. Measuring the
// concatenation instead could count less: a surrogate pair split across two
// parts is one 4-byte character joined, but two 3-byte replacement characters
// apart. An upper bound must never undercount.

import type { ModelRequest } from "./types.ts";

const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * The UTF-8 byte length of the instructions, the input, the output schema as
 * JSON and the output name. The model id and the output ceiling are not text
 * the model reads, so they are not counted.
 */
export function modelRequestByteSize(request: ModelRequest): number {
  return (
    utf8Bytes(request.instructions) +
    utf8Bytes(request.input) +
    utf8Bytes(JSON.stringify(request.output.schema)) +
    utf8Bytes(request.output.name)
  );
}
