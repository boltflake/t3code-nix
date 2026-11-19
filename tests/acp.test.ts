// The ACP runtimes check's reading of t3code's agent status
// (scripts/acp-check.ts).
// Run: node --test tests/*.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { verdict } from "../scripts/acp-check.ts";

test("acp-check: a missing runner, a runner from our PATH, and statuses still settling", () => {
  const missing = { status: "error", message: "ACP executable 'uv' is not available on this environment's PATH." };
  const tried = { status: "warning", message: "ACP Registry install command '/nix/store/x-uv/bin/uv' exited with code 2: offline" };
  assert.equal(verdict(missing, "uv", "-"), "ok");
  assert.equal(verdict(tried, "uv", "/nix/store/x-uv/bin/uv"), "ok");
  assert.match(verdict(tried, "uv", "-"), /expected no uv/);
  assert.match(verdict(missing, "uv", "/nix/store/x-uv/bin/uv"), /expected \/nix\/store\/x-uv/);
  assert.match(verdict({ status: "warning", message: "ACP Registry install command '/usr/bin/uv' exited" }, "uv", "/nix/store/x-uv/bin/uv"), /expected/,
    "somebody else's uv isn't ours");
  assert.equal(verdict(null, "uv", "-"), "pending");
  assert.equal(verdict({ status: "warning", message: "Checking ACP Registry agent…" }, "uv", "-"), "pending");
  assert.equal(verdict({ installed: false }, "uv", "-"), "pending");
});
