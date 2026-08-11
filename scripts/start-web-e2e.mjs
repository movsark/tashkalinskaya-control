import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const distDir = process.env.NEXT_DIST_DIR?.trim() || ".next";
const webBuild = path.join(root, "apps/web", distDir);
const standaloneWeb = path.join(webBuild, "standalone/apps/web");
await mkdir(path.join(standaloneWeb, distDir), { recursive: true });
await cp(path.join(webBuild, "static"), path.join(standaloneWeb, distDir, "static"), {
  force: true,
  recursive: true,
});
await cp(path.join(root, "apps/web/public"), path.join(standaloneWeb, "public"), {
  force: true,
  recursive: true,
});
process.env.HOSTNAME = "127.0.0.1";
process.env.PORT = "4181";
await import(pathToFileURL(path.join(standaloneWeb, "server.js")).href);
