import { Result } from "better-result";

import { ExecutionError, formatCodeModeError } from "./errors";
import { formatCodeModeToolResult } from "./utils";

type ExecuteResult = { result: unknown; error?: string; logs?: string[] };

export async function runCodeModeExecution(
  execute: () => Promise<ExecuteResult>,
): Promise<Result<string, unknown>> {
  const exec = await Result.tryPromise({
    try: execute,
    catch: (cause) => new ExecutionError({ message: formatCodeModeError(cause) }),
  });
  if (Result.isError(exec)) {
    return Result.err(exec.error);
  }
  if (exec.value.error) {
    return Result.err(new ExecutionError({ message: exec.value.error }));
  }
  return Result.ok(formatCodeModeToolResult(exec.value));
}
