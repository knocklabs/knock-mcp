export interface ConsumeNdjsonOptions {
  signal?: AbortSignal;
  shouldStop?: () => boolean;
  onStop?: () => void;
}

export async function consumeNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onParsedLine: (rawLine: string) => void | Promise<void>,
  options: ConsumeNdjsonOptions = {},
): Promise<void> {
  const { signal, shouldStop, onStop } = options;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const stopReading = async (): Promise<void> => {
    try {
      await reader.cancel();
    } catch {
      // Best-effort cleanup after a terminal event.
    }
  };

  const finishIfStopped = async (): Promise<boolean> => {
    if (!shouldStop?.()) return false;
    onStop?.();
    await stopReading();
    return true;
  };

  try {
    while (true) {
      if (signal?.aborted) {
        throw new DOMException("Agent run aborted", "AbortError");
      }
      if (await finishIfStopped()) return;

      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        await onParsedLine(line);
        if (await finishIfStopped()) return;
      }
    }

    if (buffer.trim()) {
      await onParsedLine(buffer);
      await finishIfStopped();
    }
  } finally {
    reader.releaseLock();
  }
}
