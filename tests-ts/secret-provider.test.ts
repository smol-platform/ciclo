import assert from "node:assert/strict";
import test from "node:test";

import {
  OnePasswordCliSecretProvider,
  OpenBaoCliSecretProvider,
  SecretProviderRegistry,
  secretRefHash,
  type SecretCommandRunner
} from "../src/secret-provider.js";

test("OpenBao provider resolves an explicit field through bao kv get", () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const runner: SecretCommandRunner = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: "openbao-secret\n", stderr: "" };
  };
  const provider = new OpenBaoCliSecretProvider({ runner });
  const result = provider.resolve({
    providerId: "openbao",
    secretRef: "secret/data/ciclo/api",
    field: "token",
    loopId: "deploy-loop",
    beadId: "ciclo-1"
  });

  assert.equal(result.resolved, true);
  assert.equal(result.value, "openbao-secret");
  assert.deepEqual(calls, [
    {
      command: "bao",
      args: ["kv", "get", "-field=token", "secret/data/ciclo/api"]
    }
  ]);
  assert.ok(result.evidence.includes(`secret.ref_hash:${secretRefHash("secret/data/ciclo/api")}`));
  assert.ok(!JSON.stringify(result.evidence).includes("openbao-secret"));
  assert.ok(!JSON.stringify(result.evidence).includes("secret/data/ciclo/api"));
});

test("OpenBao provider refuses broad reads without a field", () => {
  const provider = new OpenBaoCliSecretProvider({
    runner: () => {
      throw new Error("runner should not be called without a field");
    }
  });
  const result = provider.resolve({
    providerId: "openbao",
    secretRef: "secret/data/ciclo/api"
  });

  assert.equal(result.resolved, false);
  assert.match(result.reason, /requires an explicit field/);
});

test("1Password provider resolves op references without exposing value in evidence", () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const runner: SecretCommandRunner = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: "op-secret\n", stderr: "" };
  };
  const provider = new OnePasswordCliSecretProvider({ runner });
  const result = provider.resolve({
    providerId: "onepassword",
    secretRef: "op://Ciclo/API/token"
  });

  assert.equal(result.resolved, true);
  assert.equal(result.value, "op-secret");
  assert.deepEqual(calls, [{ command: "op", args: ["read", "op://Ciclo/API/token"] }]);
  assert.ok(!JSON.stringify(result.evidence).includes("op-secret"));
  assert.ok(!JSON.stringify(result.evidence).includes("op://Ciclo/API/token"));
});

test("dry-run secret requests do not invoke provider commands", () => {
  const provider = new OnePasswordCliSecretProvider({
    runner: () => {
      throw new Error("runner should not be called in dry run");
    }
  });
  const registry = new SecretProviderRegistry([provider]);
  const result = registry.resolve({
    providerId: "onepassword",
    secretRef: "op://Ciclo/API/token",
    dryRun: true
  });

  return result.then((resolved) => {
    assert.equal(resolved.resolved, false);
    assert.match(resolved.reason, /dry run/);
    assert.equal(resolved.value, undefined);
  });
});
