/**
 * Recorded contract between the OpenCode 2 TUI plugin surface (`ctx.data.on`)
 * and `src/v2/adapter.ts`.
 *
 * Each case delivers host payloads in order and pins the internal events the
 * adapter must produce, in full. That is what makes a payload drift red: rename
 * `event.created` to `event.data.timestamp` in the adapter and the expected
 * `part.time.start` no longer matches. Cases that span several events (tool
 * start → success, text start → delta → ended) pin the cross-event state the
 * single-event tests used to miss.
 *
 * ## Status of the payloads (assumed, not captured)
 *
 * These payloads are the adapter's reading of the host, not a packet capture.
 * The only V2 schema in this repo (`@opencode-ai/sdk@1.15.13`,
 * `dist/v2/gen/types.gen.d.ts`) describes the *bus* instead — `session.next.*`
 * names, payload under `properties`, time in `properties.timestamp`, no
 * `assistantMessageID`, tool id in `callID` — and the host surface evidently
 * differs on all of it.
 *
 * What the host's own output does confirm (OpenCode v2.0.32,
 * `~/.local/share/opencode/logs/cache-hit/timeline-2026-10-20.jsonl`, 304 rows
 * with `producer: opencode/1.0.0`): events carry `created` (`ttftSource: "sdk"`
 * is only reachable through it), deltas carry message identity (`itlCount > 0`),
 * tool events carry the call id under `id` plus `name` (`toolDurations` with
 * non-zero durations), and `step.ended` carries `assistantMessageID` (the rows
 * exist at all).
 *
 * The event *names* below are confirmed by scanning the shipped OpenCode 2.0.32
 * CLI binary: every name here is present, `assistantMessageID` is the host's own
 * field name, and the SDK bus schema's `session.next.*` namespace has zero hits
 * there. That scan also finds `session.message.content.updated` — which the
 * adapter deliberately does not subscribe to (see
 * `docs/en/design.md` § Event mapping): it only ever carried a replay-time
 * content snapshot, so the missing handler can cost TTFT on replays but not
 * correctness.
 *
 * Still unconfirmed by observation: the `agent` / `model` / `started` fields of
 * `step.started`, and the failure/deletion events. Replace these payloads with a
 * real capture when one is available — do not tune them to make the adapter
 * pass.
 *
 * A payload case is a *regression* net for adapter changes, not proof about the
 * host. Two things it cannot catch: a field the host never sends (only a
 * capture can), and a field the adapter stops reading entirely without any
 * fixture event relying on it.
 */
import type { StreamPart, TuiEvent } from "../../src/types.ts"
import type { V2Event } from "../../src/v2/types.ts"

export type V2EventCase = {
  /** Host payloads in delivery order. */
  events: V2Event[]
  /** Internal events the adapter must emit, in order, in full. */
  emits: TuiEvent[]
  /** `api.state.part(messageID)` after `events`; omit when the case does not touch parts. */
  parts?: { messageID: string; expect: StreamPart[] | undefined }
}

const SESSION = "ses_1"
const MESSAGE = "msg_1"
const CALL = "call_1"
const TOKENS = { input: 10, output: 5, reasoning: 0, cache: { read: 100, write: 0 } }

export const V2_EVENT_CASES: V2EventCase[] = [
  {
    events: [{ type: "session.usage.updated", created: 1000, data: { sessionID: SESSION } }],
    emits: [{ type: "tick" }],
  },
  {
    // `step.started` carries the agent/model that `step.ended` does not.
    events: [
      {
        type: "session.step.started",
        created: 1000,
        data: {
          sessionID: SESSION,
          assistantMessageID: MESSAGE,
          agent: "build",
          model: { id: "deepseek-v4", providerID: "deepseek" },
          started: 900,
        },
      },
      {
        type: "session.step.ended",
        created: 2000,
        data: { sessionID: SESSION, assistantMessageID: MESSAGE, finish: "stop", cost: 0.5, tokens: TOKENS },
      },
    ],
    emits: [
      {
        type: "message",
        info: {
          id: MESSAGE,
          messageID: MESSAGE,
          role: "assistant",
          sessionID: SESSION,
          agent: "build",
          modelID: "deepseek-v4",
          providerID: "deepseek",
          cost: 0.5,
          finish: "stop",
          tokens: TOKENS,
          time: { created: 900, completed: 2000 },
        },
      },
    ],
  },
  {
    events: [
      {
        type: "session.step.failed",
        created: 2000,
        data: { sessionID: SESSION, assistantMessageID: MESSAGE, error: { type: "unknown", message: "boom" } },
      },
    ],
    emits: [
      {
        type: "message",
        info: {
          id: MESSAGE,
          messageID: MESSAGE,
          role: "assistant",
          sessionID: SESSION,
          finish: "error",
          time: { created: 2000, completed: 2000 },
        },
      },
    ],
  },
  {
    events: [
      { type: "session.text.started", created: 1000, data: { sessionID: SESSION, assistantMessageID: MESSAGE } },
      { type: "session.text.delta", created: 1100, data: { sessionID: SESSION, assistantMessageID: MESSAGE, delta: "hel" } },
      { type: "session.text.delta", created: 1200, data: { sessionID: SESSION, assistantMessageID: MESSAGE, delta: "lo" } },
      { type: "session.text.ended", created: 1300, data: { sessionID: SESSION, assistantMessageID: MESSAGE, text: "hello world" } },
    ],
    emits: [
      { type: "part", part: { type: "text", messageID: MESSAGE, time: { start: 1000 } } },
      { type: "delta", messageID: MESSAGE, field: "text" },
      { type: "delta", messageID: MESSAGE, field: "text" },
    ],
    // Deltas accumulate; the durable `ended` value wins and keeps the start time.
    parts: { messageID: MESSAGE, expect: [{ type: "text", time: { start: 1000 }, text: "hello world" }] },
  },
  {
    events: [
      { type: "session.reasoning.started", created: 1000, data: { sessionID: SESSION, assistantMessageID: MESSAGE } },
      { type: "session.reasoning.delta", created: 1100, data: { sessionID: SESSION, assistantMessageID: MESSAGE, delta: "why" } },
      { type: "session.reasoning.ended", created: 1200, data: { sessionID: SESSION, assistantMessageID: MESSAGE, text: "why not" } },
    ],
    emits: [
      { type: "part", part: { type: "reasoning", messageID: MESSAGE, time: { start: 1000 } } },
      { type: "delta", messageID: MESSAGE, field: "reasoning" },
    ],
    parts: { messageID: MESSAGE, expect: [{ type: "reasoning", time: { start: 1000 }, text: "why not" }] },
  },
  {
    // The terminal tool event only carries the call id: name and start come from
    // `input.started`, which is why the two events must stay paired.
    events: [
      {
        type: "session.tool.input.started",
        created: 1500,
        data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL, name: "bash" },
      },
      { type: "session.tool.success", created: 1900, data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL } },
    ],
    emits: [
      {
        type: "part",
        part: {
          type: "tool",
          messageID: MESSAGE,
          callID: CALL,
          tool: "bash",
          state: { status: "running", time: { start: 1500 } },
        },
      },
      {
        type: "part",
        part: {
          type: "tool",
          messageID: MESSAGE,
          callID: CALL,
          tool: "bash",
          state: { status: "completed", time: { start: 1500, end: 1900 } },
        },
      },
    ],
    parts: { messageID: MESSAGE, expect: [{ type: "tool", time: { start: 1500 } }] },
  },
  {
    events: [
      {
        type: "session.tool.input.started",
        created: 1500,
        data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL, name: "read" },
      },
      {
        type: "session.tool.failed",
        created: 1900,
        data: { sessionID: SESSION, assistantMessageID: MESSAGE, id: CALL, error: { type: "unknown", message: "boom" } },
      },
    ],
    emits: [
      {
        type: "part",
        part: { type: "tool", messageID: MESSAGE, callID: CALL, tool: "read", state: { status: "running", time: { start: 1500 } } },
      },
      {
        type: "part",
        part: {
          type: "tool",
          messageID: MESSAGE,
          callID: CALL,
          tool: "read",
          state: { status: "error", time: { start: 1500, end: 1900 } },
        },
      },
    ],
  },
  {
    // Nothing is emitted: it only clears the message-sync marker.
    events: [{ type: "session.deleted", created: 2000, data: { sessionID: SESSION } }],
    emits: [],
  },
]
