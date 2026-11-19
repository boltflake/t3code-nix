// The speech model the dictation checks transcribe with (lib/checks.nix,
// speech-smoke): whisper-tiny.en, 45 MB, from t3code's own model catalog at
// the release's commit (apps/server/src/speech/catalog.json). The catalog is
// compiled into the CLI and app.asar, so speech-model-pin can check the
// release still lists exactly this file.
//
// A catalog without whisper-tiny.en doesn't block the release: the earlier
// record is kept, marked fromCatalog false (the drift check skips it), and a
// note says so in each run's summary until someone picks another test model
// by hand. A catalog that can't be read, or lists the model in an
// unexpected shape, is a failure (resolve-failed), never a fallback.
import { fail, Failed, getText, type SpeechPin } from "./util.ts";

const PATH = "apps/server/src/speech/catalog.json";
export const MODEL_ID = "handy-computer/whisper-tiny.en-gguf";

export const catalogUrl = (repo: string, commit: string) => `https://raw.githubusercontent.com/${repo}/${commit}/${PATH}`;

/** The model's record in a catalog, or null if the catalog doesn't list it. */
export function parseSpeech(text: string, source: string): Omit<SpeechPin, "checked" | "fromCatalog"> | null {
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch (e: any) {
    throw new Failed(`${source}: not JSON (${e.message})`);
  }
  if (!Array.isArray(doc?.models)) fail(`${source}: no models list`);
  const found = doc.models.filter((m: any) => m?.id === MODEL_ID);
  if (found.length === 0) return null;
  if (found.length > 1) fail(`${source}: ${found.length} entries for ${MODEL_ID}`);
  const m = found[0];
  const ok = typeof m.revision === "string" && /^[0-9a-f]{40}$/.test(m.revision)
    && typeof m.filename === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]*\.gguf$/.test(m.filename)
    && typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256)
    && Number.isSafeInteger(m.size) && m.size > 0;
  if (!ok) fail(`${source}: ${MODEL_ID}'s entry has an unexpected shape`);
  return {
    id: MODEL_ID, revision: m.revision, filename: m.filename, size: m.size, sha256: m.sha256,
    url: `https://huggingface.co/${MODEL_ID}/resolve/${m.revision}/${m.filename}`, source,
  };
}

const keptNote = (p: SpeechPin) =>
  `${MODEL_ID} isn't in this release's speech catalog; the dictation checks keep using ${p.filename} from ${p.source} (pick another test model by hand)`;

/** The speech record for a t3code release at `commit`, and a note for the
 * run's summary when an earlier one was kept. The previous record is reused
 * without a request while the commit is unchanged. */
export async function speechPin(repo: string, commit: string, previous?: SpeechPin): Promise<{ pin: SpeechPin; note: string | null }> {
  const checked = catalogUrl(repo, commit);
  if (previous?.checked === checked) return { pin: previous, note: previous.fromCatalog ? null : keptNote(previous) };
  const found = parseSpeech(await getText(checked), checked);
  if (found) return { pin: { ...found, checked, fromCatalog: true }, note: null };
  if (!previous) fail(`${checked}: no ${MODEL_ID}, and no earlier record to keep`);
  const pin = { ...previous, checked, fromCatalog: false };
  return { pin, note: keptNote(pin) };
}
