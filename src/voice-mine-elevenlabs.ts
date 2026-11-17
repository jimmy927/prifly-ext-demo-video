/**
 * `voice: "mine-elevenlabs"`: the reader's own voice through ElevenLabs, for
 * a machine without a GPU. Once, `reference.wav` (from `demo_voice_reference`)
 * becomes an Instant Voice Clone (`POST /v1/voices/add`); its voice id is kept
 * in `<videos root>/_voice/clone.json` with the sha256 of the file, and a new
 * clone is made only when the file changed. Per scene, Edge reads the
 * narration and that MP3 goes through ElevenLabs' Voice Changer
 * (speech-to-speech, `POST /v1/voice-changer/{voice_id}`) into the clone: the
 * words, timing and delivery come from Edge's reading.
 *
 * The key is the extension's own secret `elevenLabsKey`, never the vault.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Language } from "./scenes";
import { EDGE_RATE, type Fetch, MINE_READING_VOICE } from "./voice";

const API = "https://api.elevenlabs.io";

/** The speech-to-speech model: the multilingual one, which ElevenLabs recommends for English too. */
export const STS_MODEL = "eleven_multilingual_sts_v2";

export const CLONE_NAME = "Demo studio – my voice";

const REFERENCE_FILE = "reference.wav";
const CLONE_FILE = "clone.json";

export const NO_KEY =
  "Mine (ElevenLabs) needs the ElevenLabs API key: set it in Settings > Extensions > Demo studio";
export const NO_REFERENCE =
  "Mine (ElevenLabs) needs your voice reference first: run demo_voice_reference to build reference.wav";

export type Clone = { voiceId: string; referenceSha256: string; name: string; createdAt: number };

export type CloneDeps = {
  fetch: Fetch;
  key: () => Promise<string | null>;
  /** `<videos root>/_voice`: holds `reference.wav` and `clone.json`. */
  voiceDir: string;
  now?: () => number;
};

/** ElevenLabs' error body is `{ detail: { status, message } }`, or a validation list. */
function reason(raw: string): { status: string; message: string } {
  try {
    const detail = (JSON.parse(raw) as { detail?: unknown }).detail;
    if (typeof detail === "string") return { status: "", message: detail };
    if (detail !== null && typeof detail === "object" && !Array.isArray(detail)) {
      const { status, message } = detail as { status?: unknown; message?: unknown };
      return {
        status: typeof status === "string" ? status : "",
        message: typeof message === "string" ? message : "",
      };
    }
  } catch {
    // Not JSON: the raw text is the message.
  }
  return { status: "", message: raw.slice(0, 200) };
}

/** One line for a refused ElevenLabs call, by status and `detail.status`. */
export async function elevenError(response: Response, what: string): Promise<Error> {
  const { status, message } = reason(await response.text());
  const code = response.status;
  const tail = message === "" ? "" : ` (${message})`;
  if (code === 429) {
    return new Error(`ElevenLabs is rate limiting ${what} (429): wait a minute and render again`);
  }
  if (status === "can_not_use_instant_voice_cloning") {
    return new Error(
      `Your ElevenLabs plan does not allow Instant Voice Cloning (${status}): upgrade the plan to use Mine (ElevenLabs)`,
    );
  }
  if (status === "quota_exceeded") {
    return new Error(`Your ElevenLabs credits are used up (${status}): ${what} was refused${tail}`);
  }
  if (code === 401 || code === 403) {
    return new Error(
      `ElevenLabs refused ${what} (${code}${status === "" ? "" : ` ${status}`})${tail}: check the API key and plan`,
    );
  }
  return new Error(`ElevenLabs answered ${code} to ${what}${tail}`);
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function readClone(voiceDir: string): Promise<Clone | null> {
  try {
    return JSON.parse(await readFile(join(voiceDir, CLONE_FILE), "utf8")) as Clone;
  } catch {
    return null;
  }
}

/** DELETE /v1/voices/{id}; a voice already gone (404) counts as deleted. */
async function deleteVoice(fetcher: Fetch, key: string, voiceId: string): Promise<void> {
  const response = await fetcher(`${API}/v1/voices/${encodeURIComponent(voiceId)}`, {
    method: "DELETE",
    headers: { "xi-api-key": key },
  });
  if (response.ok || response.status === 404) return;
  throw await elevenError(response, "deleting the voice clone");
}

async function requireKey(deps: CloneDeps): Promise<string> {
  const key = await deps.key();
  if (key === null || key === "") throw new Error(NO_KEY);
  return key;
}

/**
 * The clone of `reference.wav`: the kept one when the file is unchanged, else a
 * new one (the old one is deleted from ElevenLabs, best effort). `created` is
 * true when this call uploaded the reference.
 */
export async function ensureClone(
  deps: CloneDeps,
): Promise<{ voiceId: string; created: boolean; replaced: boolean }> {
  const key = await requireKey(deps);
  let reference: Uint8Array;
  try {
    reference = new Uint8Array(await readFile(join(deps.voiceDir, REFERENCE_FILE)));
  } catch {
    throw new Error(NO_REFERENCE);
  }
  const hash = sha256(reference);
  const kept = await readClone(deps.voiceDir);
  if (kept !== null && kept.referenceSha256 === hash) {
    return { voiceId: kept.voiceId, created: false, replaced: false };
  }
  const form = new FormData();
  form.append("name", CLONE_NAME);
  form.append("files", new File([reference], REFERENCE_FILE, { type: "audio/wav" }));
  const response = await deps.fetch(`${API}/v1/voices/add`, {
    method: "POST",
    headers: { "xi-api-key": key },
    body: form,
  });
  if (!response.ok) throw await elevenError(response, "making the voice clone");
  const body = (await response.json()) as { voice_id?: string };
  if (typeof body.voice_id !== "string" || body.voice_id === "") {
    throw new Error("ElevenLabs made the voice clone but gave no voice id");
  }
  const next: Clone = {
    voiceId: body.voice_id,
    referenceSha256: hash,
    name: CLONE_NAME,
    createdAt: (deps.now ?? Date.now)(),
  };
  await mkdir(deps.voiceDir, { recursive: true });
  const target = join(deps.voiceDir, CLONE_FILE);
  await writeFile(`${target}.tmp`, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  await rename(`${target}.tmp`, target);
  if (kept !== null) {
    try {
      await deleteVoice(deps.fetch, key, kept.voiceId);
    } catch {
      // The old clone only takes a slot; the new one works.
    }
  }
  return { voiceId: next.voiceId, created: true, replaced: kept !== null };
}

/** demo_voice_clone_delete: deletes the clone from ElevenLabs and forgets it; says what it did. */
export async function deleteClone(deps: CloneDeps): Promise<string> {
  const kept = await readClone(deps.voiceDir);
  if (kept === null) return "No voice clone is kept; nothing was deleted.";
  await deleteVoice(deps.fetch, await requireKey(deps), kept.voiceId);
  await rm(join(deps.voiceDir, CLONE_FILE), { force: true });
  return `Deleted the voice clone "${kept.name}" (voice id ${kept.voiceId}) from ElevenLabs and forgot it. The next Mine (ElevenLabs) render uploads reference.wav again.`;
}

/** The line demo_render adds the first time (and again after a changed reference) a clone is uploaded. */
export const uploadedLine = (voiceId: string, replaced: boolean) =>
  replaced
    ? `Uploaded your changed reference.wav to ElevenLabs as a new Instant Voice Clone (voice id ${voiceId}); the old clone was deleted.`
    : `Uploaded your reference.wav to ElevenLabs as an Instant Voice Clone (voice id ${voiceId}).`;

export type StsChoice = {
  engine: "elevenlabs-sts";
  /** The clone's voice id. */
  voice: string;
  model: string;
  /** The Edge voice that reads the narration first. */
  source: string;
  rate: string;
};

/** Edge reads `text`, then the Voice Changer puts the reading into the clone's voice: an MP3. */
export async function stsSynth(
  fetcher: Fetch,
  key: string,
  edge: (text: string, voice: string, rate: string) => Promise<Uint8Array>,
  text: string,
  choice: StsChoice,
): Promise<Uint8Array> {
  const reading = await edge(text, choice.source, choice.rate);
  const form = new FormData();
  form.append("audio", new File([reading], "edge.mp3", { type: "audio/mpeg" }));
  form.append("model_id", choice.model);
  const response = await fetcher(
    `${API}/v1/voice-changer/${encodeURIComponent(choice.voice)}?output_format=mp3_44100_128`,
    { method: "POST", headers: { "xi-api-key": key, accept: "audio/mpeg" }, body: form },
  );
  if (!response.ok) throw await elevenError(response, "the voice change");
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * The voice of one language for Mine (ElevenLabs): Edge reads English with `MINE_READING_VOICE`
 * (whatever draft voice is set), then the clone. Another language has no English reading voice,
 * so it keeps its configured Edge voice. The source voice is part of the cache key.
 */
export function mineChoice(
  settings: { edge: Readonly<Record<Language, string>> },
  language: Language,
  cloneVoiceId: string,
): StsChoice {
  return {
    engine: "elevenlabs-sts",
    voice: cloneVoiceId,
    model: STS_MODEL,
    source: language === "en" ? MINE_READING_VOICE : settings.edge[language],
    rate: EDGE_RATE,
  };
}
