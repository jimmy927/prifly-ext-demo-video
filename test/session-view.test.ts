import { expect, test } from "bun:test";
import { UPDATE_PRIFLY } from "../src/session-views";
import { SCENE, studio } from "./studio";

type Shown = { session: string; view: string; params: Record<string, string> };

/** A prifly with `showSessionView`, which writes down what it was asked. */
function withViews(s: ReturnType<typeof studio>): Shown[] {
  const shown: Shown[] = [];
  Object.assign(s.fake.api, {
    showSessionView: (session: string, view: string, params: Record<string, string>) =>
      void shown.push({ session, view, params }),
  });
  return shown;
}

async function newVideo(s: ReturnType<typeof studio>, title = "Ashby") {
  return (await s.ask("videos", { title, product: "odi" })).created.id as string;
}

const idOf = (answer: string) => /Video (\S+) made/.exec(answer)?.[1] as string;

test("demo_open shows the timeline of the video in the calling session", async () => {
  const s = studio();
  const shown = withViews(s);
  const id = await newVideo(s);
  const answer = await s.fake.callTool("demo_open", { video: id }, null, "session-a");
  expect(shown).toEqual([{ session: "session-a", view: "timeline", params: { video: id } }]);
  expect(answer).toContain(`The timeline of ${id} is open beside the chat`);
  // Asked again it shows again, so another video replaces the first.
  await s.fake.callTool("demo_open", { video: id }, null, "session-a");
  expect(shown).toHaveLength(2);
});

test("demo_open on a prifly without showSessionView says to update it", async () => {
  const s = studio();
  const id = await newVideo(s);
  expect(await s.fake.callTool("demo_open", { video: id })).toContain(UPDATE_PRIFLY);
});

test("demo_open refuses a video that does not exist, and shows nothing", async () => {
  const s = studio();
  const shown = withViews(s);
  await expect(s.fake.callTool("demo_open", { video: "nope" })).rejects.toThrow("No video nope");
  expect(shown).toEqual([]);
});

test("the tools that change a video open the timeline once per session, not on every call", async () => {
  const s = studio();
  const shown = withViews(s);
  const made = await s.fake.callTool("demo_create", { title: "Ashby", product: "odi" }, null, "a");
  const id = idOf(made);
  expect(made).toContain("is open beside the chat");
  expect(shown).toEqual([{ session: "a", view: "timeline", params: { video: id } }]);
  const saved = await s.fake.callTool("demo_script_set", { video: id, scenes: [SCENE] }, null, "a");
  expect(saved).not.toContain("beside the chat");
  await s.fake.callTool("demo_script_set", { video: id, scenes: [SCENE] }, null, "b");
  expect(shown.map((each) => each.session)).toEqual(["a", "b"]);
  // An explicit demo_open in a session that has one shows it again.
  await s.fake.callTool("demo_open", { video: id }, null, "a");
  expect(shown).toHaveLength(3);
});

test("without showSessionView the tools still work and say so once per session", async () => {
  const s = studio();
  const made = await s.fake.callTool("demo_create", { title: "Ashby", product: "odi" }, null, "a");
  expect(made).toContain(UPDATE_PRIFLY);
  const saved = await s.fake.callTool(
    "demo_script_set",
    { video: idOf(made), scenes: [SCENE] },
    null,
    "a",
  );
  expect(saved).not.toContain(UPDATE_PRIFLY);
  expect(saved).toContain("1 scene");
});

test("a showSessionView that throws is told in the answer, and the work is done", async () => {
  const s = studio();
  Object.assign(s.fake.api, {
    showSessionView: () => {
      throw new Error("no such view");
    },
  });
  const made = await s.fake.callTool("demo_create", { title: "Ashby", product: "odi" });
  expect(made).toContain("Video ashby made");
  expect(made).toContain("could not be opened beside the chat: no such view");
});
