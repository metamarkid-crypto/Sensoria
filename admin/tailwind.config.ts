import type { Config } from "tailwindcss";

/**
 * Design tokens matched to aacsensoria.id:
 *  • Deep Slate surfaces  #0F172A (bg) / #1E293B (card)
 *  • Teal accent          #0D9488 / #14B8A6
 *  • Glassmorphism        translucent cards + blur + hairline borders
 */
const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: "#0F172A", // page background
          soft: "#16203A",
          card: "#1E293B",
          line: "rgba(148, 163, 184, 0.14)",
        },
        teal: {
          DEFAULT: "#14B8A6",
          deep: "#0D9488",
          soft: "rgba(20, 184, 166, 0.12)",
        },
        muted: "#94A3B8",
      },
      boxShadow: {
        glass: "0 8px 32px rgba(2, 6, 23, 0.55)",
      },
      backdropBlur: { card: "12px" },
    },
  },
  plugins: [],
};

export default config;
