#!/usr/bin/env node
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = value => createHash("sha256").update(value).digest("hex");

export async function buildCodexCompat(root = repoRoot) {
  const source = join(root, "integrations/codex-compat");
  const provenance = JSON.parse(await readFile(join(source, "provenance.json"), "utf8"));
  const names = ["long-session-hook-client.mjs", ...Object.keys(provenance.events).map(name => `${name}.mjs`)];
  const sourceHashes = Object.fromEntries(await Promise.all([...names, "provenance.json"].map(async name => [name, sha256(await readFile(join(source, name)))])));
  const outputs = [];
  for (const directory of ["plugin/scripts", "dist/hooks"]) {
    const capture = await readFile(join(root, directory, "_capture.mjs"));
    if (!capture.toString().match(/export \{[^}]*\bhandoffObservation\b/s)) throw new Error(`Build official capture handoff before Codex compatibility artifacts: ${directory}`);
    const destination = join(root, directory, "codex-compat");
    await mkdir(destination, { recursive: true });
    for (const name of [...names, "provenance.json"]) await copyFile(join(source, name), join(destination, name));
    await writeFile(join(destination, "_capture.mjs"), capture);
    const files = { ...sourceHashes, "_capture.mjs": sha256(capture) };
    const deploymentMapping = Object.fromEntries(names.map(name => [`${directory}/${name}`, `${directory}/codex-compat/${name}`]));
    // Current custom wrappers are deployed explicitly; stock top-level hooks remain intact.
    const manifest = { revision: provenance.revision, canonicalArtifact: provenance.canonicalArtifact, canonicalSha256: provenance.canonicalSha256, files, deploymentMapping, sharedCaptureMapping: { [`${directory}/_capture.mjs`]: `${directory}/codex-compat/_capture.mjs` }, requiredSharedCapture: `${directory}/codex-compat/_capture.mjs` };
    await writeFile(join(destination, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    outputs.push(manifest);
  }
  return outputs;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildCodexCompat();
  console.log("Built explicit Codex custom compatibility artifacts; stock hooks preserved.");
}
