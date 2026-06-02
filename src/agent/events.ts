export type AgentEventType =
  | "runInitializing"
  | "prompt"
  | "reasoning"
  | "textContent"
  | "toolCall"
  | "toolResponse"
  | "signal"
  | "runEnd"
  | "runError"
  | (string & {});

export interface AgentToolCallSummary {
  callId?: string;
  name: string;
  input?: unknown;
}

export interface AgentModifiedResource {
  type?: string;
  key?: string;
  name?: string;
  action?: string;
}

export type AgentRunStatus = "running" | "complete" | "error" | "timeout";

export interface AgentRunAccumulator {
  sessionId: string;
  runId: string;
  status: AgentRunStatus;
  /** Finished assistant text blocks (mirrors Slack stream stop/start boundaries). */
  textParts: string[];
  /** In-progress text for the current streaming block (delta chunks). */
  textBuffer: string;
  toolCalls: AgentToolCallSummary[];
  modifiedResources: AgentModifiedResource[];
  announcedToolCallIds: Set<string>;
  error?: string;
  eventCount: number;
  toolCallCount: number;
  isTerminal: boolean;
}

export interface AgentRunResult {
  status: "complete" | "error" | "timeout";
  text: string;
  toolCalls: AgentToolCallSummary[];
  modifiedResources: AgentModifiedResource[];
  sessionId: string;
  runId: string;
  error?: string;
}

export interface ParsedAgentEvent {
  type: AgentEventType;
  payload: Record<string, unknown>;
}

interface TextDeltaResult {
  append?: string;
  finish?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readEventType(raw: Record<string, unknown>): AgentEventType | undefined {
  const candidates = [
    raw.type,
    raw.event_type,
    raw.eventType,
    asRecord(raw.data)?.type,
    asRecord(raw.event)?.type,
  ];
  for (const candidate of candidates) {
    const type = readString(candidate);
    if (type) return type;
  }
  return undefined;
}

function readPayload(raw: Record<string, unknown>): Record<string, unknown> {
  return (
    asRecord(raw.value) ??
    asRecord(raw.data) ??
    asRecord(raw.event) ??
    asRecord(raw.payload) ??
    raw
  );
}

export function parseAgentEventLine(line: string): ParsedAgentEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  try {
    const raw = JSON.parse(trimmed) as unknown;
    const record = asRecord(raw);
    if (!record) return null;

    const type = readEventType(record);
    if (!type) return null;

    return { type, payload: readPayload(record) };
  } catch {
    return null;
  }
}

/**
 * Mirrors Control.Agents.Events.ModelTextResponse handling in Slack relay:
 * - is_delta/content (or type delta/complete) appends to the current block
 * - is_delta false (or empty complete) finishes the current block
 */
function readTextDelta(payload: Record<string, unknown>): TextDeltaResult {
  const isDelta = readBoolean(payload.is_delta);
  if (isDelta === true) {
    const content = readString(payload.content);
    return content ? { append: content } : {};
  }
  if (isDelta === false) {
    return { finish: true };
  }

  const chunkType = readString(payload.type);
  const chunkValue = readString(payload.value);

  if (chunkType === "delta") {
    return chunkValue ? { append: chunkValue } : {};
  }

  if (chunkType === "complete") {
    return chunkValue ? { append: chunkValue, finish: true } : { finish: true };
  }

  const fallback =
    readString(payload.content) ??
    readString(payload.text) ??
    readString(payload.message) ??
    readString(asRecord(payload.content)?.text);

  return fallback ? { append: fallback, finish: true } : {};
}

function flushTextBuffer(state: AgentRunAccumulator): AgentRunAccumulator {
  if (!state.textBuffer) {
    return { ...state, textBuffer: "" };
  }

  return {
    ...state,
    textParts: [...state.textParts, state.textBuffer],
    textBuffer: "",
  };
}

function readToolCallId(payload: Record<string, unknown>): string | undefined {
  return readString(payload.callId) ?? readString(payload.call_id);
}

function readToolName(payload: Record<string, unknown>): string | undefined {
  return (
    readString(payload.name) ??
    readString(payload.tool_name) ??
    readString(payload.toolName) ??
    readString(asRecord(payload.tool)?.name)
  );
}

function readToolInput(payload: Record<string, unknown>): unknown {
  if ("input" in payload) return payload.input;
  if ("arguments" in payload) return payload.arguments;
  if ("args" in payload) return payload.args;
  return asRecord(payload.tool)?.input;
}

function readRunErrorMessage(payload: Record<string, unknown>): string | undefined {
  return (
    readString(payload.error_message) ??
    readString(payload.errorMessage) ??
    readString(payload.value) ??
    readString(payload.error) ??
    readString(asRecord(payload.error)?.message) ??
    readString(payload.message)
  );
}

function readSingleModifiedResource(
  record: Record<string, unknown>,
): AgentModifiedResource | null {
  const resourceType = readString(record.resource_type);
  const resourceKey = readString(record.resource_key) ?? readString(record.key);
  const action = readString(record.resource_action) ?? readString(record.action);

  if (!resourceType || !resourceKey) {
    return null;
  }

  return {
    type: resourceType,
    key: resourceKey,
    name: readString(record.name),
    action,
  };
}

function readModifiedResources(payload: Record<string, unknown>): AgentModifiedResource[] {
  const resources: AgentModifiedResource[] = [];

  const candidates = [
    payload.resources,
    payload.modified_resources,
    payload.modifiedResources,
    asRecord(payload.signal)?.resources,
  ];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue;
    for (const item of candidate) {
      const record = asRecord(item);
      if (!record) continue;
      const resource = readSingleModifiedResource(record) ?? {
        type: readString(record.resource_type) ?? readString(record.type),
        key:
          readString(record.resource_key) ??
          readString(record.key) ??
          readString(record.id),
        name: readString(record.name),
        action: readString(record.resource_action) ?? readString(record.action),
      };
      resources.push(resource);
    }
  }

  const single = asRecord(payload.resource);
  if (single) {
    resources.push(
      readSingleModifiedResource(single) ?? {
        type: readString(single.resource_type) ?? readString(single.type),
        key: readString(single.resource_key) ?? readString(single.key) ?? readString(single.id),
        name: readString(single.name),
        action: readString(single.resource_action) ?? readString(single.action),
      },
    );
  }

  const direct = readSingleModifiedResource(payload);
  if (direct) {
    resources.push(direct);
  }

  return resources;
}

function dedupeResources(resources: AgentModifiedResource[]): AgentModifiedResource[] {
  const seen = new Set<string>();
  const deduped: AgentModifiedResource[] = [];
  for (const resource of resources) {
    const key = [resource.type, resource.key, resource.name, resource.action].join("|");
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(resource);
  }
  return deduped;
}

export function createAgentRunAccumulator(sessionId: string, runId: string): AgentRunAccumulator {
  return {
    sessionId,
    runId,
    status: "running",
    textParts: [],
    textBuffer: "",
    toolCalls: [],
    modifiedResources: [],
    announcedToolCallIds: new Set(),
    eventCount: 0,
    toolCallCount: 0,
    isTerminal: false,
  };
}

export function reduceAgentEvent(
  state: AgentRunAccumulator,
  event: ParsedAgentEvent,
): AgentRunAccumulator {
  let next: AgentRunAccumulator = {
    ...state,
    eventCount: state.eventCount + 1,
  };

  switch (event.type) {
    case "runInitializing":
    case "prompt":
    case "reasoning":
    case "toolResponse":
      break;

    case "textContent": {
      const delta = readTextDelta(event.payload);
      if (delta.append) {
        next = { ...next, textBuffer: next.textBuffer + delta.append };
      }
      if (delta.finish) {
        next = flushTextBuffer(next);
      }
      break;
    }

    case "toolCall": {
      const callId = readToolCallId(event.payload);
      const name = readToolName(event.payload);
      if (!name) break;

      if (callId && next.announcedToolCallIds.has(callId)) {
        break;
      }

      next = {
        ...next,
        toolCalls: [
          ...next.toolCalls,
          { callId, name, input: readToolInput(event.payload) },
        ],
        toolCallCount: next.toolCallCount + 1,
        announcedToolCallIds: callId
          ? new Set(next.announcedToolCallIds).add(callId)
          : next.announcedToolCallIds,
      };
      break;
    }

    case "signal": {
      const resources = readModifiedResources(event.payload);
      if (resources.length > 0) {
        next = {
          ...next,
          modifiedResources: dedupeResources([...next.modifiedResources, ...resources]),
        };
      }
      break;
    }

    case "runEnd": {
      next = flushTextBuffer(next);
      next = { ...next, status: "complete", isTerminal: true };
      break;
    }

    case "runError": {
      next = flushTextBuffer(next);
      next = {
        ...next,
        status: "error",
        isTerminal: true,
        error: readRunErrorMessage(event.payload) ?? "Agent run failed",
      };
      break;
    }

    default:
      break;
  }

  return next;
}

export function finalizeAgentRunResult(state: AgentRunAccumulator): AgentRunResult {
  const flushed = flushTextBuffer(state);
  const text = flushed.textParts.join("\n\n").trim();

  return {
    status: flushed.status === "running" ? "error" : flushed.status,
    text,
    toolCalls: flushed.toolCalls,
    modifiedResources: flushed.modifiedResources,
    sessionId: flushed.sessionId,
    runId: flushed.runId,
    error:
      flushed.error ??
      (flushed.status === "running"
        ? "Agent run ended without a terminal event"
        : flushed.status === "timeout"
          ? "Agent run timed out"
          : undefined),
  };
}

export function markAgentRunTimedOut(state: AgentRunAccumulator): AgentRunAccumulator {
  return {
    ...flushTextBuffer(state),
    status: "timeout",
    isTerminal: true,
    error: state.error ?? "Agent run timed out before completion",
  };
}
