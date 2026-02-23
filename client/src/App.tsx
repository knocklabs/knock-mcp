import { ToolSelector } from "./components/ToolSelector";

export default function App() {
  const params = new URLSearchParams(window.location.search);
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
