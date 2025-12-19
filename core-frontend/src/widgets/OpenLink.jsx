// src/widgets/OpenLink.jsx
import React from "react";

/**
 * Text link that opens the target page inside the dashboard lightbox.
 * - Normal click → opens in lightbox (via window event)
 * - Ctrl/Cmd/Shift/Alt/Middle click → behaves like a normal link (new tab/window)
 */
export default function OpenLink({ href, title = "Open", className = "text-sm underline", children }) {
  return (
    <a
      className={className}
      href={href}
      onClick={(e) => {
        // Respect power-user gestures (new tab/window)
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button === 1) return;
        e.preventDefault();
        window.dispatchEvent(
          new CustomEvent("dashboard:openLightbox", {
            detail: { title, href }
          })
        );
      }}
    >
      {children || "Open"}
    </a>
  );
}
