import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { SCENE, studio } from "./studio";

async function newVideo(s: ReturnType<typeof studio>, title = "Hero video") {
  const made = await s.ask("videos", { title, product: "odi" });
  return made.created.id as string;
}

const words = (n: number) => Array.from({ length: n }, () => "word").join(" ");

test("demo_create makes a video that demo_list and the panel show, with its brief in the same call", async () => {
  const s = studio();
  const made = await s.fake.callTool("demo_create", { title: "Ashby grading", product: "odi" });
  const id = /Video (\S+) made/.exec(made)?.[1] as string;
  expect(JSON.parse(await s.fake.callTool("demo_list", {}))).toMatchObject([
    { id, title: "Ashby grading", product: "odi" },
  ]);
  expect((await s.ask("videos", null)).videos).toMatchObject([{ id }]);
  const brief = {
    title: "Grade in Ashby",
    product: "odi",
    pain: "Slow grading",
    languages: ["en"],
  };
  const second = await s.fake.callTool("demo_create", {
    title: "Grade in Ashby",
    product: "odi",
    brief,
  });
  const secondId = /Video (\S+) made, brief saved/.exec(second)?.[1] as string;
  expect(JSON.parse(await s.fake.callTool("demo_brief_get", { video: secondId }))).toMatchObject(
    brief,
  );
  expect(s.fake.confirms).toEqual([]);
});

test("demo_create with a title that exists returns the same id and leaves its brief alone", async () => {
  const s = studio();
  const first = await s.fake.callTool("demo_create", {
    title: "Hero video",
    product: "odi",
    brief: { title: "Hero video", product: "odi", pain: "Kept" },
  });
  const id = /Video (\S+) made/.exec(first)?.[1] as string;
  const again = await s.fake.callTool("demo_create", {
    title: "  hero VIDEO ",
    product: "prifly",
    brief: { title: "Hero video", product: "odi", pain: "Overwritten?" },
  });
  expect(again).toContain("already exists");
  expect(again).toContain(id);
  expect(again).toContain("demo_brief_set");
  expect(again).toContain("odi video, not prifly");
  // A brief whose own title names an existing video would make a second one of that title.
  const viaBrief = await s.fake.callTool("demo_create", {
    title: "Another",
    product: "odi",
    brief: { title: "HERO video", product: "odi" },
  });
  expect(viaBrief).toContain(`already exists: ${id}`);
  expect(JSON.parse(await s.fake.callTool("demo_list", {}))).toHaveLength(1);
  expect(JSON.parse(await s.fake.callTool("demo_brief_get", { video: id })).pain).toBe("Kept");
});

test("demo_create refuses a missing title or an unknown product, and keeps the video when its brief does not fit", async () => {
  const s = studio();
  await expect(s.fake.callTool("demo_create", { title: " ", product: "odi" })).rejects.toThrow(
    "title is required",
  );
  await expect(s.fake.callTool("demo_create", { title: "x", product: "other" })).rejects.toThrow(
    "product must be odi or prifly",
  );
  const bad = await s.fake.callTool("demo_create", {
    title: "Half",
    product: "odi",
    brief: { title: "Half", product: "odi", nonsense: 1 },
  });
  expect(bad).toContain("brief was not written");
  expect(JSON.parse(await s.fake.callTool("demo_list", {}))).toHaveLength(1);
});

test("activate registers the nine tools, none of which asks the reader", async () => {
  const s = studio();
  expect(s.fake.tools().map((tool) => tool.name)).toEqual([
    "demo_list",
    "demo_create",
    "demo_brief_get",
    "demo_brief_set",
    "demo_script_set",
    "demo_notes",
    "demo_render",
    "demo_dry_run",
    "demo_open",
  ]);
  const id = await newVideo(s);
  await s.fake.callTool("demo_brief_set", {
    video: id,
    brief: { title: "Hero video", product: "odi" },
  });
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
  expect(Object.keys(listed[0]).sort()).toEqual([
    "id",
    "languages",
    "product",
    "title",
    "updatedAt",
  ]);
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
  expect(JSON.parse(await readFile(join(s.dir, id, "scenes.json"), "utf8"))).toEqual({
    version: 1,
    scenes: [],
  });
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
    s.fake.callTool("demo_script_set", {
      video: id,
      scenes: [{ ...SCENE, bogus: 1 }, { id: "x" }],
    }),
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
  expect(scenes.map((scene: { review: { status: string } }) => scene.review.status)).toEqual([
    "approved",
    "pending",
  ]);
});

test("a script_set that edits a scene keeps its notes and sets it pending; removed notes go, new scenes start empty", async () => {
  const s = studio();
  const id = await newVideo(s);
  const two = { ...SCENE, id: "two", title: "Two" };
  const three = { ...SCENE, id: "three", title: "Three" };
  await s.fake.callTool("demo_script_set", { video: id, scenes: [SCENE, two, three] });
  await s.ask("review", { id, scene: "pain", status: "noted", notes: ["Keep me"] });
  await s.ask("review", { id, scene: "two", status: "noted", notes: ["Too slow", "Cut it"] });
  await s.ask("review", { id, scene: "three", status: "noted", notes: ["Gone"] });
  await s.fake.callTool("demo_script_set", {
    video: id,
    scenes: [
      SCENE,
      { ...two, narration: { en: "Faster words." }, review: { status: "approved", notes: ["Sent back"] } },
      { ...SCENE, id: "fresh", title: "Fresh", review: { status: "approved", notes: ["Sneaky"] } },
    ],
  });
  const scenes = (await s.ask("video", null, { id })).scenes;
  expect(scenes.map((scene: { id: string; review: unknown }) => [scene.id, scene.review])).toEqual([
    ["pain", { status: "noted", notes: ["Keep me"] }],
    ["two", { status: "pending", notes: ["Too slow", "Cut it"] }],
    ["fresh", { status: "pending", notes: [] }],
  ]);
  const notes = await s.fake.callTool("demo_notes", { video: id });
  expect(notes).toContain("two (Two): pending\n  - Too slow\n  - Cut it");
  expect(notes).not.toContain("Gone");
});

test("demo_notes returns the reader's notes per scene", async () => {
  const s = studio();
  const id = await newVideo(s);
  expect(await s.fake.callTool("demo_notes", { video: id })).toBe("No scenes yet.");
  await s.fake.callTool("demo_script_set", {
    video: id,
    scenes: [SCENE, { ...SCENE, id: "b", title: "B" }],
  });
  await s.ask("review", {
    id,
    scene: "pain",
    status: "noted",
    notes: ["Too slow", "Cut the intro"],
  });
  const notes = await s.fake.callTool("demo_notes", { video: id });
  expect(notes).toContain("pain (The pain): noted\n  - Too slow\n  - Cut the intro");
  expect(notes).toContain("b (B): pending");
});

test("a prifly without api.state says so instead of crashing the host", async () => {
  const s = studio({ noState: true });
  await expect(s.fake.callTool("demo_list", {})).rejects.toThrow("api.state");
});
