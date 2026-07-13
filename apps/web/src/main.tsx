import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function FoundationScreen() {
  return (
    <main>
      <h1>Agency Workload</h1>
      <p>Secure foundation in progress.</p>
    </main>
  );
}

const root = document.getElementById("root");

if (!root) throw new Error("Application root is missing");

createRoot(root).render(
  <StrictMode>
    <FoundationScreen />
  </StrictMode>,
);
