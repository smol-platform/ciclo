import assert from "node:assert/strict";
import test from "node:test";

import {
  OnePasswordCliSecretProvider,
  OnePasswordConnectSecretProvider,
  OpenBaoCliSecretProvider,
  SecretProviderRegistry,
  secretRefHash,
  type SecretHttpFetcher,
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

test("1Password Connect provider resolves item fields without exposing values or refs", async () => {
  const beforeHost = process.env.OP_CONNECT_HOST;
  const beforeToken = process.env.OP_CONNECT_TOKEN;
  process.env.OP_CONNECT_TOKEN = "connect-token-fixture";
  delete process.env.OP_CONNECT_HOST;
  const calls: { url: string; authorization?: string }[] = [];
  const fetcher: SecretHttpFetcher = async (url, init) => {
    calls.push({ url, authorization: init.headers.Authorization });
    return {
      status: 200,
      ok: true,
      async text() {
        return JSON.stringify({
          fields: [
            { id: "username", label: "username", purpose: "USERNAME", value: "not-the-secret" },
            { id: "api-token-field", label: "api_token", type: "CONCEALED", value: "connect-secret-value" }
          ]
        });
      }
    };
  };
  try {
    const provider = new OnePasswordConnectSecretProvider({
      endpoint: "https://connect.example.test",
      fetcher
    });
    const result = await provider.resolve({
      providerId: "onepassword-connect",
      secretRef: "op-connect://vault-uuid/item-uuid",
      field: "api_token",
      loopId: "deploy-loop"
    });

    assert.equal(result.resolved, true);
    assert.equal(result.value, "connect-secret-value");
    assert.equal(result.field, "api_token");
    assert.deepEqual(calls, [
      {
        url: "https://connect.example.test/v1/vaults/vault-uuid/items/item-uuid",
        authorization: "Bearer connect-token-fixture"
      }
    ]);
    assert.ok(result.evidence.includes("secret.provider.onepassword_connect.request:get_item"));
    assert.ok(result.evidence.includes(`secret.ref_hash:${secretRefHash("op-connect://vault-uuid/item-uuid")}`));
    assert.doesNotMatch(JSON.stringify(result.evidence), /connect-secret-value/u);
    assert.doesNotMatch(JSON.stringify(result.evidence), /vault-uuid|item-uuid/u);
  } finally {
    if (beforeHost === undefined) delete process.env.OP_CONNECT_HOST;
    else process.env.OP_CONNECT_HOST = beforeHost;
    if (beforeToken === undefined) delete process.env.OP_CONNECT_TOKEN;
    else process.env.OP_CONNECT_TOKEN = beforeToken;
  }
});

test("1Password Connect provider supports default vault and field in ref", async () => {
  const beforeToken = process.env.CICLO_OP_CONNECT_TOKEN;
  process.env.CICLO_OP_CONNECT_TOKEN = "connect-token-fixture";
  const fetcher: SecretHttpFetcher = async () => ({
    status: 200,
    ok: true,
    async text() {
      return JSON.stringify({
        fields: [{ id: "password", label: "password", purpose: "PASSWORD", value: "default-vault-secret" }]
      });
    }
  });
  try {
    const provider = new OnePasswordConnectSecretProvider({
      endpoint: "https://connect.example.test/",
      tokenEnv: "CICLO_OP_CONNECT_TOKEN",
      defaultVaultId: "vault-default",
      fetcher
    });
    const result = await provider.resolve({
      providerId: "onepassword-connect",
      secretRef: "item-uuid/password"
    });

    assert.equal(result.resolved, true);
    assert.equal(result.value, "default-vault-secret");
    assert.equal(result.field, "password");
  } finally {
    if (beforeToken === undefined) delete process.env.CICLO_OP_CONNECT_TOKEN;
    else process.env.CICLO_OP_CONNECT_TOKEN = beforeToken;
  }
});

test("1Password Connect provider refuses broad reads and missing runtime token", async () => {
  const beforeToken = process.env.OP_CONNECT_TOKEN;
  delete process.env.OP_CONNECT_TOKEN;
  try {
    const provider = new OnePasswordConnectSecretProvider({
      endpoint: "https://connect.example.test",
      fetcher: async () => {
        throw new Error("fetch should not be called");
      }
    });
    const broad = await provider.resolve({
      providerId: "onepassword-connect",
      secretRef: "op-connect://vault-uuid/item-uuid"
    });
    assert.equal(broad.resolved, false);
    assert.match(broad.reason, /requires an explicit field/u);

    const missingToken = await provider.resolve({
      providerId: "onepassword-connect",
      secretRef: "op-connect://vault-uuid/item-uuid/api_token"
    });
    assert.equal(missingToken.resolved, false);
    assert.match(missingToken.reason, /token is not configured/u);
  } finally {
    if (beforeToken === undefined) delete process.env.OP_CONNECT_TOKEN;
    else process.env.OP_CONNECT_TOKEN = beforeToken;
  }
});
