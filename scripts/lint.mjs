import { readdir, readFile } from "node:fs/promises";
import { extname, join } from "node:path";

const roots = ["server.mjs", "src", "public", "test"];
const forbidden = [/\beval\s*\(/, /innerHTML\s*=/, /document\.write\s*\(/];
const files = [];

async function walk(path) {
  if (extname(path)) {
    files.push(path);
    return;
  }
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) await walk(child);
    else if ([".js", ".mjs", ".html", ".css"].includes(extname(child))) files.push(child);
  }
}

for (const root of roots) await walk(root);
const failures = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const rule of forbidden) {
    if (rule.test(source)) failures.push(`${file}: forbidden pattern ${rule}`);
  }
  if (source.includes("\t")) failures.push(`${file}: tab character found`);
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Linted ${files.length} files`);
}
