// Dictation: the speech model record (scripts/lib/speech.ts) and the
// sandbox check's helpers (scripts/speech-check.ts).
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { catalogUrl, MODEL_ID, parseSpeech, speechPin } from "../scripts/lib/speech.ts";
import { missingWords, wavTo16k } from "../scripts/speech-check.ts";
import { clearFetched, sameBytes, type Pin, type SpeechPin } from "../scripts/lib/util.ts";

const hex = (c: string, n = 64) => c.repeat(n);
const entry = (over: Record<string, unknown> = {}) => ({
  id: MODEL_ID, revision: hex("b", 40), name: "Whisper Tiny English", filename: "whisper-tiny.en-Q8_0.gguf",
  size: 45904544, sha256: hex("e"), license: "apache-2.0", ...over,
});
const catalog = (models: unknown[]) => JSON.stringify({ engineVersion: "0.4.1", models: [{ id: "other/model-gguf", revision: hex("a", 40), filename: "x.gguf", size: 1, sha256: hex("a") }, ...models] });
const SRC = catalogUrl("pingdotgg/t3code", "c".repeat(40));

test("speech: the whisper-tiny.en record, with its Hugging Face URL", () => {
  assert.deepEqual(parseSpeech(catalog([entry()]), SRC), {
    id: MODEL_ID, revision: hex("b", 40), filename: "whisper-tiny.en-Q8_0.gguf", size: 45904544, sha256: hex("e"),
    url: `https://huggingface.co/${MODEL_ID}/resolve/${hex("b", 40)}/whisper-tiny.en-Q8_0.gguf`, source: SRC,
  });
  assert.equal(SRC, `https://raw.githubusercontent.com/pingdotgg/t3code/${"c".repeat(40)}/apps/server/src/speech/catalog.json`);
});

test("speech: only a catalog without the model is null; a broken one fails", () => {
  assert.equal(parseSpeech(catalog([]), SRC), null);
  assert.throws(() => parseSpeech("{not json", SRC), /not JSON/);
  assert.throws(() => parseSpeech(JSON.stringify({ models: {} }), SRC), /no models list/);
  assert.throws(() => parseSpeech(catalog([entry(), entry()]), SRC), /2 entries/);
  for (const bad of [{ revision: "main" }, { filename: "../x.gguf" }, { filename: "x.bin" }, { sha256: "short" }, { size: 0 }, { size: "45" }]) {
    assert.throws(() => parseSpeech(catalog([entry(bad)]), SRC), /unexpected shape/, JSON.stringify(bad));
  }
});

const realFetch = globalThis.fetch;
let fetched: string[] = [];
let body = catalog([entry()]);
let status = 200;
beforeEach(() => {
  fetched = [];
  body = catalog([entry()]);
  status = 200;
  clearFetched();
  globalThis.fetch = (async (url: string) => (fetched.push(String(url)), new Response(body, { status }))) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test("speech: reused without a request while the commit is unchanged", async () => {
  const first = await speechPin("pingdotgg/t3code", "c".repeat(40));
  assert.deepEqual([first.note, first.pin.fromCatalog, first.pin.checked, first.pin.source], [null, true, SRC, SRC]);
  assert.equal((await speechPin("pingdotgg/t3code", "c".repeat(40), first.pin)).pin, first.pin);
  assert.equal(fetched.length, 1);
  await speechPin("pingdotgg/t3code", "d".repeat(40), first.pin);
  assert.equal(fetched.length, 2);
});

test("speech: a release without the model keeps the earlier record, with a note every run", async () => {
  const first = (await speechPin("pingdotgg/t3code", "c".repeat(40))).pin;
  body = catalog([]);
  const kept = await speechPin("pingdotgg/t3code", "d".repeat(40), first);
  const D = catalogUrl("pingdotgg/t3code", "d".repeat(40));
  assert.deepEqual([kept.pin.fromCatalog, kept.pin.checked, kept.pin.source, kept.pin.sha256], [false, D, SRC, first.sha256]);
  assert.match(kept.note!, /isn't in this release's speech catalog/);
  const again = await speechPin("pingdotgg/t3code", "d".repeat(40), kept.pin);
  assert.deepEqual([again.pin, fetched.length], [kept.pin, 2], "the same commit: no request");
  assert.match(again.note!, /isn't in this release's speech catalog/, "still said");
  // The model comes back in a later release.
  body = catalog([entry({ sha256: hex("f") })]);
  const back = await speechPin("pingdotgg/t3code", "e".repeat(40), again.pin);
  assert.deepEqual([back.pin.fromCatalog, back.pin.sha256, back.note], [true, hex("f"), null]);
});

test("speech: no earlier record to keep, or a catalog that can't be read, fails", async () => {
  body = catalog([]);
  await assert.rejects(speechPin("pingdotgg/t3code", "c".repeat(40)), /no earlier record to keep/);
  body = catalog([entry({ size: -1 })]);
  const prev = { ...parseSpeech(catalog([entry()]), SRC)!, checked: SRC, fromCatalog: true };
  await assert.rejects(speechPin("pingdotgg/t3code", "d".repeat(40), prev), /unexpected shape/, "broken: never a fallback");
  status = 404;
  await assert.rejects(speechPin("pingdotgg/t3code", "e".repeat(40), prev), /HTTP 404/);
});

test("speech: a different model at the same release is new bytes; adding the record isn't", () => {
  const sp = (sha256: string): SpeechPin => ({ ...parseSpeech(catalog([entry({ sha256 })]), SRC)!, checked: SRC, fromCatalog: true });
  const old: Pin = { name: "t3", version: "0.1.9", assets: { "x86_64-linux": { url: "u", hash: "sha256-A" } } };
  assert.equal(sameBytes(old, { ...old, speech: sp(hex("1")) }), true);
  assert.equal(sameBytes({ ...old, speech: sp(hex("1")) }, { ...old, speech: sp(hex("1")) }), true);
  assert.equal(sameBytes({ ...old, speech: sp(hex("1")) }, { ...old, speech: sp(hex("2")) }), false);
  assert.equal(sameBytes({ ...old, speech: sp(hex("1")) }, old), false, "dropping it isn't details only either");
});

/** A 16-bit mono WAV of these samples at this rate. */
function wav(samples: number[], rate: number, size = samples.length * 2): Buffer {
  const b = Buffer.alloc(44 + samples.length * 2);
  b.write("RIFF", 0); b.writeUInt32LE(36 + samples.length * 2, 4); b.write("WAVE", 8);
  b.write("fmt ", 12); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34);
  b.write("data", 36); b.writeUInt32LE(size, 40);
  samples.forEach((s, i) => b.writeInt16LE(s, 44 + i * 2));
  return b;
}

test("speech-check: WAV to 16 kHz float32, and the words it looks for", () => {
  const same = wavTo16k(wav([0, 16384, -16384, 32767], 16000));
  assert.deepEqual([...same].map((x) => Math.round(x * 1000) / 1000), [0, 0.5, -0.5, 1]);
  assert.equal(wavTo16k(wav(Array(22050).fill(0), 22050)).length, 16000, "one second stays one second");
  assert.equal(wavTo16k(wav([1, 2], 16000, 0x7fffffff)).length, 2, "espeak-ng's streaming size reads to the end");
  const stereo = wav([0, 0], 16000);
  stereo.writeUInt16LE(2, 22);
  assert.throws(() => wavTo16k(stereo), /16-bit mono/);
  assert.throws(() => wavTo16k(Buffer.from("not a wav file at all, no")), /not a WAV/);
  assert.deepEqual(missingWords("Hello World, testing 1-2-3."), []);
  assert.deepEqual(missingWords("The Low World"), ["hello", "testing"]);
});
