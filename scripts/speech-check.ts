// Dictation, in the Nix sandbox (lib/checks.nix): t3code's speech worker
// starts, and the packaged transcribe-cpp transcribes speech on the CPU.
//
//   node speech-check.ts worker T3_EXECUTABLE
//     Starts upstream's own worker the way the server does (`t3
//     __speech-worker discover` with an IPC channel, as speechWorkerArgs
//     does in a Node single-file executable) and waits for its device list:
//     an array, empty in the sandbox, which has no GPU.
//
//   node speech-check.ts transcribe TRANSCRIBE_CPP_DIR MODEL CLIP.wav
//     Loads the packaged transcribe-cpp with this Node (as the worker does:
//     require on its dist/index.js), checks that the CPU backend is listed,
//     and transcribes the clip (a 16-bit mono WAV, here from espeak-ng) with
//     the model. The text must contain "hello", "world" and "testing"; whole
//     sentences aren't compared, since a small model mishears some words.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

export const WORDS = ["hello", "world", "testing"];
const WORKER_MS = 30_000;

/** A 16-bit PCM mono WAV as 16 kHz float32 samples (linear resampling). */
export function wavTo16k(buf: Buffer): Float32Array {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") throw new Error("not a WAV file");
  let off = 12, rate = 0, channels = 0, bits = 0;
  let data: Buffer | null = null;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4), size = buf.readUInt32LE(off + 4);
    if (id === "fmt ") {
      channels = buf.readUInt16LE(off + 10);
      rate = buf.readUInt32LE(off + 12);
      bits = buf.readUInt16LE(off + 22);
    }
    // espeak-ng writes 0x7fffffff when it streams: the rest of the file.
    if (id === "data") { data = buf.subarray(off + 8, Math.min(buf.length, off + 8 + size)); break; }
    off += 8 + size + (size & 1);
  }
  if (!data || !rate || channels !== 1 || bits !== 16) throw new Error(`expected 16-bit mono PCM, got ${channels} channel(s), ${bits} bits`);
  const src = new Float32Array(Math.floor(data.length / 2));
  for (let i = 0; i < src.length; i++) src[i] = data.readInt16LE(i * 2) / 32768;
  const out = new Float32Array(Math.floor((src.length * 16000) / rate));
  for (let i = 0; i < out.length; i++) {
    const x = (i * rate) / 16000, j = Math.floor(x), f = x - j;
    out[i] = (src[j] ?? 0) * (1 - f) + (src[j + 1] ?? 0) * f;
  }
  return out;
}

export const missingWords = (text: string) => WORDS.filter((w) => !text.toLowerCase().includes(w));

async function worker(t3: string): Promise<void> {
  const child = spawn(t3, ["__speech-worker", "discover"], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const devices = await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error(`no device list within ${WORKER_MS / 1000} s`)); }, WORKER_MS);
    child.on("message", (m) => { clearTimeout(timer); resolve(m); });
    child.on("error", (e) => { clearTimeout(timer); reject(e); });
    child.on("exit", (code) => { clearTimeout(timer); reject(new Error(`the worker exited (${code}) without a device list`)); });
  });
  child.kill("SIGKILL");
  if (!Array.isArray(devices)) throw new Error(`the worker answered ${JSON.stringify(devices)}, not a device list`);
  console.log(`speech worker: device list ${JSON.stringify(devices)}`);
}

async function transcribe(pkgDir: string, model: string, clip: string): Promise<void> {
  const speech = createRequire(join(pkgDir, "package.json"))(join(pkgDir, "dist/index.js"));
  const backends: any[] = speech.getAvailableBackends();
  console.log(`backends: ${backends.map((b) => `${b.kind}/${b.deviceType}`).join(", ")}`);
  if (!backends.some((b) => b.kind === "cpu")) throw new Error("transcribe-cpp lists no CPU backend");
  const m = await speech.TranscribeModel.load(model, { backend: "cpu" });
  try {
    const { text } = await m.transcribe(wavTo16k(readFileSync(clip)), {});
    console.log(`transcript: ${JSON.stringify(text)}`);
    const missing = missingWords(text);
    if (missing.length) throw new Error(`the transcript lacks ${missing.join(", ")}`);
  } finally {
    m.dispose?.();
  }
}

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  try {
    if (mode === "worker" && args.length === 1) await worker(args[0]);
    else if (mode === "transcribe" && args.length === 3) await transcribe(args[0], args[1], args[2]);
    else throw new Error("usage: speech-check.ts worker T3 | transcribe TRANSCRIBE_CPP_DIR MODEL CLIP.wav");
  } catch (e: any) {
    console.error(`speech-check: ${e.message}`);
    process.exit(1);
  }
}
