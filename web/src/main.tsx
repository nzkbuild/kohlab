import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root is missing from index.html");

createRoot(root, {
  // Production render failures were previously console-only. Routing them here
  // makes a crash observable instead of a silently blank pane.
  onUncaughtError: (error, info) => {
    console.error("[kohlab] uncaught render error", error, info.componentStack);
  },
  onCaughtError: (error, info) => {
    console.error("[kohlab] caught render error", error, info.componentStack);
  },
  onRecoverableError: (error) => {
    console.warn("[kohlab] recoverable render error", error);
  },
}).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
