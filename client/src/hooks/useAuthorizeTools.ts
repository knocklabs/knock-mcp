import { useState } from "react";

type Status = "idle" | "submitting" | "error";

export function useAuthorizeTools() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function authorize(
    session: string,
    csrfToken: string,
    selectedGroups: string[],
  ): Promise<void> {
    setStatus("submitting");
    setError(null);

    try {
      const res = await fetch("/api/authorize-tools", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session, csrfToken, selectedGroups }),
      });

      if (!res.ok) {
        const data = (await res.json()) as { error?: string };
        throw new Error(data.error ?? "Authorization failed");
      }

      const { redirectTo } = (await res.json()) as { redirectTo: string };
      window.location.href = redirectTo;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setStatus("error");
    }
  }

  return { authorize, status, error };
}
