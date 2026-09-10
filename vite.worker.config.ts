import { resolve } from 'path'
import { defineConfig } from 'vite'

/**
 * Separate build config for the agent-worker utility process.
 *
 * The agent-worker runs in an Electron utility process and must be
 * a standalone CJS file — it can't be merged into the main bundle
 * because rollup would fold shared modules between entry points.
 *
 * Build order:
 *   1. electron-vite builds main/preload/renderer into out/
 *   2. This config builds agent-worker.js into out/main/ (emptyOutDir: false)
 */
export default defineConfig({
  build: {
    outDir: 'out/worker',
    emptyOutDir: false,
    lib: {
      entry: resolve(__dirname, 'src/main/agents/agent-worker.ts'),
      formats: ['cjs'],
      fileName: () => 'agent-worker.cjs',
    },
    rollupOptions: {
      external: (id: string) => {
        // Entry point and relative imports (project source) are NOT external
        if (id.startsWith(".") || id.startsWith("/") || /^[A-Za-z]:[\\/]/.test(id)) {
          return false;
        }
        // Electron and native modules are always external
        if (id === "electron" || id === "better-sqlite3") return true;
        // All other bare imports (node_modules packages) are external
        return true;
      },
    },
    target: 'node20',
    minify: false,
    sourcemap: true,
  },
  resolve: {
    conditions: ['node'],
  },
})
