import { spawnSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const distDir = ".next-e2e";
const buildDirectory = path.join(root, "apps/web", distDir);
const nextEnvPath = path.join(root, "apps/web/next-env.d.ts");
const originalNextEnv = await readFile(nextEnvPath, "utf8");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
const environment = {
  ...process.env,
  INTERNAL_API_URL: process.env.INTERNAL_API_URL ?? "http://127.0.0.1:4180/api/v1",
  NEXT_DIST_DIR: distDir,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? "/api/v1",
};

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: environment,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  return result.status ?? 1;
}

await rm(buildDirectory, { force: true, recursive: true });

try {
  const buildStatus = run(npmCommand, ["run", "build", "-w", "@tashkalinskaya/web"]);

  process.exitCode =
    buildStatus === 0
      ? run(npxCommand, ["--no-install", "playwright", "test", ...process.argv.slice(2)])
      : buildStatus;
} finally {
  await writeFile(nextEnvPath, originalNextEnv);
  await rm(buildDirectory, { force: true, recursive: true });
}
