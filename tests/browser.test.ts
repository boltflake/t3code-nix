// The preview browser record, read from t3code's PreviewBrowser.ts.
// Run: node --test tests/*.test.ts
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { browserPin, parseBrowser, sourceUrl } from "../scripts/lib/browser.ts";
import { clearFetched, sri } from "../scripts/lib/util.ts";

// Shaped like the real file (t3code v0.1.9), trimmed.
const hex = (c: string) => c.repeat(64);
const file = (version = "157.0.8103.38", extra = "") => `
const VERSION = "${version}";
const ARCHIVES = {
  linux64: {
    bytes: 128_168_542,
    sha256: "${hex("a")}",
  },
  "linux-arm64": {
    bytes: 128_171_139,
    sha256: "${hex("b")}",
  },
  "mac-arm64": {
    bytes: 104_773_711,
    sha256: "${hex("c")}",
  },${extra}
} as const;
        url: \`https://storage.googleapis.com/chrome-for-testing-public/\${VERSION}/\${chrome}/chrome-headless-shell-\${chrome}.zip\`,
`;
const SRC = sourceUrl("pingdotgg/t3code", "c".repeat(40));

test("browser: one complete record, from upstream's own hashes", () => {
  assert.deepEqual(parseBrowser(file(), SRC), {
    version: "157.0.8103.38",
    source: SRC,
    assets: {
      "x86_64-linux": { url: "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/linux64/chrome-headless-shell-linux64.zip", hash: sri("sha256", hex("a")) },
      "aarch64-linux": { url: "https://storage.googleapis.com/chrome-for-testing-public/157.0.8103.38/linux-arm64/chrome-headless-shell-linux-arm64.zip", hash: sri("sha256", hex("b")) },
    },
  });
});

test("browser: VERSION exported (t3code since v0.1.11-nightly.20261118.4877) reads the same", () => {
  const exported = file().replace('\nconst VERSION = ', '\nexport const VERSION = ');
  assert.ok(exported.includes("export const VERSION"));
  assert.deepEqual(parseBrowser(exported, SRC), parseBrowser(file(), SRC));
  // Still exactly one, exported or not.
  assert.throws(() => parseBrowser(exported + 'const VERSION = "158.0.0.1";\n', SRC), /expected one VERSION, found 2/);
  // A whole line only: an indented or commented-out one isn't another.
  assert.deepEqual(parseBrowser(exported + '  // const VERSION = "158.0.0.1";\n  const VERSION = "158.0.0.2";\n', SRC).version, "157.0.8103.38");
});

test("browser: a changed layout fails instead of mixing entries", () => {
  assert.throws(() => parseBrowser(file("157.0"), SRC), /expected one VERSION/);
  assert.throws(() => parseBrowser(file() + 'const VERSION = "158.0.0.1";\n', SRC), /expected one VERSION/);
  assert.throws(() => parseBrowser(file().replace("chrome-headless-shell-${chrome}.zip", "x.zip"), SRC), /archive URL changed/);
  assert.throws(() => parseBrowser(file().replace(`"${hex("b")}"`, '"short"'), SRC), /one linux-arm64 archive, found 0/);
  const twice = file(undefined, `\n  linux64: {\n    bytes: 1,\n    sha256: "${hex("d")}",\n  },`);
  assert.throws(() => parseBrowser(twice, SRC), /one linux64 archive, found 2/);
});

const realFetch = globalThis.fetch;
let fetched: string[] = [];
beforeEach(() => {
  fetched = [];
  clearFetched();
  globalThis.fetch = (async (url: string) => (fetched.push(String(url)), new Response(file()))) as typeof fetch;
});
afterEach(() => { globalThis.fetch = realFetch; });

test("browser: kept without a request while the commit is unchanged", async () => {
  const first = await browserPin("pingdotgg/t3code", "c".repeat(40));
  assert.deepEqual(fetched, [SRC]);
  assert.equal(await browserPin("pingdotgg/t3code", "c".repeat(40), first), first);
  assert.equal(fetched.length, 1);
  await browserPin("pingdotgg/t3code", "d".repeat(40), first);
  assert.equal(fetched.length, 2);
});
