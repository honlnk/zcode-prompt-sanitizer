/**
 * Request-side normalization: drop / fill messages whose `content` is empty.
 *
 * Strict OpenAI-compatible upstreams (Tencent WorkBuddy via
 * copilot.tencent.com, error code 11151: "a message has empty content")
 * reject the WHOLE request when any message in `messages` carries empty
 * content. Lenient endpoints (GLM) tolerate them, so agent clients freely
 * accumulate such messages in replayed history — tool-call-only assistant
 * turns (`content: null` + `tool_calls`) and blank progress placeholders
 * left behind by failed turns.
 *
 * The symmetric response-side patch is `sse.ts` (stripEmptyDeltaFields).
 *
 * Rules per message:
 *  - empty content + `tool_calls` / `function_call` → fill content with " "
 *    (dropping the message would orphan the `tool` messages that follow it,
 *    trading one rejection for another)
 *  - empty content + role "tool" → fill with " " (same pairing argument)
 *  - empty content + any other role → drop the message entirely
 *  - everything else → untouched
 *
 * "Empty" is deliberately conservative: null, undefined, "", [], and
 * content-part arrays whose every part is a text part with empty text.
 * Whitespace-only strings are NOT considered empty.
 */

/** Result of applying the request fix to a parsed request body. */
export interface RequestFixResult {
  /** Whether the body was mutated. */
  changed: boolean;
  /** Mutated JSON-serializable body (same shape as input when unchanged). */
  body: unknown;
  /** Messages removed from `messages`. */
  dropped: number;
  /** Messages whose content was filled with a placeholder. */
  filled: number;
}

/** Minimal placeholder: non-empty for strict validators, invisible to models. */
const PLACEHOLDER = ' ';

/**
 * Remove / fill empty-content messages in an OpenAI-style chat body.
 * Bodies without a `messages` array are returned unchanged.
 */
export function fixEmptyContentMessages(body: unknown): RequestFixResult {
  if (!body || typeof body !== 'object') {
    return { changed: false, body, dropped: 0, filled: 0 };
  }
  const obj = body as Record<string, unknown>;
  const messages = obj.messages;
  if (!Array.isArray(messages)) {
    return { changed: false, body, dropped: 0, filled: 0 };
  }

  let dropped = 0;
  let filled = 0;
  const kept: unknown[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') {
      kept.push(msg);
      continue;
    }
    const m = msg as Record<string, unknown>;
    if (!isEmptyContent(m.content)) {
      kept.push(msg);
      continue;
    }
    if (hasToolCall(m) || m.role === 'tool') {
      m.content = PLACEHOLDER;
      filled++;
      kept.push(msg);
      continue;
    }
    // assistant / system / user / unknown roles: nothing to preserve.
    dropped++;
  }

  const changed = dropped > 0 || filled > 0;
  if (changed) obj.messages = kept;
  return { changed, body, dropped, filled };
}

function isEmptyContent(content: unknown): boolean {
  if (content === null || content === undefined) return true;
  if (typeof content === 'string') return content === '';
  if (Array.isArray(content)) {
    return content.every(
      (part) =>
        part !== null &&
        typeof part === 'object' &&
        (part as { type?: unknown }).type === 'text' &&
        (part as { text?: unknown }).text === '',
    );
  }
  return false;
}

function hasToolCall(msg: Record<string, unknown>): boolean {
  const tc = msg.tool_calls;
  if (Array.isArray(tc) && tc.length > 0) return true;
  const fc = msg.function_call;
  return fc !== null && typeof fc === 'object';
}
