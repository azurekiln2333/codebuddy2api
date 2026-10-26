// Starts the native SSO fixture without going through a shell.
//
// Playwright's `webServer.command` is a shell string, and on Windows a Python
// path containing spaces (e.g. `C:\Program Files\Python313\python.exe`) is
// fragile once it is embedded in that string. Spawning with an argument array and
// `shell: false` removes the quoting problem entirely.
//
// Interpreter precedence: WEBUI_PYTHON (the CI convention), then
// NATIVE_SSO_PYTHON, then whatever `python` resolves to on PATH.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const scriptsDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptsDir, "..", "..");

const python = process.env.WEBUI_PYTHON || process.env.NATIVE_SSO_PYTHON || "python";
const backendPort = process.env.NATIVE_SSO_BACKEND_PORT || "8791";
const idpPort = process.env.NATIVE_SSO_IDP_PORT || "8792";

const child = spawn(
  python,
  [
    "tests/native_sso_fixture.py",
    "--backend-port",
    String(backendPort),
    "--idp-port",
    String(idpPort),
  ],
  { cwd: repoRoot, env: process.env, stdio: "inherit", shell: false },
);

let stopping = false;

function shutdown(code) {
  if (stopping) return;
  stopping = true;
  // The fixture owns the backend subprocess; kill the whole tree so neither the
  // Python fixture nor the uvicorn worker outlives this wrapper.
  if (process.platform === "win32") {
    spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
  setTimeout(() => process.exit(code), 250).unref();
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
child.on("error", (error) => {
  process.stderr.write(`failed to start ${python}: ${error.message}\n`);
  process.exit(1);
});
child.on("exit", (code, signal) => {
  if (stopping) return;
  process.stderr.write(
    `native SSO fixture exited (code=${code ?? "null"} signal=${signal ?? "none"})\n`,
  );
  process.exit(code ?? 1);
});
