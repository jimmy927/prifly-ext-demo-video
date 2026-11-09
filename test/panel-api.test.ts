import { expect, test } from "bun:test";
import type { ExtensionModule } from "@prifly/extension-api";
import * as extension from "../index";
import { SCENE, studio } from "./studio";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;

test("the module fits the contract and exports the panel and the launcher", () => {
  expect(typeof module.panel).toBe("function");
  expect(typeof module.launch).toBe("function");
});

test("config says whether the host has panel-media, and which voices and key", async () => {
  const without = await studio().ask("config");
  expect(without).toMatchObject({
    media: false,
    elevenLabsKey: false,
    voices: { sv: "sv-SE-SofieNeural", en: "en-GB-SoniaNeural" },
  });
  const withMedia = await studio({ features: ["panel-media", "panel-open-session"] }).ask("config");
  expect(withMedia).toMatchObject({ media: true, openSession: true });
});

test("create, list, read and save a brief through the panel routes", async () => {
  const s = studio();
  expect(await s.ask("videos")).toEqual({ videos: [] });
  const { created } = await s.ask("videos", { title: "Role analysis", product: "odi" });
  expect(created).toMatchObject({
    id: "role-analysis",
    title: "Role analysis",
    languages: ["sv", "en"],
  });
  expect((await s.ask("videos")).videos).toHaveLength(1);
  const read = await s.ask("video", null, { id: "role-analysis" });
  expect(read.brief.title).toBe("Role analysis");
  expect(read.scenes).toEqual([]);
  const saved = await s.ask("brief", {
    id: "role-analysis",
    brief: { ...read.brief, targetSeconds: 30, languages: ["en"] },
  });
  expect(saved.brief.targetSeconds).toBe(30);
  expect((await s.ask("videos")).videos[0].languages).toEqual(["en"]);
});

test("two videos with the same title get different ids", async () => {
  const s = studio();
  const a = await s.ask("videos", { title: "Same", product: "prifly" });
  const b = await s.ask("videos", { title: "Same", product: "prifly" });
  expect([a.created.id, b.created.id]).toEqual(["same", "same-2"]);
});

test("errors come back as throws the host turns into the page's inline error", async () => {
  const s = studio();
  await expect(s.ask("videos", { title: "  ", product: "odi" })).rejects.toThrow(
    "title is required",
  );
  await expect(s.ask("videos", { title: "x", product: "other" })).rejects.toThrow(
    "product must be",
  );
  await expect(s.ask("video", null, { id: "missing" })).rejects.toThrow("No video missing");
  await expect(s.ask("video", null, { id: "../../etc" })).rejects.toThrow("No video");
  await expect(s.ask("nonsense")).rejects.toThrow("No such request");
});

test("saving scenes from the editor is strict; review status and notes are saved", async () => {
  const s = studio();
  const { created } = await s.ask("videos", { title: "V", product: "odi" });
  const id = created.id;
  const saved = await s.ask("scenes", { id, scenes: [SCENE] });
  expect(saved.scenes).toHaveLength(1);
  expect(saved.timing[0]).toMatchObject({ language: "sv" });
  await expect(s.ask("scenes", { id, scenes: [{ ...SCENE, extra: 1 }] })).rejects.toThrow(
    "does not fit",
  );
  const noted = await s.ask("review", {
    id,
    scene: "pain",
    status: "noted",
    notes: ["Slower", " "],
  });
  expect(noted.scenes[0].review).toEqual({ status: "noted", notes: ["Slower"] });
  const approved = await s.ask("review", { id, scene: "pain", status: "approved" });
  expect(approved.scenes[0].review).toEqual({ status: "approved", notes: ["Slower"] });
  await expect(s.ask("review", { id, scene: "pain", status: "maybe" })).rejects.toThrow(
    "status must be",
  );
  await expect(s.ask("review", { id, scene: "ghost", status: "approved" })).rejects.toThrow(
    "No scene ghost",
  );
});

test("a scene file edited by hand opens: the bad scene is reported, not a crash", async () => {
  const s = studio();
  const { created } = await s.ask("videos", { title: "V", product: "odi" });
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    `${s.dir}/${created.id}/scenes.json`,
    JSON.stringify({ scenes: [{ ...SCENE, colour: "red" }, { id: "broken" }] }),
  );
  const read = await s.ask("video", null, { id: created.id });
  expect(read.scenes).toHaveLength(1);
  expect(read.problems).toHaveLength(1);
});

test("render and export say they are not available yet", async () => {
  const s = studio();
  for (const path of ["render", "export"]) {
    expect(await s.ask(path, {})).toMatchObject({ available: false });
  }
});

test("the panel's buttons launch a session carrying the brief and the video id", async () => {
  const s = studio();
  const { created } = await s.ask("videos", { title: "Role analysis", product: "odi" });
  const write = await extension.launch("demo", `write:${created.id}`);
  expect(write.prompt).toContain(`id: ${created.id}`);
  expect(write.prompt).toContain('"title": "Role analysis"');
  expect(write.prompt).toContain("demo_script_set");
  await s.ask("scenes", { id: created.id, scenes: [SCENE] });
  const tighten = await extension.launch("demo", `tighten:${created.id}`);
  expect(tighten.prompt).toContain("Tighten it");
  expect(tighten.prompt).toContain("sv: 0 words");
  await expect(extension.launch("demo", "nope")).rejects.toThrow("Not a Demo studio key");
  await expect(extension.launch("other", `write:${created.id}`)).rejects.toThrow("No launcher");
  await extension.launched("demo", `write:${created.id}`, "session-1");
  expect((await s.ask("video", null, { id: created.id })).session).toBe("session-1");
  expect(await extension.choices("demo", "")).toEqual([]);
});

test("an approved scene edited in the editor starts over, even when its review comes back approved", async () => {
  const s = studio();
  const { created } = await s.ask("videos", { title: "V", product: "odi" });
  const id = created.id;
  await s.ask("scenes", { id, scenes: [SCENE] });
  const approved = await s.ask("review", { id, scene: "pain", status: "approved" });
  const edited = { ...approved.scenes[0], narration: { en: "Different words." } };
  const saved = await s.ask("scenes", { id, scenes: [edited] });
  expect(saved.scenes[0].review.status).toBe("pending");
  const same = await s.ask("review", { id, scene: "pain", status: "approved" });
  const again = await s.ask("scenes", { id, scenes: same.scenes });
  expect(again.scenes[0].review.status).toBe("approved");
});

test("approving a scene leaves hand-edited scenes and fields in the file", async () => {
  const s = studio();
  const { created } = await s.ask("videos", { title: "V", product: "odi" });
  const { readFile, writeFile } = await import("node:fs/promises");
  const path = `${s.dir}/${created.id}/scenes.json`;
  await writeFile(
    path,
    JSON.stringify({ scenes: [{ ...SCENE, colour: "red" }, { id: "broken" }] }),
  );
  await s.ask("review", { id: created.id, scene: "pain", status: "approved" });
  const file = JSON.parse(await readFile(path, "utf8"));
  expect(file.scenes).toHaveLength(2);
  expect(file.scenes[0].colour).toBe("red");
  expect(file.scenes[0].review.status).toBe("approved");
  expect(file.scenes[1]).toEqual({ id: "broken" });
});
