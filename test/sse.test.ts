import { describe, it, expect } from 'vitest';
import {
  createEmptyDeltaStripper,
  processSseEvent,
  stripEmptyDeltaFieldsFromChunk,
} from '../src/sse.js';

/** Feed chunks through the stripper and collect the output string. */
function runThrough(chunks: string[]): Promise<{ out: string; fixed: number }> {
  return new Promise((resolve, reject) => {
    let fixed = 0;
    const t = createEmptyDeltaStripper((info) => {
      fixed += info.fields;
    });
    let out = '';
    t.on('data', (d) => (out += d.toString()));
    t.on('end', () => resolve({ out, fixed }));
    t.on('error', reject);
    for (const c of chunks) t.write(Buffer.from(c, 'utf8'));
    t.end();
  });
}

const tencentChunk = (reasoning: string) =>
  `data: ${JSON.stringify({
    id: 'gen-1',
    object: 'chat.completion.chunk',
    choices: [
      {
        index: 0,
        logprobs: null,
        finish_reason: '',
        delta: {
          role: 'assistant',
          content: '',
          reasoning_content: reasoning,
          function_call: null,
          refusal: '',
          tool_calls: [],
          extra_fields: null,
        },
      },
    ],
    usage: null,
  })}\n\n`;

describe('stripEmptyDeltaFieldsFromChunk', () => {
  it('removes empty content / reasoning_content / tool_calls:[] / function_call / finish_reason', () => {
    const chunk = {
      choices: [
        {
          index: 0,
          finish_reason: '',
          delta: {
            content: '',
            reasoning_content: 'We',
            tool_calls: [],
            function_call: { name: '', arguments: '' },
            refusal: '',
          },
        },
      ],
    };
    const removed = stripEmptyDeltaFieldsFromChunk(chunk);
    expect(removed).toBe(4); // finish_reason, content, tool_calls, function_call; reasoning_content stays
    expect(chunk.choices[0]).toEqual({
      index: 0,
      delta: { reasoning_content: 'We', refusal: '' },
    });
  });

  it('keeps non-empty content, real tool calls, and real finish reasons', () => {
    const chunk = {
      choices: [
        {
          finish_reason: 'stop',
          delta: {
            content: 'hello',
            reasoning_content: '',
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'f', arguments: '' } }],
          },
        },
      ],
    };
    const removed = stripEmptyDeltaFieldsFromChunk(chunk);
    expect(removed).toBe(1); // only reasoning_content: ''
    const choice = chunk.choices[0];
    expect(choice.finish_reason).toBe('stop');
    expect(choice.delta.content).toBe('hello');
    expect(choice.delta.tool_calls).toHaveLength(1);
  });

  it('ignores non-chat shapes', () => {
    expect(stripEmptyDeltaFieldsFromChunk(null)).toBe(0);
    expect(stripEmptyDeltaFieldsFromChunk({})).toBe(0);
    expect(stripEmptyDeltaFieldsFromChunk({ choices: 'nope' })).toBe(0);
    expect(stripEmptyDeltaFieldsFromChunk({ choices: [{ delta: null }] })).toBe(0);
    expect(stripEmptyDeltaFieldsFromChunk({ choices: [{ delta: { content: 'x' } }] })).toBe(0);
  });
});

describe('processSseEvent', () => {
  it('rewrites a Tencent-style reasoning chunk, dropping empty content', () => {
    const out = processSseEvent(tencentChunk('We'));
    const dataLine = out.split('\n').find((l) => l.startsWith('data:'))!;
    const parsed = JSON.parse(dataLine.slice(5).trim());
    expect(parsed.choices[0].delta.content).toBeUndefined();
    expect(parsed.choices[0].delta.reasoning_content).toBe('We');
  });

  it('passes [DONE] and comments through byte-identical', () => {
    expect(processSseEvent('data: [DONE]\n\n')).toBe('data: [DONE]\n\n');
    expect(processSseEvent(': ping\n\n')).toBe(': ping\n\n');
  });

  it('passes events without empty fields through byte-identical', () => {
    const evt = `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`;
    expect(processSseEvent(evt)).toBe(evt);
  });

  it('preserves event:/id: lines when rewriting', () => {
    const evt =
      'event: message\nid: 42\n' +
      `data: ${JSON.stringify({ choices: [{ delta: { content: '', reasoning_content: 'x' } }] })}\n\n`;
    const out = processSseEvent(evt);
    expect(out).toContain('event: message\n');
    expect(out).toContain('id: 42\n');
    expect(out.endsWith('\n\n')).toBe(true);
  });
});

describe('createEmptyDeltaStripper (stream)', () => {
  it('normalizes a full Tencent-style stream', async () => {
    const stream =
      tencentChunk('We') +
      tencentChunk(' need') +
      `data: ${JSON.stringify({ choices: [{ delta: { content: '2+2', reasoning_content: '' } }] })}\n\n` +
      'data: [DONE]\n\n';
    const { out, fixed } = await runThrough([stream]);
    // Each reasoning chunk strips content:"" + tool_calls:[] + finish_reason:""
    // = 3 fields × 2 chunks; the content chunk strips reasoning_content:"" = 1.
    expect(fixed).toBe(7);
    expect(out).toContain('[DONE]');
    const events = out.split('\n\n').filter(Boolean);
    expect(events.length).toBe(4);
    const first = JSON.parse(events[0]!.replace(/^data: /, ''));
    expect(first.choices[0].delta.content).toBeUndefined();
    const third = JSON.parse(events[2]!.replace(/^data: /, ''));
    expect(third.choices[0].delta.content).toBe('2+2');
    expect(third.choices[0].delta.reasoning_content).toBeUndefined();
  });

  it('handles events split across arbitrary TCP chunks', async () => {
    const stream = tencentChunk('你好') + 'data: [DONE]\n\n';
    // Split into 7-byte pieces — guaranteed to cut through multi-byte UTF-8
    // sequences (each 汉字 is 3 bytes) and mid-event.
    const bytes = Buffer.from(stream, 'utf8');
    const bufs: Buffer[] = [];
    for (let i = 0; i < bytes.length; i += 7) bufs.push(bytes.subarray(i, i + 7));

    const fixed = await new Promise<number>((resolve, reject) => {
      let n = 0;
      const t = createEmptyDeltaStripper((info) => (n += info.fields));
      let out = '';
      t.on('data', (d) => (out += d.toString()));
      t.on('end', () => {
        const parsed = JSON.parse(
          out.split('\n\n')[0]!.replace(/^data: /, ''),
        );
        expect(parsed.choices[0].delta.reasoning_content).toBe('你好');
        expect(parsed.choices[0].delta.content).toBeUndefined();
        expect(out).toContain('[DONE]');
        resolve(n);
      });
      t.on('error', reject);
      for (const b of bufs) t.write(b);
      t.end();
    });
    expect(fixed).toBe(3); // content:"" + tool_calls:[] + finish_reason:""
  });

  it('passes non-SSE / non-JSON events through untouched', async () => {
    const stream = 'data: chunk-0\n\ndata: chunk-1\n\ndata: [DONE]\n\n';
    const { out, fixed } = await runThrough([stream]);
    expect(out).toBe(stream);
    expect(fixed).toBe(0);
  });

  it('handles a trailing event without blank-line terminator', async () => {
    const stream = tencentChunk('end').slice(0, -2); // drop final \n\n
    const { out, fixed } = await runThrough([stream]);
    expect(fixed).toBe(3);
    const parsed = JSON.parse(out.split('\n\n')[0]!.replace(/^data: /, ''));
    expect(parsed.choices[0].delta.reasoning_content).toBe('end');
  });
});
