import { TaggedError } from "better-result";

export interface AgentErrorContext {
  sessionId?: string;
  runId?: string;
}

export class AgentApiError extends TaggedError("AgentApiError")<{
  message: string;
  status?: number;
  sessionId?: string;
  runId?: string;
}>() {}

export class AgentStreamError extends TaggedError("AgentStreamError")<{
  message: string;
  sessionId?: string;
  runId?: string;
}>() {}

export class AgentNetworkError extends TaggedError("AgentNetworkError")<{
  message: string;
  sessionId?: string;
  runId?: string;
}>() {}

export type AgentError = AgentApiError | AgentStreamError | AgentNetworkError;

export function formatAgentError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function toAgentNetworkError(cause: unknown): AgentNetworkError {
  return new AgentNetworkError({ message: formatAgentError(cause) });
}

export function withAgentErrorContext(error: AgentError, ctx: AgentErrorContext): AgentError {
  if (error instanceof AgentApiError) {
    return new AgentApiError({
      message: error.message,
      status: error.status,
      sessionId: ctx.sessionId ?? error.sessionId,
      runId: ctx.runId ?? error.runId,
    });
  }
  if (error instanceof AgentStreamError) {
    return new AgentStreamError({
      message: error.message,
      sessionId: ctx.sessionId ?? error.sessionId,
      runId: ctx.runId ?? error.runId,
    });
  }
  return new AgentNetworkError({
    message: error.message,
    sessionId: ctx.sessionId ?? error.sessionId,
    runId: ctx.runId ?? error.runId,
  });
}

export function formatAgentErrorForMcp(error: AgentError): string {
  const lines: string[] = [];
  if (error.sessionId) {
    lines.push(`Session ID: ${error.sessionId}`);
  }
  if (error.runId) {
    lines.push(`Run ID: ${error.runId}`);
  }
  lines.push(`Error: ${formatAgentError(error)}`);
  return lines.join("\n");
}
