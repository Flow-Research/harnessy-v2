# Test certificates of verified work

`harnessy attest` turns an accepted WorkStream contribution into a signed
certificate that says "Flow verified this work". Anyone can check the
signature without access to WorkStream. The certificates it makes today are
**test certificates**: a test key on one machine signs them, and they must not
be shared outside Flow or relied on as Flow's word.

## Commands

```sh
harnessy attest key init
harnessy attest run --project <project-uuid> --workstream-cli "ws-agent"
harnessy attest verify ~/.local/state/harnessy/attest/<project-uuid>/<contribution-uuid>.json
```

- `key init` creates a random secp256k1 key at
  `~/.local/state/harnessy/attest/test-signer.key` (folder mode 0700, file mode
  0600). The file is labelled TEST. The command prints only the signer address,
  and it refuses to replace an existing key.
- `run` reads `workstream contributions --project <id> -o json` and writes one
  certificate per contribution to `<out>/<contribution-id>.json`. The default
  `<out>` is `~/.local/state/harnessy/attest/<project-id>/`. A certificate is
  deterministic: the same contribution and key always give the same bytes. So
  a re-run skips identical files, and it reports a different existing file as a
  conflict (exit code 1) without replacing it. If any contribution record is
  malformed, the run writes nothing.
- `verify` recomputes the attestation hash and UID, recovers the signer, and
  checks the schema, the test domain and the expected signer. By default the
  expected signer is the local test key; `--attester <address>` overrides it.
  It prints `VALID` or `INVALID: <reason>` and exits 1 when invalid.

All three accept `--json`.

## Format

Each file is a small Harnessy wrapper around a standard Ethereum Attestation
Service (EAS) off-chain attestation, version 2 (the version with a salt):

- `format`, `test: true` and a `notice` mark it as a Harnessy test certificate.
- `schema` names `workstream.contribution.v1` and gives its EAS definition and
  UID (no resolver, revocable):
  `string contributionId,string projectId,string taskId,string contributorId,string contributionType,bytes32 artifactHash,uint64 acceptedAt,string policyVersionId,string awardUnit,uint256 awardQuantity`.
- `contribution` is a readable copy of the signed fields. `verify` rejects a
  file whose copy differs from the signed data.
- `eas` is the EAS shareable package, `{ sig, signer }`, as the EAS SDK and
  easscan use it.

The EIP-712 domain is the EAS contract on Base Sepolia (chain 84532,
`0x4200000000000000000000000000000000000021`, contract version
`1.4.1-beta.3`), so any EAS tool sees a testnet attestation. The attestation
`time` is the acceptance time, and the salt is derived from the contribution
ID; together these make certificates reproducible.

The contributor appears only as a WorkStream ID. Names, emails, task titles and
submission IDs are not included. `artifactHash` is the sha256 of the submitted
proof. `awardUnit` and `awardQuantity` are the project points awarded (for
example `FLOW` and `10`), or `""` and `0` when none were. Money awards are not
part of this schema. A completed review without its own final acceptance uses
its record time as `acceptedAt`.

## Compatibility evidence

`packages/harnessy-core/test/fixtures/attest/eas-sdk-vectors.json` holds the
output of the official `@ethereum-attestation-service/eas-sdk` 2.10.0 (with
ethers 6.17.0) for fixed inputs and a fixed public test key. The script that
produced it, `generate-vectors.mjs`, sits beside it. Harnessy's tests check
that its schema UID, encoded data, EIP-712 digest, attestation UID and RFC 6979
signature match those vectors byte for byte. Harnessy itself depends only on
`@noble/curves` and `@noble/hashes`.

## Production signing is a later decision

Who holds Flow's real signing key is decision 15. The agreed path is a test key
on Julian's Mac for test certificates now, and a multi-signer Flow wallet (a
Safe) before any certificate is shared outside Flow. Production certificates
will need a different signer and domain (Base mainnet), so they will not verify
as test certificates. Nothing is recorded on-chain today. The same schema and
signed data can later be attested on Base; that creates a new on-chain
attestation with its own UID.
