/**
 * Cross-platform native module check.
 *
 * Ensures better-sqlite3 is compiled for Electron's ABI.
 * Runs quickly (~200ms) if already correct; rebuilds only when needed.
 *
 * Replaces the bash-only scripts/ensure-native-modules.sh.
 */

import { existsSync } from "fs";
import { execSync } from "child_process";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

const NATIVE_MODULE = join(
  projectRoot,
  "node_modules",
  "better-sqlite3",
  "build",
  "Release",
  "better_sqlite3.node",
);

function log(msg) {
  console.log(`[ensure-native] ${msg}`);
}

// First check if the .node file exists at all
if (!existsSync(NATIVE_MODULE)) {
  log("Native module not found, rebuilding...");
  process.chdir(projectRoot);
  execSync("npx electron-rebuild -f -w better-sqlite3", { stdio: "inherit" });
  process.exit(0);
}

// Check if the native module is compiled for system Node (wrong) or Electron (right).
// If `node -e "new (require('better-sqlite3'))(':memory:')"` succeeds, the module
// is compiled for Node — needs rebuild for Electron. If it fails (throws), it's
// already compiled for Electron — good to go.
try {
  process.chdir(projectRoot);
  execSync('node -e "new (require(\'better-sqlite3\'))(\':memory:\')"', { stdio: "ignore" });
  log("Native module compiled for system Node, rebuilding for Electron...");
  execSync("npx electron-rebuild -f -w better-sqlite3", { stdio: "inherit" });
} catch {
  log("Native modules OK");
}
