import { expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { SCENE, studio } from "./studio";

async function newVideo(s: ReturnType<typeof studio>, title = "Hero video") {
  const made = await s.ask("videos", { title, product: "odi" });
  return made.created.id as string;
}

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

test("activate registers the five tools, none of which asks the reader", async () => {
  const s = studio();
  expect(s.fake.tools().map((tool) => tool.name)).toEqual([
    "demo_list",
    "demo_brief_get",
    "demo_brief_set",
    "demo_script_set",
    "demo_notes",
  ]);
  const id = await newVideo(s);
  await s.fake.callTool("demo_brief_set", { video: id, brief: { title: "Hero video", product: "odi" } });
  await s.fake.callTool("demo_script_set", { video: id, scenes: [SCENE] });
  expect(s.fake.confirms).toEqual([]);
});

test("demo_list says when there are no videos, then lists them", async () => {
  const s = studio();
  expect(await s.fake.callTool("demo_list", {})).toContain("No videos yet");
  const id = await newVideo(s);
  const listed = JSON.parse(await s.fake.callTool("demo_list", {}));
  expect(listed).toMatchObject([{ id, title: "Hero video", product: "odi" }]);
  // The index in api.state holds only the index fields.
  expect(Object.keys(listed[0]).sort()).toEqual(["id", "languages", "product", "title", "updatedAt"]);
});

test("a new video gets its folder with brief, scenes and the empty subfolders", async () => {
  const s = studio();
  const id = await newVideo(s);
  expect((await readdir(join(s.dir, id))).sort()).toEqual([
    "audio",
    "brief.json",
    "out",
    "scenes.json",
    "stills",
    "takes",
  ]);
  expect(JSON.parse(await readFile(join(s.dir, id, "scenes.json"), "utf8"))).toEqual({ version: 1, scenes: [] });
});

test("demo_brief_set validates, writes and demo_brief_get reads it back", async () => {
  const s = studio();
  const id = await newVideo(s);
  const brief = {
    title: "Hiring in a day",
    product: "odi",
    audience: "Recruiters",
    pain: "Shortlists take weeks",
    aha: "Ranked in seconds",
    callToAction: "Book a demo",
    languages: ["sv", "en"],
    targetSeconds: 75,
  };
  await s.fake.callTool("demo_brief_set", { video: id, brief });
  expect(JSON.parse(await s.fake.callTool("demo_brief_get", { video: id }))).toEqual(brief);
  expect(JSON.parse(await s.fake.callTool("demo_list", {}))[0].title).toBe("Hiring in a day");
  await expect(
    s.fake.callTool("demo_brief_set", { video: id, brief: { ...brief, surprise: true } }),
  ).rejects.toThrow("does not fit");
  await expect(s.fake.callTool("demo_brief_get", { video: "../etc" })).rejects.toThrow();
});

test("demo_script_set writes scenes.json and reports the narration against the target", async () => {
  const s = studio();
  const id = await newVideo(s);
  await s.fake.callTool("demo_brief_set", {
    video: id,
    brief: { title: "T", product: "odi", languages: ["en"], targetSeconds: 60 },
  });
  const answer = await s.fake.callTool("demo_script_set", {
    video: id,
    scenes: [{ ...SCENE, narration: { en: words(125) } }],
  });
  expect(answer).toContain("Saved 1 scenes.");
  expect(answer).toContain("en: 125 words, about 50 s of 60 s (83 %)");
  expect(answer).toContain("cut about 5 s");
  expect(answer).toContain("House rules: no violations.");
  const file = JSON.parse(await readFile(join(s.dir, id, "scenes.json"), "utf8"));
  expect(file.scenes[0].review).toEqual({ status: "pending", notes: [] });
});

test("demo_script_set reports house-rule violations but still saves", async () => {
  const s = studio();
  const id = await newVideo(s);
  const answer = await s.fake.callTool("demo_script_set", {
    video: id,
    scenes: [{ ...SCENE, onScreen: `Open ODI ${words(14)}` }],
  });
  expect(answer).toContain("pain: 16 words on screen; at most 15");
  expect(answer).toContain('says "ODI"');
  expect((await s.ask("video", null, { id })).scenes).toHaveLength(1);
});

test("demo_script_set refuses a script that does not fit, naming the scene, and keeps the old one", async () => {
  const s = studio();
  const id = await newVideo(s);
  await s.fake.callTool("demo_script_set", { video: id, scenes: [SCENE] });
  await expect(
    s.fake.callTool("demo_script_set", { video: id, scenes: [{ ...SCENE, bogus: 1 }, { id: "x" }] }),
  ).rejects.toThrow(/scene 1 \(pain\)[\s\S]*scene 2 \(x\)/);
  expect((await s.ask("video", null, { id })).scenes).toHaveLength(1);
});

test("an unchanged scene keeps its review when the script is saved again; a changed one starts over", async () => {
  const s = studio();
  const id = await newVideo(s);
  const other = { ...SCENE, id: "second", title: "Second" };
  await s.fake.callTool("demo_script_set", { video: id, scenes: [SCENE, other] });
  await s.ask("review", { id, scene: "pain", status: "approved" });
  await s.ask("review", { id, scene: "second", status: "approved" });
  await s.fake.callTool("demo_script_set", {
    video: id,
    scenes: [SCENE, { ...other, narration: { en: "New words." } }],
  });
  const scenes = (await s.ask("video", null, { id })).scenes;
  expect(scenes.map((scene: { review: { status: string } }) => scene.review.status)).toEqual(["approved", "pending"]);
});

test("demo_notes returns the reader's notes per scene", async () => {
  const s = studio();
  const id = await newVideo(s);
  expect(await s.fake.callTool("demo_notes", { video: id })).toBe("No scenes yet.");
  await s.fake.callTool("demo_script_set", { video: id, scenes: [SCENE, { ...SCENE, id: "b", title: "B" }] });
  await s.ask("review", { id, scene: "pain", status: "noted", notes: ["Too slow", "Cut the intro"] });
  const notes = await s.fake.callTool("demo_notes", { video: id });
  expect(notes).toContain("pain (The pain): noted\n  - Too slow\n  - Cut the intro");
  expect(notes).toContain("b (B): pending");
});

test("a prifly without api.state says so instead of crashing the host", async () => {
  const s = studio({ noState: true });
  await expect(s.fake.callTool("demo_list", {})).rejects.toThrow("api.state");
});
