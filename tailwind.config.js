/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: [
    './src/renderer/**/*.{js,ts,jsx,tsx,html}',
    './src/extensions-private/**/src/renderer/**/*.{js,ts,jsx,tsx}'
  ],
  theme: {
    extend: {
      colors: {
        // Superhuman theme, built on their actual design tokens.
        //
        // The app's accent classes are all `blue-*`, so remapping the blue
        // palette rethemes every accent (buttons, selection, links, focus
        // rings) in one place. Anchors:
        //   #cbb7fb "Lavender Glow"  — dark-mode accent (→ blue-300)
        //   #714cb6 "Amethyst Link"  — light-mode accent (→ blue-600)
        //   #1b1938 "Mysteria"       — deep indigo hero color (→ blue-950)
        blue: {
          50: "#f7f4fe",
          100: "#efe9fd",
          200: "#e0d5fb",
          300: "#cbb7fb",
          400: "#b092f4",
          500: "#9670db",
          600: "#714cb6",
          700: "#5c3a99",
          800: "#46297a",
          900: "#2e1a54",
          950: "#1b1938",
        },
        // The agent UI uses `purple-*`. Superhuman is strictly single-accent
        // ("Lavender Glow is the only true accent"), so purple maps to the
        // same lavender scale as blue rather than a second competing hue.
        purple: {
          50: "#f7f4fe",
          100: "#efe9fd",
          200: "#e0d5fb",
          300: "#cbb7fb",
          400: "#b092f4",
          500: "#9670db",
          600: "#714cb6",
          700: "#5c3a99",
          800: "#46297a",
          900: "#2e1a54",
          950: "#1b1938",
        },
        // Superhuman's neutrals are WARM (faint brown undertone), never
        // blue-gray. Anchors from their dark/light surface tokens:
        //   #121111 base bg, #1c1b1a surface, #252423 elevated, #3a3938 border
        //   #fafaf8 soft canvas, #dcd7d3 parchment border, #292827 charcoal ink
        gray: {
          50: "#fafaf8",
          100: "#f4f3f1",
          200: "#e9e7e3",
          300: "#dcd7d3",
          400: "#a8a49e",
          500: "#7a7670",
          600: "#555250",
          700: "#3a3938",
          800: "#252423",
          900: "#1c1b1a",
          950: "#121111",
        },
      },
    },
  },
  plugins: [
    require('@tailwindcss/forms'),
  ],
}
