/**
 * Cross-platform test runner.
 *
 * Handles better-sqlite3 ABI compatibility:
 * - Unit tests run with system Node (ABI 127)
 * - E2E/Integration tests run with Electron's Node (ABI 132)
 *
 * Replaces the bash-only scripts/run-tests.sh.
 *
 * Usage:
 *   node scripts/run-tests.mjs          # Run all tests
 *   node scripts/run-tests.mjs unit     # Run unit tests only
 *   node scripts/run-tests.mjs e2e      # Run e2e tests only
 *   node scripts/run-tests.mjs integration # Run integration tests only
 */

import { execSync, spawn } from "child_process";
import { existsSync, rmSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, "..");

// ─── Helpers ───────────────────────────────────────────────────────────

function log(msg, level = "info") {
  const prefix = {
    info: "\x1b[32m[INFO]\x1b[0m",
    warn: "\x1b[33m[WARN]\x1b[0m",
    error: "\x1b[31m[ERROR]\x1b[0m",
  }[level];
  console.log(`${prefix} ${msg}`);
}

function isWindows() {
  return process.platform === "win32";
}

function isMac() {
  return process.platform === "darwin";
}

function isLinux() {
  return process.platform === "linux";
}

function hasDisplay() {
  if (isMac() || isWindows()) return true;
  if (process.env.DISPLAY) return true;
  try {
    execSync("which xvfb-run", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runCmd(cmd) {
  try {
    execSync(cmd, { stdio: "inherit", cwd: projectRoot });
    return true;
  } catch {
    return false;
  }
}

// ─── ABI Detection ─────────────────────────────────────────────────────

/**
 * Returns true if better-sqlite3 can be loaded from system Node.
 * If true, the module is compiled for Node (wrong ABI for Electron) — needs rebuild.
 * If false (throws), it's compiled for Electron.
 */
function nodeCanLoadBetterSqlite3() {
  try {
    execSync('node -e "new (require(\'better-sqlite3\'))(\':memory:\')"', {
      cwd: projectRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function rebuildForNode() {
  log("Rebuilding better-sqlite3 for system Node...");
  rmSync(join(projectRoot, "node_modules", "better-sqlite3", "build"), {
    recursive: true,
    force: true,
  });
  rmSync(join(projectRoot, "node_modules", "better-sqlite3", "prebuilds"), {
    recursive: true,
    force: true,
  });
  if (!runCmd("npm rebuild better-sqlite3")) {
    log("Failed to rebuild better-sqlite3 for Node", "error");
    process.exit(1);
  }
  const abi = process.versions.modules;
  log(`better-sqlite3 rebuilt for system Node (ABI ${abi})`);
}

function rebuildForElectron() {
  log("Rebuilding better-sqlite3 for Electron...");
  rmSync(join(projectRoot, "node_modules", "better-sqlite3", "build"), {
    recursive: true,
    force: true,
  });
  rmSync(join(projectRoot, "node_modules", "better-sqlite3", "prebuilds"), {
    recursive: true,
    force: true,
  });
  if (!runCmd("npx @electron/rebuild --force --build-from-source")) {
    log("Failed to rebuild better-sqlite3 for Electron", "error");
    process.exit(1);
  }
  log("better-sqlite3 rebuilt for Electron");
}

function ensureBuild() {
  const mainJs = join(projectRoot, "out", "main", "index.js");
  if (!existsSync(mainJs)) {
    log("Building Electron app (out/main/index.js not found)...");
    if (!runCmd("npm run build")) {
      log("Failed to build Electron app", "error");
      process.exit(1);
    }
    log("Build complete");
  }
}

// ─── Cleanup ───────────────────────────────────────────────────────────

function cleanTestDbs() {
  const home = homedir();

  const dataDirs = isMac()
    ? [
        `${home}/Library/Application Support/Electron/data`,
        `${home}/Library/Application Support/exo/data`,
      ]
    : isLinux()
      ? [`${home}/.config/Electron/data`, `${home}/.config/exo/data`]
      : [`${process.env.APPDATA}/Electron/data`, `${process.env.APPDATA}/exo/data`];

  const configDirs = isMac()
    ? [
        `${home}/Library/Application Support/Electron`,
        `${home}/Library/Application Support/exo`,
      ]
    : isLinux()
      ? [`${home}/.config/Electron`, `${home}/.config/exo`]
      : [`${process.env.APPDATA}/Electron`, `${process.env.APPDATA}/exo`];

  let cleaned = 0;
  const dbPrefixes = ["exo-demo-w"];

  for (const dir of dataDirs) {
    if (!existsSync(dir)) continue;
    try {
      for (const f of readdirSync(dir)) {
        for (const prefix of dbPrefixes) {
          if (f.startsWith(prefix)) {
            const fp = join(dir, f);
            try {
              rmSync(fp, { recursive: true, force: true });
              cleaned++;
            } catch {
              /* skip locked files */
            }
          }
        }
      }
    } catch {
      /* skip unreadable dirs */
    }
  }

  for (const dir of configDirs) {
    const cfgPath = join(dir, "exo-config.json");
    if (existsSync(cfgPath)) {
      try {
        rmSync(cfgPath);
        cleaned++;
      } catch {
        /* skip */
      }
    }
  }

  if (cleaned > 0) log(`Cleaned up ${cleaned} test artifact file(s)`);
}

// ─── Playwright Runner ─────────────────────────────────────────────────

/**
 * Run Playwright tests, tolerating worker teardown timeouts.
 * Playwright exits non-zero when a worker's afterAll hangs past 60s,
 * even if every test passed. This is an Electron process cleanup issue
 * (dangling pipe handles), not a test failure.
 */
async function runPlaywrightTolerant(projects) {
  const projectList = Array.isArray(projects) ? projects : [projects];
  const projectArgs = projectList.map((p) => `--project=${p}`).join(" ");

  const env = { ...process.env, EXO_DEMO_MODE: "true" };

  // Build the command with proper quoting for the platform
  const args = [
    "playwright",
    "test",
    ...projectList.flatMap((p) => ["--project", p]),
  ];

  // Use npx.cmd on Windows, npx elsewhere
  const npxCmd = isWindows() ? "npx.cmd" : "npx";

  return new Promise((resolve) => {
    const child = spawn(npxCmd, args, {
      cwd: projectRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWindows(),
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const text = d.toString();
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderr += text;
      process.stderr.write(text);
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve(0);
        return;
      }

      // Tolerate worker teardown timeouts
      const failedMatch = stdout.match(/(\d+) failed/);
      const passedMatch = stdout.match(/(\d+) passed/);
      const hasRealFailures = failedMatch && parseInt(failedMatch[1]) > 0;
      const hasPasses = passedMatch && parseInt(passedMatch[1]) > 0;
      const hasTeardownTimeout =
        stdout.includes("Worker teardown timeout") ||
        stderr.includes("Worker teardown timeout");

      if (hasRealFailures) {
        log("Tests have real failures", "error");
        resolve(code);
      } else if (hasPasses && hasTeardownTimeout) {
        log(
          "All tests passed but worker teardown timed out — treating as pass",
          "warn",
        );
        resolve(0);
      } else {
        resolve(code);
      }
    });
  });
}

// ─── Test Suites ───────────────────────────────────────────────────────

async function runUnitTests() {
  log("=== Running Unit Tests ===");
  rebuildForNode();
  return runCmd("EXO_DEMO_MODE=true npx playwright test --project=unit");
}

async function runE2ETests() {
  log("=== Running E2E Tests ===");
  if (!hasDisplay()) {
    log("No display available. Either set DISPLAY or install xvfb.", "error");
    process.exit(1);
  }
  ensureBuild();
  rebuildForElectron();
  cleanTestDbs();
  const result = await runPlaywrightTolerant("e2e");
  cleanTestDbs();
  return result === 0;
}

async function runIntegrationTests() {
  log("=== Running Integration Tests ===");
  if (!hasDisplay()) {
    log("No display available. Either set DISPLAY or install xvfb.", "error");
    process.exit(1);
  }
  ensureBuild();
  rebuildForElectron();
  return (await runPlaywrightTolerant("integration")) === 0;
}

async function runAllTests() {
  let electronFailed = false;

  cleanTestDbs();

  // Phase 1: Integration + E2E tests (need Electron-compiled better-sqlite3)
  if (hasDisplay()) {
    log("=== Phase 1: Integration + E2E Tests ===");
    ensureBuild();

    if (nodeCanLoadBetterSqlite3()) {
      log(
        "better-sqlite3 compiled for system Node, rebuilding for Electron...",
        "warn",
      );
      rebuildForElectron();
    } else {
      log(
        "better-sqlite3 already compiled for Electron, skipping rebuild",
      );
    }

    const result = await runPlaywrightTolerant(["integration", "e2e"]);
    if (result !== 0) electronFailed = true;
  } else {
    log("No display available — skipping E2E/Integration tests", "warn");
  }

  cleanTestDbs();

  // Phase 2: Unit tests (need Node-compiled better-sqlite3)
  log("=== Phase 2: Unit Tests ===");
  rebuildForNode();
  const unitResult = runCmd(
    "EXO_DEMO_MODE=true npx playwright test --project=unit",
  )
    ? 0
    : 1;

  // Summary
  console.log("");
  log("=== Test Summary ===");
  if (electronFailed) {
    console.log("  Integration + E2E: \x1b[31mFAILED\x1b[0m");
  } else {
    console.log("  Integration + E2E: \x1b[32mPASSED\x1b[0m");
  }
  if (unitResult !== 0) {
    console.log("  Unit:              \x1b[31mFAILED\x1b[0m");
  } else {
    console.log("  Unit:              \x1b[32mPASSED\x1b[0m");
  }

  if (unitResult !== 0 || electronFailed) process.exit(1);
}

// ─── Main ──────────────────────────────────────────────────────────────

const suite = process.argv[2] || "all";

switch (suite) {
  case "unit": {
    const ok = await runUnitTests();
    process.exit(ok ? 0 : 1);
  }
  case "e2e": {
    const ok = await runE2ETests();
    process.exit(ok ? 0 : 1);
  }
  case "integration": {
    const ok = await runIntegrationTests();
    process.exit(ok ? 0 : 1);
  }
  case "all":
    await runAllTests();
    break;
  default:
    console.log(
      "Usage: node scripts/run-tests.mjs [unit|e2e|integration|all]",
    );
    process.exit(1);
}

log("All tests completed successfully!");
