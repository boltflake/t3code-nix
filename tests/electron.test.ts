// The bundled Electron version read for the t3code pins (scripts/lib/electron.ts).
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { electronPin, PATH, parseElectron } from "../scripts/lib/electron.ts";
import { clearFetched, timing } from "../scripts/lib/util.ts";

const SRC = "https://raw.githubusercontent.com/pingdotgg/t3code/abc/apps/desktop/package.json";

test("the exact version from dependencies or devDependencies", () => {
  assert.deepEqual(parseElectron(JSON.stringify({ dependencies: { electron: "44.10.1" } }), SRC), { version: "44.10.1", note: null });
  assert.deepEqual(parseElectron(JSON.stringify({ devDependencies: { electron: "45.0.2" } }), SRC), { version: "45.0.2", note: null });
  assert.equal(PATH, "apps/desktop/package.json");
});

test("anything but a plain X.Y.Z is unknown, with a note, never a failure", () => {
  for (const raw of ["45.0.0-beta.2", "^44.10.1", "catalog:", 44]) {
    const r = parseElectron(JSON.stringify({ dependencies: { electron: raw } }), SRC);
    assert.equal(r.version, null);
    assert.match(r.note!, /not a plain X\.Y\.Z; the bundled Electron version is unknown, so auto uses bundled Electron$/);
  }
  assert.match(parseElectron("{}", SRC).note!, /no electron dependency/);
  assert.match(parseElectron("not json", SRC).note!, /isn't JSON/);
});

test("electronPin reads the release commit's file; a missing one is unknown, other errors fail", async () => {
  const real = { fetch: globalThis.fetch, sleep: timing.sleep };
  timing.sleep = async () => {};
  try {
    const asked: string[] = [];
    globalThis.fetch = (async (url: string) => {
      asked.push(String(url));
      return Response.json({ dependencies: { electron: "44.10.1" } });
    }) as typeof fetch;
    clearFetched();
    assert.deepEqual(await electronPin("pingdotgg/t3code", "c".repeat(40)), { version: "44.10.1", note: null });
    assert.deepEqual(asked, [`https://raw.githubusercontent.com/pingdotgg/t3code/${"c".repeat(40)}/apps/desktop/package.json`]);
    globalThis.fetch = (async () => new Response("no", { status: 404 })) as typeof fetch;
    clearFetched();
    const gone = await electronPin("pingdotgg/t3code", "d".repeat(40));
    assert.equal(gone.version, null);
    assert.match(gone.note!, /is missing/);
    globalThis.fetch = (async () => new Response("down", { status: 503 })) as typeof fetch;
    clearFetched();
    await assert.rejects(electronPin("pingdotgg/t3code", "e".repeat(40)), /HTTP 503/);
  } finally {
    globalThis.fetch = real.fetch;
    timing.sleep = real.sleep;
    clearFetched();
  }
});
