import fs from "node:fs";
import path from "node:path";

const roots = ["README.md", "CONTRIBUTING.md", "docs", "prototypes"];
const extensions = new Set([".md", ".html"]);
const files = [];

function collect(entry) {
  if (!fs.existsSync(entry)) return;
  const stat = fs.statSync(entry);
  if (stat.isDirectory()) {
    for (const child of fs.readdirSync(entry)) {
      collect(path.join(entry, child));
    }
    return;
  }
  if (extensions.has(path.extname(entry))) files.push(entry);
}

for (const root of roots) collect(root);

const failures = [];
const markdownLink = /!?\[[^\]]*]\(([^)]+)\)/g;
const htmlLink = /(?:href|src)=["']([^"']+)["']/g;

function validate(file, rawTarget) {
  let target = rawTarget.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1);
  }
  target = target.split(/\s+["']/)[0];
  if (
    target === "" ||
    target.startsWith("#") ||
    /^(https?:|mailto:|tel:|data:|javascript:)/i.test(target)
  ) {
    return;
  }

  const withoutAnchor = decodeURIComponent(target.split("#")[0].split("?")[0]);
  if (withoutAnchor === "") return;
  const resolved = withoutAnchor.startsWith("/")
    ? path.join(process.cwd(), withoutAnchor)
    : path.resolve(path.dirname(file), withoutAnchor);
  if (!fs.existsSync(resolved)) {
    failures.push(`${file}: missing local target ${target}`);
  }
}

for (const file of files) {
  const content = fs.readFileSync(file, "utf8");
  for (const regex of [markdownLink, htmlLink]) {
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(content)) !== null) {
      validate(file, match[1]);
    }
  }
}

if (failures.length > 0) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Local link check passed for ${files.length} files.`);
