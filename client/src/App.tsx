import { ApprovalDialog } from "./components/ApprovalDialog";
import { ToolSelector } from "./components/ToolSelector";

export default function App() {
  const path = window.location.pathname;
  const params = new URLSearchParams(window.location.search);

  if (path === "/approval") {
    return <ApprovalDialog params={params} />;
  }

  if (path === "/tools") {
    const session = params.get("session");
    if (!session) {
      return (
        <div style={{ textAlign: "center", color: "var(--color-text-secondary)" }}>
          Missing session parameter.
        </div>
      );
    }
    return <ToolSelector session={session} />;
  }

  return (
    <div style={{ textAlign: "center", color: "var(--color-text-secondary)" }}>Page not found.</div>
  );
}
