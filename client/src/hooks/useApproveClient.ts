import { useState } from "react";

type Status = "idle" | "submitting" | "error";

export function useApproveClient() {
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function approve(state: string, csrfToken: string): Promise<void> {
    setStatus("submitting");
    setError(null);

    try {
      const res = await fetch("/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state, csrfToken }),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "Authorization failed");
      }

      const { redirectTo } = (await res.json()) as { redirectTo: string };
      window.location.href = redirectTo;
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setStatus("error");
    }
  }

  return { approve, status, error };
}
