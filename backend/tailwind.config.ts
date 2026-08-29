import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./pages/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        background: "var(--background)",
        foreground: "var(--foreground)",
        brand: {
          orange: "#FF571A",
          "orange-hover": "#E0440B",
          "orange-active": "#C73704",
          dark: "#000000",
          surface: "#0B0D0E",
          "surface-elevated": "#111416",
          "surface-card": "#16191C",
          border: "#23272A",
          "border-accent": "#2F3438",
          "border-orange": "#FF571A",
          emerald: "#22C55E",
          amber: "#F9C425",
          crimson: "#FF3366",
          "text-primary": "#F0F1F1",
          "text-muted": "#8E9296",
          "text-subtle": "#5A5E62",
        },
      },
      fontFamily: {
        sans: ["var(--font-sans)", "Inter", "system-ui", "sans-serif"],
        mono: ["var(--font-mono)", "JetBrains Mono", "monospace"],
        pixel: ["'Geist Pixel Square'", "'Geist Pixel'", "var(--font-pixel)", "Silkscreen", "monospace"],
        display: ["'Geist Pixel Square'", "'Geist Pixel'", "var(--font-pixel)", "var(--font-sans)", "sans-serif"],
      },
      boxShadow: {
        "glow-orange": "0 0 24px -4px rgba(255, 87, 26, 0.35)",
        "glow-emerald": "0 0 20px -4px rgba(34, 197, 94, 0.35)",
        "glow-amber": "0 0 20px -4px rgba(249, 196, 37, 0.35)",
        "glow-crimson": "0 0 20px -4px rgba(255, 51, 102, 0.35)",
        "inner-dark": "inset 0 2px 6px 0 rgba(0, 0, 0, 0.8)",
      },
    },
  },
  plugins: [],
};
export default config;

