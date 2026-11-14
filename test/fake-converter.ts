/**
 * A stand-in for python/convert.py, run by bun: the same JSON-lines protocol, no GPU, no Seed-VC.
 * FAKE_CONVERTER picks what it does: "ok" (default), "no-cuda" (the answer a machine with no
 * CUDA GPU gives at start), "bad-scene" (every request fails), "crash" (dies on its first request).
 * What it "converts" is a file saying which variant and how many requests it has served.
 */

import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env["FAKE_CONVERTER"] ?? "ok";
const log = process.env["FAKE_CONVERTER_LOG"];
const say = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);

if (log !== undefined) appendFileSync(log, `start ${process.argv.slice(2).join(" ")}\n`);
if (mode === "no-cuda") {
  say({ error: "torch found no CUDA GPU", code: "no-cuda" });
  process.exit(1);
}
say({ ready: true });
let served = 0;
const lines = createInterface({ input: process.stdin });
for await (const line of lines) {
  if (line.trim() === "") continue;
  const request = JSON.parse(line) as { id: number; output: string; variant: string };
  if (mode === "crash") {
    process.stderr.write("CUDA out of memory\n");
    process.exit(3);
  }
  if (mode === "bad-scene") {
    say({ id: request.id, error: "RuntimeError: boom", code: "convert" });
    continue;
  }
  served += 1;
  writeFileSync(request.output, `converted:${request.variant}:${served}`);
  say({ id: request.id });
}
if (log !== undefined) appendFileSync(log, "closed\n");
