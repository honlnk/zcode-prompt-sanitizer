import { Transform, type TransformCallback } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { Buffer } from 'node:buffer';

/**
 * SSE normalization: strip empty-string placeholder fields from
 * OpenAI-style chat.completion.chunk deltas.
 *
 * Some providers (Tencent hunyuan via copilot.tencent.com) emit deltas like
 *   {"delta": {"content": "", "reasoning_content": "We", ...}}
 * on every chunk. Clients built on the Vercel AI SDK (ZCode) treat ANY text
 * delta — including an empty string — as the end of the current reasoning
 * block, so a single thinking phase gets split into one block per chunk and
 * the UI renders a stack of tiny "thinking" segments.
 *
 * The transform parses SSE events (buffering across arbitrary TCP chunk
 * boundaries, UTF-8 safe), and only touches events whose data payload parses
 * as a JSON object with a `choices` array. Everything else — `[DONE]`,
 * comments, event:/id: lines, non-JSON payloads, non-matching shapes — passes
 * through byte-identical.
 */

/** Per-fix report: how many events were modified and fields removed. */
export interface SseFixInfo {
  events: number;
  fields: number;
}

/**
 * Strip empty placeholder fields from a parsed chat.completion.chunk object.
 * Mutates `chunk` (freshly JSON.parse'd, safe to mutate).
 * Returns the number of fields removed.
 */
export function stripEmptyDeltaFieldsFromChunk(chunk: unknown): number {
  if (!chunk || typeof chunk !== 'object') return 0;
  const choices = (chunk as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return 0;
  let removed = 0;
  for (const choice of choices) {
    const delta = (choice as { delta?: unknown } | null)?.delta;
    if (!delta || typeof delta !== 'object') continue;
    const d = delta as Record<string, unknown>;
    if (d.content === '') {
      delete d.content;
      removed++;
    }
    if (d.reasoning_content === '') {
      delete d.reasoning_content;
      removed++;
    }
    const fc = d.function_call;
    if (
      fc &&
      typeof fc === 'object' &&
      (fc as Record<string, unknown>).name === '' &&
      (fc as Record<string, unknown>).arguments === ''
    ) {
      delete d.function_call;
      removed++;
    }
  }
  return removed;
}

/**
 * Process one complete SSE event (including its terminating blank line).
 * Returns the event unchanged when no fix applies.
 */
export function processSseEvent(
  raw: string,
  onFix?: (info: SseFixInfo) => void,
): string {
  const lines = raw.split(/\r?\n/);
  // Drop the trailing empty line(s) produced by the blank-line terminator.
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith('data:')) {
      // Per SSE spec, a single leading space after "data:" is stripped.
      dataLines.push(line.slice(5).replace(/^ /, ''));
    }
  }
  if (dataLines.length === 0) return raw;

  let parsed: unknown;
  try {
    parsed = JSON.parse(dataLines.join('\n'));
  } catch {
    return raw; // [DONE] and other non-JSON payloads pass through.
  }

  const removed = stripEmptyDeltaFieldsFromChunk(parsed);
  if (removed === 0) return raw;

  onFix?.({ events: 1, fields: removed });
  const others = lines.filter((l) => !l.startsWith('data:'));
  return [...others, `data: ${JSON.stringify(parsed)}`, '', ''].join('\n');
}

/**
 * Create a Transform stream that normalizes SSE events on the fly.
 * Input: raw bytes (Buffer) from the upstream socket. Output: utf8 strings.
 */
export function createEmptyDeltaStripper(onFix?: (info: SseFixInfo) => void): Transform {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const drain = (end: boolean): string => {
    let out = '';
    for (;;) {
      const m = /\r?\n\r?\n/.exec(buffer);
      if (!m) break;
      const rawEvent = buffer.slice(0, m.index + m[0].length);
      buffer = buffer.slice(m.index + m[0].length);
      out += processSseEvent(rawEvent, onFix);
    }
    if (end) {
      // A well-behaved stream ends with a blank line, but handle a trailing
      // event without terminator rather than dropping it.
      if (buffer.trim().length > 0) {
        out += processSseEvent(buffer + '\n\n', onFix);
      } else {
        out += buffer;
      }
      buffer = '';
    }
    return out;
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        buffer += decoder.write(chunk);
        cb(null, drain(false));
      } catch (err) {
        cb(err as Error);
      }
    },
    flush(cb: TransformCallback) {
      try {
        buffer += decoder.end();
        cb(null, drain(true));
      } catch (err) {
        cb(err as Error);
      }
    },
  });
}
