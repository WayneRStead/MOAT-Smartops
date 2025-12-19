// tailwind.config.js (ESM)
export default {
  content: ["./index.html", "./src/**/*.{js,jsx,ts,tsx}"],
  darkMode: "class",
  // keep your existing base styles intact
  corePlugins: { preflight: false },
  theme: {
    extend: {
      colors: {
        bg: "var(--bg)",
        text: "var(--text)",
        border: "var(--border)",
        panel: "var(--panel)",
        thead: "var(--thead)",
        accent: "var(--accent)",
      },
      borderRadius: { DEFAULT: "var(--radius)" },
    },
  },
  plugins: [],
};
