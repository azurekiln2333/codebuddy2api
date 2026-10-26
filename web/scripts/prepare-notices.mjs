import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));

// Collects upstream attribution and the complete runtime dependency license
// closure into web/public/, which Vite copies into dist/. Exported so the Vite
// build itself produces the notices: the container image runs `vp build`
// directly, so notice generation must not depend on the npm script wrapper.
export async function prepareNotices() {
  const publicDir = path.join(root, "public");
  await mkdir(publicDir, { recursive: true });
  for (const [source, target] of [
    ["LICENSE.upstream", "LICENSE.upstream.txt"],
    ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.txt"],
  ]) {
    await writeFile(path.join(publicDir, target), await readFile(path.join(root, source)));
  }

  // Retain complete license/copyright texts for the runtime dependency closure.
  // Resolve from each package so pnpm's isolated dependency layout is respected.
  const visited = new Set();
  const notices = [];
  async function collect(name, parentManifest) {
    const resolver = createRequire(parentManifest);
    let manifest;
    try {
      manifest = resolver.resolve(`${name}/package.json`);
    } catch {
      let folder = path.dirname(resolver.resolve(name));
      for (;;) {
        try {
          const candidate = path.join(folder, "package.json");
          if (JSON.parse(await readFile(candidate, "utf8")).name === name) {
            manifest = candidate;
            break;
          }
        } catch {
          // Entry points can be nested beneath the package root.
        }
        const parent = path.dirname(folder);
        if (parent === folder) throw new Error(`Cannot locate ${name} license manifest`);
        folder = parent;
      }
    }
    manifest = await realpath(manifest);
    if (visited.has(manifest)) return;
    visited.add(manifest);
    const data = JSON.parse(await readFile(manifest, "utf8"));
    const directory = path.dirname(manifest);
    const files = (await readdir(directory, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && /^(licen[cs]e|copying|notice)([.-]|$)/i.test(entry.name),
    );
    const texts = [];
    for (const entry of files.sort((a, b) => a.name.localeCompare(b.name))) {
      texts.push(`${entry.name}\n${await readFile(path.join(directory, entry.name), "utf8")}`);
    }
    if (!texts.length) {
      // Some npm packages ship their complete license inside README instead.
      const readme = await readFile(path.join(directory, "README.md"), "utf8");
      if (!/Permission is hereby granted|Apache License|Redistribution and use/i.test(readme))
        throw new Error(`Missing license text for ${data.name}@${data.version}`);
      texts.push(`README.md (includes full license)\n${readme}`);
    }
    notices.push({
      name: `${data.name}@${data.version}`,
      text: `${data.name}@${data.version} (${data.license ?? "see license text"})\n${texts.join("\n")}`,
    });
    for (const child of Object.keys(data.dependencies ?? {}).sort()) await collect(child, manifest);
  }
  const manifest = path.join(root, "package.json");
  const data = JSON.parse(await readFile(manifest, "utf8"));
  for (const name of Object.keys(data.dependencies).sort()) await collect(name, manifest);
  const output = notices
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((notice) => notice.text)
    .join("\n\n------------------------------------------------------------\n\n");
  await writeFile(path.join(publicDir, "THIRD_PARTY_LICENSES.txt"), `${output}\n`);
  console.log(`Prepared upstream attribution and ${notices.length} runtime dependency licenses.`);
}

// Allow manual runs: `node scripts/prepare-notices.mjs`.
const invoked = process.argv[1];
if (invoked && import.meta.url === pathToFileURL(invoked).href) await prepareNotices();
