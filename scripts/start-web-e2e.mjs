import { cp, mkdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const standaloneWeb = path.join(root, "apps/web/.next/standalone/apps/web");
await mkdir(path.join(standaloneWeb, ".next"), { recursive: true });
await cp(path.join(root, "apps/web/.next/static"), path.join(standaloneWeb, ".next/static"), {
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
