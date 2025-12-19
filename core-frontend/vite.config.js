// vite.config.js
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // helpful if you run multiple dev servers
    strictPort: false,
    // Vite already sends CORS headers to the browser; proxy hides cross-origin from the browser
    proxy: {
      // API calls go to Express on :5000
      "/api": {
        target: "http://localhost:5000",
        changeOrigin: true,
        secure: false,
        // Frontend calls /api/... ; backend will receive ... (prefix stripped)
        // ex: /api/inspection/forms -> http://localhost:5000/inspection/forms
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
      // File downloads (keeps /files prefix intact)
      "/files": {
        target: "http://localhost:5000",
        changeOrigin: true,
        secure: false,
        // no rewrite
      },
    },
  },
});
