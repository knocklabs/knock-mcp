import { useEffect, useState } from "react";

export interface ToolGroup {
  key: string;
  name: string;
  description: string;
  categories: string[];
  enabledByDefault: boolean;
}

type Status = "loading" | "ready" | "error";

interface State {
  status: Status;
  toolGroups: ToolGroup[];
  email: string | undefined;
  csrfToken: string;
  error: string | null;
}

export function useToolGroups(session: string) {
  const [state, setState] = useState<State>({
    status: "loading",
    toolGroups: [],
    email: undefined,
    csrfToken: "",
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    fetch(`/api/tool-groups?session=${encodeURIComponent(session)}`)
      .then(async (res) => {
        if (!res.ok) {
          const text = await res.text();
          throw new Error(text || "Failed to load tool groups");
        }
        return res.json() as Promise<{
          toolGroups: ToolGroup[];
          email?: string;
          csrfToken: string;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        setState({
          status: "ready",
          toolGroups: data.toolGroups,
          email: data.email,
          csrfToken: data.csrfToken,
          error: null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState((prev) => ({
          ...prev,
          status: "error",
          error: err instanceof Error ? err.message : "Unknown error",
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [session]);

  return state;
}
