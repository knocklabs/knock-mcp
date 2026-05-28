import { TaggedError } from "better-result";

export class RequestValidationError extends TaggedError("RequestValidationError")<{
  message: string;
}>() {}

export class HttpMethodError extends TaggedError("HttpMethodError")<{ message: string }>() {}

export class NetworkError extends TaggedError("NetworkError")<{ message: string }>() {}

export class ExecutionError extends TaggedError("ExecutionError")<{ message: string }>() {}

export type CodeModeError =
  | RequestValidationError
  | HttpMethodError
  | NetworkError
  | ExecutionError;

export function formatCodeModeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function toRequestValidationError(cause: unknown): RequestValidationError {
  return new RequestValidationError({ message: formatCodeModeError(cause) });
}

export function toNetworkError(cause: unknown): NetworkError {
  return new NetworkError({ message: formatCodeModeError(cause) });
}
