// Produces eas-sdk-vectors.json with the official EAS SDK. Not run in CI and not
// a Harnessy dependency: run it in an empty scratch directory, never in this repo.
//
//   mkdir /tmp/eas-vectors && cd /tmp/eas-vectors
//   echo '{"type":"module","private":true}' > package.json
//   npm install --ignore-scripts --save-exact @ethereum-attestation-service/eas-sdk@2.10.0
//   node <repo>/packages/harnessy-core/test/fixtures/attest/generate-vectors.mjs > eas-sdk-vectors.json
//
// The key is derived from a public seed, so it signs test vectors only.
// The SDK's ESM build imports lodash by named export, which Node rejects, so load its CommonJS build.
import { createRequire } from "node:module";
import { keccak256, TypedDataEncoder, toUtf8Bytes, Wallet } from "ethers";

const {
	NO_EXPIRATION,
	Offchain,
	OffchainAttestationVersion,
	SchemaEncoder,
	SchemaRegistry,
	ZERO_ADDRESS,
	ZERO_BYTES32,
} = createRequire(`${process.cwd()}/`)("@ethereum-attestation-service/eas-sdk");

const SEED = "harnessy attest test vector key";
const SCHEMA_NAME = "workstream.contribution.v1";
const SCHEMA =
	"string contributionId,string projectId,string taskId,string contributorId,string contributionType,bytes32 artifactHash,uint64 acceptedAt,string policyVersionId,string awardUnit,uint256 awardQuantity";
const EAS_ADDRESS = "0x4200000000000000000000000000000000000021";
const EAS_VERSION = "1.4.1-beta.3";
const CHAIN_ID = 84532n;

const cases = [
	{
		contributionId: "01a16023-9d1f-74cf-9e14-fd2c50ea82b6",
		projectId: "01a1601c-db5d-7559-9824-953db93ddcf7",
		taskId: "01a16020-7f3f-78e2-96ce-2029226d3a1b",
		contributorId: "01a1601b-bbe7-760b-91bf-b3b3f355e8c6",
		contributionType: "accepted_submission",
		artifactHash: "0xe02ac6d75e020e591a7626dc84533d17b5289be9e2ce2c061d8d0675810a6786",
		acceptedAt: 1792614309n,
		policyVersionId: "01a1601d-9bf4-7602-8867-b180b4d02d07",
		awardUnit: "",
		awardQuantity: 0n,
	},
	{
		contributionId: "01a16240-b924-7823-b2ff-7462a1dd0983",
		projectId: "01a1601c-db5d-7559-9824-953db93ddcf7",
		taskId: "01a16020-7dd7-7291-98ac-5587ceff416c",
		contributorId: "01a1601b-bbe7-760b-91bf-b3b3f355e8c6",
		contributionType: "completed_review",
		artifactHash: "0x32963d80dae40ef2ed6ffe725d16835917e3ffe97f0f0937ed6c5589439b9cf1",
		acceptedAt: 1792649771n,
		policyVersionId: "01a1601d-9bf4-7602-8867-b180b4d02d07",
		awardUnit: "FLOW",
		awardQuantity: 10n,
	},
];

const wallet = new Wallet(keccak256(toUtf8Bytes(SEED)));
const schemaUid = SchemaRegistry.getSchemaUID(SCHEMA, ZERO_ADDRESS, true);
const encoder = new SchemaEncoder(SCHEMA);
const offchain = new Offchain(
	{ address: EAS_ADDRESS, version: EAS_VERSION, chainId: CHAIN_ID },
	OffchainAttestationVersion.Version2,
	undefined,
);
const fields = encoder.schema.map((item) => ({ name: item.name, type: item.type }));

const out = [];
for (const values of cases) {
	const data = encoder.encodeData(fields.map((field) => ({ ...field, value: values[field.name] })));
	const salt = keccak256(toUtf8Bytes(`${SCHEMA_NAME}:${values.contributionId}`));
	const attestation = await offchain.signOffchainAttestation(
		{
			schema: schemaUid,
			recipient: ZERO_ADDRESS,
			time: values.acceptedAt,
			expirationTime: NO_EXPIRATION,
			revocable: true,
			refUID: ZERO_BYTES32,
			data,
			salt,
		},
		wallet,
	);
	if (!offchain.verifyOffchainAttestationSignature(wallet.address, attestation)) throw new Error("SDK self-check failed");
	out.push({
		values: { ...values, acceptedAt: values.acceptedAt.toString(), awardQuantity: values.awardQuantity.toString() },
		data,
		salt,
		digest: TypedDataEncoder.hash(attestation.domain, attestation.types, attestation.message),
		uid: attestation.uid,
		signature: attestation.signature,
		domain: { ...attestation.domain, chainId: attestation.domain.chainId.toString() },
		types: attestation.types,
		primaryType: attestation.primaryType,
	});
}

process.stdout.write(
	`${JSON.stringify(
		{
			generator: "@ethereum-attestation-service/eas-sdk@2.10.0 with ethers@6.17.0",
			seed: SEED,
			signer: wallet.address,
			schema: SCHEMA,
			schemaUid,
			cases: out,
		},
		null,
		"\t",
	)}\n`,
);
