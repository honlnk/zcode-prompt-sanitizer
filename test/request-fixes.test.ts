import { describe, it, expect } from 'vitest';
import { fixEmptyContentMessages } from '../src/request-fixes.js';

describe('fixEmptyContentMessages', () => {
  it('fills content for tool-call-only assistant turns (null and empty string)', () => {
    const body = {
      messages: [
        { role: 'user', content: 'list files' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'ls', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 't1', content: 'a.txt\nb.txt' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 't2', type: 'function', function: { name: 'pwd', arguments: '{}' } }],
        },
        { role: 'assistant', content: 'done' },
      ],
    };
    const res = fixEmptyContentMessages(body);
    expect(res.changed).toBe(true);
    expect(res.dropped).toBe(0);
    expect(res.filled).toBe(2);
    const msgs = body.messages as Array<{ role: string; content: unknown }>;
    expect(msgs).toHaveLength(5);
    expect(msgs[1]!.content).toBe(' ');
    expect(msgs[3]!.content).toBe(' ');
    expect(msgs[4]!.content).toBe('done');
  });

  it('fills content for assistant turns carrying function_call', () => {
    const body = {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: null, function_call: { name: 'f', arguments: '{}' } },
      ],
    };
    const res = fixEmptyContentMessages(body);
    expect(res.filled).toBe(1);
    expect((body.messages as any[])[1]!.content).toBe(' ');
  });

  it('fills empty tool-role messages instead of dropping them', () => {
    const body = {
      messages: [
        { role: 'user', content: 'run' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 't1', type: 'function', function: { name: 'x', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 't1', content: '' },
      ],
    };
    const res = fixEmptyContentMessages(body);
    expect(res.dropped).toBe(0);
    expect(res.filled).toBe(2); // assistant turn filled too
    expect((body.messages as any[])[2]!.content).toBe(' ');
  });

  it('drops truly blank assistant / system / user messages', () => {
    const body = {
      messages: [
        { role: 'system', content: '' },
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '' },
        { role: 'assistant', content: null },
        { role: 'user', content: null },
      ],
    };
    const res = fixEmptyContentMessages(body);
    expect(res.changed).toBe(true);
    expect(res.dropped).toBe(4);
    expect(res.filled).toBe(0);
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('treats empty content arrays and all-empty text parts as empty', () => {
    const body = {
      messages: [
        { role: 'user', content: [] },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
        {
          role: 'system',
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: '' },
          ],
        },
      ],
    };
    const res = fixEmptyContentMessages(body);
    expect(res.dropped).toBe(3);
    expect(body.messages).toEqual([]);
  });

  it('keeps array content that contains any non-empty part or a non-text part', () => {
    const body = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'look' },
          ],
        },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:...' } }] },
      ],
    };
    const res = fixEmptyContentMessages(body);
    expect(res.changed).toBe(false);
    expect((body.messages as any[]).length).toBe(2);
  });

  it('does NOT treat whitespace-only or non-empty content as empty', () => {
    const body = {
      messages: [
        { role: 'assistant', content: ' ' },
        { role: 'user', content: '  \n ' },
        { role: 'system', content: 'You are helpful.' },
      ],
    };
    const res = fixEmptyContentMessages(body);
    expect(res.changed).toBe(false);
    expect((body.messages as any[]).length).toBe(3);
  });

  it('leaves bodies without a messages array unchanged', () => {
    for (const body of [null, undefined, 'string', 42, { model: 'x' }, { messages: 'nope' }]) {
      const res = fixEmptyContentMessages(body);
      expect(res.changed).toBe(false);
      expect(res.dropped).toBe(0);
      expect(res.filled).toBe(0);
      expect(res.body).toBe(body);
    }
  });

  it('keeps non-object entries in messages untouched', () => {
    const body = { messages: ['oops', null, { role: 'user', content: 'x' }] };
    const res = fixEmptyContentMessages(body);
    expect(res.changed).toBe(false);
    expect((body.messages as any[]).length).toBe(3);
  });

  it('preserves other top-level body fields', () => {
    const body = {
      model: 'kimi-k3.1-pro',
      stream: true,
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: '' },
      ],
    };
    fixEmptyContentMessages(body);
    expect(body.model).toBe('kimi-k3.1-pro');
    expect(body.stream).toBe(true);
  });

  it('reproduces the 11151 poisoning scenario end-to-end on the messages array', () => {
    // Shape observed in the wild: GLM-era history replayed to Tencent.
    const body = {
      messages: [
        { role: 'system', content: 'You are ZCode.' },
        { role: 'user', content: 'run tests' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'a', type: 'function', function: { name: 'bash', arguments: '{}' } }],
        },
        { role: 'tool', tool_call_id: 'a', content: 'all green' },
        { role: 'assistant', content: '' }, // failed-turn placeholder
        { role: 'user', content: 'continue' },
      ],
    };
    const res = fixEmptyContentMessages(body);
    expect(res.dropped).toBe(1);
    expect(res.filled).toBe(1);
    const msgs = body.messages as any[];
    expect(msgs).toHaveLength(5);
    expect(msgs.map((m: any) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'user']);
    expect(msgs[2]!.content).toBe(' ');
  });
});
