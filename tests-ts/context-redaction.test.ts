import assert from "node:assert/strict";
import test from "node:test";

import { redactContextMemory } from "../src/context-redaction.js";

test("redacts secrets tokens and private keys without exposing values in metadata", () => {
  const result = redactContextMemory({
    text: [
      "api_key=sk-live-123",
      "Authorization: Bearer abc.def.ghi",
      "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----"
    ].join("\n")
  });

  assert.equal(result.redacted, true);
  assert.doesNotMatch(result.text, /sk-live-123/);
  assert.doesNotMatch(result.text, /abc\.def\.ghi/);
  assert.doesNotMatch(result.text, /abc123/);
  assert.ok(result.metadata.some((item) => item.kind === "secret"));
  assert.ok(result.metadata.some((item) => item.kind === "token"));
  assert.ok(result.metadata.some((item) => item.kind === "private_key"));
  assert.doesNotMatch(JSON.stringify(result.metadata), /sk-live-123|abc\.def\.ghi|abc123/);
});

test("redacts raw transcript memory and fenced transcript blocks", () => {
  const direct = redactContextMemory({
    source: "transcript",
    text: "$ export TOKEN=abc\nraw terminal output"
  });
  const fenced = redactContextMemory({
    text: "Recent transcript:\n```terminal\n$ export TOKEN=abc\nsecret output\n```"
  });

  assert.equal(direct.text, "[redacted raw transcript memory]");
  assert.doesNotMatch(fenced.text, /secret output/);
  assert.ok(direct.metadata.some((item) => item.kind === "raw_transcript"));
  assert.ok(fenced.metadata.some((item) => item.kind === "raw_transcript"));
});

test("redacts remote host and path details when configured", () => {
  const redacted = redactContextMemory({
    text: "remote host prod.example.com user deploy@10.0.0.8 path /srv/ciclo and /Users/zach/secrets"
  });
  const configuredOff = redactContextMemory({
    text: "remote host prod.example.com path /srv/ciclo",
    policy: { redactRemoteDetails: false }
  });

  assert.doesNotMatch(redacted.text, /prod\.example\.com|10\.0\.0\.8|\/srv\/ciclo|\/Users\/zach/);
  assert.ok(redacted.metadata.some((item) => item.kind === "remote_host"));
  assert.ok(redacted.metadata.some((item) => item.kind === "remote_path"));
  assert.match(configuredOff.text, /prod\.example\.com/);
  assert.match(configuredOff.text, /\/srv\/ciclo/);
});
