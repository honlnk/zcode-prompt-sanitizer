# Example: `requestFixes.fixEmptyContentMessages` — before & after

A concrete look at what the proxy changes. Below is a chat-completions request
as ZCode sends it (abridged: real requests carry dozens of messages and a
large `tools` array), containing all three "poison" shapes that strict
upstreams reject the whole request over (Tencent WorkBuddy, error
`11151: "a message has empty content"`).

## Incoming request (as sent by the client)

```json
{
  "model": "kimi-k3.1-pro",
  "stream": true,
  "tools": [ "...tool definitions — never touched..." ],
  "messages": [
    { "role": "system",    "content": "You are ZCode, an interactive agent..." },
    { "role": "user",      "content": "help me figure out why the tests fail" },

    { "role": "assistant", "content": null,
      "tool_calls": [{ "id": "call_A", "type": "function",
                       "function": { "name": "Bash", "arguments": "{\"command\":\"npm test\"}" } }] },

    { "role": "tool", "tool_call_id": "call_A", "content": "1 failed: proxy.test.ts:667 ..." },

    { "role": "assistant", "content": "" },          // poison ①: blank message left by a failed turn

    { "role": "user",      "content": "keep fixing" },

    { "role": "assistant", "content": null,          // poison ②: tool-call-only turn (empty content)
      "tool_calls": [{ "id": "call_B", "type": "function",
                       "function": { "name": "Read", "arguments": "{\"file_path\":\"...\"}" } }] },

    { "role": "tool", "tool_call_id": "call_B", "content": "" },   // poison ③: empty tool result

    { "role": "assistant", "content": "Fixed. All green now." },
    { "role": "user",      "content": "anything else left?" }
  ]
}
```

## Outgoing request (as forwarded upstream)

```json
{
  "model": "kimi-k3.1-pro",
  "stream": true,
  "tools": [ "...tool definitions — never touched..." ],
  "messages": [
    { "role": "system",    "content": "You are ZCode, an interactive agent..." },
    { "role": "user",      "content": "help me figure out why the tests fail" },

    { "role": "assistant", "content": " ",            // poison ② fixed: null → " "
      "tool_calls": [{ "id": "call_A", "type": "function", "function": { ... } }] },

    { "role": "tool", "tool_call_id": "call_A", "content": "1 failed: proxy.test.ts:667 ..." },

                                                      // poison ① fixed: message removed entirely

    { "role": "user",      "content": "keep fixing" },

    { "role": "assistant", "content": " ",            // poison ② fixed: null → " "
      "tool_calls": [{ "id": "call_B", "type": "function", "function": { ... } }] },

    { "role": "tool", "tool_call_id": "call_B", "content": " " },   // poison ③ fixed: "" → " "

    { "role": "assistant", "content": "Fixed. All green now." },
    { "role": "user",      "content": "anything else left?" }
  ]
}
```

## What was changed, and why exactly this way

| Poison | Incoming | Outgoing | Why |
| --- | --- | --- | --- |
| ① blank assistant message | `content: ""`, no tool calls | **removed** | It carries no content and owes no tool pairing — pure garbage, but a single one makes a strict upstream reject the entire request. |
| ② tool-call-only assistant turn | `content: null` + `tool_calls` | `content: " "` (single space) | **Must not be dropped**: the `tool` result that follows it would become an orphan, trading the 11151 rejection for a pairing rejection (11148). A single space passes the empty-content check and is invisible to the model. |
| ③ empty tool result | `role: "tool"`, `content: ""` | `content: " "` | Same pairing argument as ②. |

Everything else is forwarded byte-identical: `model`, `stream`, `tools`,
sampling options, and every message that has content. Whitespace-only strings
(`" "`, `"\n"`) in the *incoming* body are left alone — only truly empty
content (`null`, `""`, `[]`, all-empty text parts) is treated as poison.

## How to see it working

With `verbose: true`, every affected request is annotated in the logs:

```
POST /v1/chat/completions → 200 [passthrough] [req-fix: -1 +9] 34392ms
```

= 1 message dropped, 9 filled with a placeholder on a real replayed
114k-token agent history — the exact payload that previously exhausted an
account pool with 6-minute retry walls now passes on the first attempt.
