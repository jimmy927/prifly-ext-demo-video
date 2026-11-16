/**
 * What a piece's samples say: the statistics of the 16-bit and 24-bit PCM WAVs
 * that `demo_voice_reference` ranks by (see `voice-reference.ts`).
 */

/** What the signal says about a piece. */
export type Signal = {
  /** Signal-to-noise: the 90th percentile 20 ms frame level minus the 10th, in dB. */
  snr: number;
  /** The 90th percentile frame level in dB (16-bit scale). */
  speech: number;
  /** The share of samples with |s| >= 32000, 0 to 1. */
  clipped: number;
};

export type Wav = {
  rate: number;
  bits: 16 | 24;
  channels: number;
  dataStart: number;
  dataBytes: number;
};

const FORMAT_PCM = 1;
const FORMAT_EXTENSIBLE = 0xfffe;

type Format = Omit<Wav, "dataStart" | "dataBytes">;

/** The `fmt ` chunk at `at`: null when it is not 16- or 24-bit PCM. */
function formatAt(view: DataView, at: number): Format | null {
  const tag = view.getUint16(at + 8, true);
  const bits = view.getUint16(at + 22, true);
  if (tag !== FORMAT_PCM && tag !== FORMAT_EXTENSIBLE) return null;
  if (bits !== 16 && bits !== 24) return null;
  return {
    rate: view.getUint32(at + 12, true),
    bits,
    channels: view.getUint16(at + 10, true),
  };
}

const isWave = (view: DataView) =>
  view.byteLength >= 12 &&
  view.getUint32(0, false) === 0x52494646 &&
  view.getUint32(8, false) === 0x57415645;

/** Where the samples of a `data` chunk are; a size of 0 (a stream) or past the file's end means the rest of the file. */
function dataAt(at: number, size: number, fileSize: number) {
  const dataStart = at + 8;
  const left = Math.max(0, fileSize - dataStart);
  return { dataStart, dataBytes: size === 0 || size > left ? left : size };
}

/** A PCM WAV's format and where its samples are, from its first bytes; null when it is not 16- or 24-bit PCM. */
export function parseWav(head: Uint8Array, fileSize: number): Wav | null {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (!isWave(view)) return null;
  let format: Format | null = null;
  let at = 12;
  while (at + 8 <= view.byteLength) {
    const id = view.getUint32(at, false);
    const size = view.getUint32(at + 4, true);
    if (id === 0x666d7420 && at + 24 <= view.byteLength) {
      format = formatAt(view, at);
      if (format === null) return null;
    } else if (id === 0x64617461 && format !== null) {
      return { ...format, ...dataAt(at, size, fileSize) };
    }
    at += 8 + size + (size % 2);
  }
  return null;
}

/** The length of the samples in seconds. */
export const lengthOf = (wav: Wav) => wav.dataBytes / (wav.bits / 8) / wav.channels / wav.rate;

/**
 * SNR, speech level and clipped share of mono PCM, the way the liked reference
 * was picked: RMS over 20 ms frames (every 4th sample of a frame), floor = the
 * 10th percentile frame in dB, speech = the 90th, snr = speech - floor;
 * clipped = the share of every 8th sample at or past 32000 on the 16-bit scale.
 */
export function signalOf(file: Uint8Array, wav: Wav): Signal | null {
  const buf = Buffer.from(file.buffer, file.byteOffset, file.byteLength);
  const step = wav.bits / 8;
  // A 24-bit sample at 16-bit scale is its top two bytes (the lowest is dropped).
  const skip = wav.bits === 24 ? 1 : 0;
  const count = Math.floor(wav.dataBytes / step);
  const at = (k: number) => buf.readInt16LE(wav.dataStart + k * step + skip);
  const frame = Math.floor(wav.rate / 50);
  const levels: number[] = [];
  for (let i = 0; i < count - frame; i += frame) {
    let sum = 0;
    let n = 0;
    for (let j = i; j < i + frame; j += 4) {
      const s = at(j);
      sum += s * s;
      n += 1;
    }
    levels.push(Math.sqrt(sum / n) + 1e-9);
  }
  if (levels.length === 0) return null;
  levels.sort((a, b) => a - b);
  const db = (level: number | undefined) => 20 * Math.log10(level ?? 1e-9);
  const floor = db(levels[Math.floor(levels.length / 10)]);
  const speech = db(levels[Math.floor(levels.length * 0.9)]);
  let clipped = 0;
  let looked = 0;
  for (let k = 0; k < count; k += 8) {
    looked += 1;
    if (Math.abs(at(k)) >= 32000) clipped += 1;
  }
  return { snr: speech - floor, speech, clipped: clipped / Math.max(1, looked) };
}
