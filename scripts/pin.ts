// Write a pin by hand, to bootstrap a package. The updater (update.ts) does
// this automatically afterwards.
//
//   node scripts/pin.ts github NAME OWNER/REPO TAG SYSTEM=ASSET... [--license PATH]... [--prerelease] [--partial-sums]
//   node scripts/pin.ts vendor NAME [VERSION]
//
// ASSET may contain {version} (the tag without "v" or "rust-v"); SYSTEM is
// x86_64-linux or aarch64-linux, each at most once.
import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildGithubPin } from "./lib/pin-github.ts";
import { buildVendorPin, VENDORS } from "./lib/vendors.ts";
import { movedBack, T3CODE } from "./update.ts";
import { currentPin, Failed, settleReleased, SYSTEMS, VERSIONS, writeJson, type Pin } from "./lib/util.ts";

const usage = `usage:
  node scripts/pin.ts github NAME OWNER/REPO TAG SYSTEM=ASSET... [--license PATH]... [--prerelease] [--partial-sums]
  node scripts/pin.ts vendor NAME [VERSION]     (vendors: ${Object.keys(VENDORS).join(", ")})`;

async function main(argv: string[]): Promise<void> {
  // Every option is checked here, before anything is fetched.
  let parsed;
  try {
    parsed = parseArgs({ args: argv, strict: true, allowPositionals: true, options: {
      license: { type: "string", multiple: true }, prerelease: { type: "boolean" }, "partial-sums": { type: "boolean" },
    } });
  } catch (e: any) {
    throw new Failed(`${e.message}\n${usage}`);
  }
  const { values: flags, positionals: [kind, ...rest] } = parsed;
  let pin: Pin;
  if (kind === "github") {
    const [name, repo, tag, ...pairs] = rest;
    if (!name || !repo || !tag || pairs.length === 0) throw new Failed(usage);
    // Their pins also need the preview browser's record, which only the
    // updater adds.
    if (Object.hasOwn(T3CODE, name)) throw new Failed(`${name}: the updater writes this pin (node scripts/update.ts --write --only ${name})`);
    const wanted: Record<string, string> = {};
    for (const pair of pairs) {
      const at = pair.indexOf("=");
      const system = pair.slice(0, at);
      if (at < 0 || !(SYSTEMS as readonly string[]).includes(system)) {
        throw new Failed(`expected SYSTEM=ASSET with SYSTEM one of ${SYSTEMS.join(", ")}, got ${JSON.stringify(pair)}`);
      }
      if (system in wanted) throw new Failed(`${system} given twice`);
      wanted[system] = pair.slice(at + 1);
    }
    pin = await buildGithubPin(name, repo, tag, wanted, {
      licenses: flags.license,
      prerelease: flags.prerelease ?? false,
      partialSums: flags["partial-sums"] ?? false,
      previous: currentPin(name),
    });
  } else if (kind === "vendor" && rest.length >= 1 && rest.length <= 2 && Object.keys(flags).length === 0) {
    if (!(rest[0] in VENDORS)) throw new Failed(`unknown vendor ${rest[0]}\n${usage}`);
    pin = await buildVendorPin(rest[0], rest[1] ?? null, currentPin(rest[0]));
  } else {
    throw new Failed(usage);
  }
  // `released` as the updater keeps it (see settleReleased).
  const old = currentPin(pin.name);
  pin = settleReleased(pin, old, new Date(), movedBack(pin, old));
  writeJson(join(VERSIONS, `${pin.name}.json`), pin);
  console.log(`${pin.name} ${pin.version}: ${Object.keys(pin.assets).join(", ")}${pin.licenses ? `; licenses: ${Object.keys(pin.licenses).join(", ")}` : ""}`);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(`pin: ${e instanceof Failed ? e.message : e.stack ?? e}`);
  process.exit(1);
});
