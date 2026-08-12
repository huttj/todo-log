import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import "./app.css";
import { applyTheme } from "./theme";

applyTheme();

// Text size is a per-device preference; apply before first paint. The whole
// UI is rem-based, so scaling the root scales everything.
const textSize = localStorage.getItem("todolog.textSize");
if (textSize) document.documentElement.style.fontSize = textSize;

if ("serviceWorker" in navigator) {
  void navigator.serviceWorker.register("/sw.js").catch(() => {});
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);
