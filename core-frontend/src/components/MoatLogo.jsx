import { useTheme } from "../ThemeContext";

export default function MoatLogo({ height = 28, style = {} }) {
  const { org } = useTheme();
  // Prefer org.theme.mode (reactive), fallback to <html data-theme="...">
  const mode = org?.theme?.mode || document.documentElement.dataset.theme || "dark";
  const src = mode === "light" ? "/moat-logo-dark.png" : "/moat-logo.png";
  return <img src={src} alt="MOAT Technologies" style={{ height, objectFit: "contain", ...style }} />;
}
