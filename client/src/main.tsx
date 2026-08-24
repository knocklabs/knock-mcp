import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import App from "./App";

const media = window.matchMedia("(prefers-color-scheme: dark)");
const applyAppearance = () => {
  const value = media.matches ? "dark" : "light";
  document.documentElement.setAttribute("data-tgph-appearance", value);
  document.documentElement.style.colorScheme = value;
};
applyAppearance();
media.addEventListener("change", applyAppearance);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
