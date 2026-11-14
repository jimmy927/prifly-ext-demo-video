import { expect, test } from "bun:test";
import { SCENE, studio } from "./studio";

// The script's save and review rules (what demo_script_set and the review store rely on).

test("saving scenes is strict; review status and notes are saved", async () => {
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
    notes: ["Slower"],
  });
  expect(noted.scenes[0].review).toEqual({ status: "noted", notes: ["Slower"] });
  const approved = await s.ask("review", { id, scene: "pain", status: "approved" });
  expect(approved.scenes[0].review).toEqual({ status: "approved", notes: ["Slower"] });
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

test("an approved scene saved with other words starts over, even when its review comes back approved", async () => {
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
