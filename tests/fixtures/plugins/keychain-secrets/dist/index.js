export function activate(api) {
  api.secretProviders.register({
    id: "keychain-test",
    kind: "keychain",
    name: "Keychain Test Provider",
    supportsFields: true,
    resolve(input) {
      return {
        resolved: true,
        providerId: "keychain-test",
        providerKind: "keychain",
        secretRefHash: "fixture-hash",
        field: input.field,
        value: "fixture-secret",
        reason: "fixture provider resolved the secret",
        evidence: [
          "secret.provider:keychain-test",
          "secret.kind:keychain",
          "secret.ref_hash:fixture-hash",
          "secret.resolved:true"
        ]
      };
    }
  });
}
