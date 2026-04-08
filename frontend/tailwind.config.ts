import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
    "./src/hooks/**/*.{ts,tsx}",
    "./src/lib/**/*.{ts,tsx}",
    "./src/stores/**/*.{ts,tsx}"
  ],
  theme: {
    extend: {
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        panel: "rgb(var(--panel) / <alpha-value>)",
        line: "rgb(var(--line) / <alpha-value>)",
        ink: "rgb(var(--ink) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        accentSoft: "rgb(var(--accent-soft) / <alpha-value>)",
        warn: "rgb(var(--warn) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)"
      },
      fontFamily: {
        display: ["var(--font-display)"],
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"]
      },
      boxShadow: {
        panel: "0 24px 80px rgba(17, 24, 39, 0.08)",
        card: "0 16px 40px rgba(30, 41, 59, 0.08)"
      },
      backgroundImage: {
        paper:
          "radial-gradient(circle at 0 0, rgba(18,81,110,0.08) 1px, transparent 0), radial-gradient(circle at 18px 18px, rgba(191,143,59,0.08) 1px, transparent 0)"
      }
    }
  },
  plugins: []
};

export default config;
