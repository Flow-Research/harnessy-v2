import { readingIdentity } from "./identity.ts";
import type { LifeReadingCandidate, LifeReadingInput } from "./models.ts";

export interface LifeCurriculumItem {
	readonly title: string;
	readonly url: string;
	readonly question: string;
}

export interface LifeReadingCurriculum {
	readonly id: string;
	readonly name: string;
	readonly items: ReadonlyArray<LifeCurriculumItem>;
}

export interface LifeCurriculumSelection {
	readonly curriculum: LifeReadingCurriculum;
	readonly maxPerBrief: number;
}

const gitcoinPair = (
	question: string,
	entries: ReadonlyArray<readonly [title: string, slug: string]>,
): ReadonlyArray<LifeCurriculumItem> =>
	entries.map(([title, slug]) => ({
		title,
		url: `https://gitcoin.co/mechanisms/${slug}`,
		question,
	}));

const gitcoinItems: ReadonlyArray<LifeCurriculumItem> = [
	...gitcoinPair("When is a simple grant better than paying for a defined task?", [
		["Direct Grants", "direct-grants"],
		["Bounties", "bounties"],
	]),
	...gitcoinPair("How can clear scopes and staged payments reduce delivery risk?", [
		["Milestone-Based Funding", "milestone-based-funding"],
		["Requests for Proposals (RFPs)", "requests-for-proposals"],
	]),
	...gitcoinPair("What evidence should unlock funding, and who should be trusted to provide it?", [
		["Attestation-Based Funding", "attestation-based-funding"],
		["Impact Attestations", "impact-attestations"],
	]),
	...gitcoinPair("Can verified past impact guide future funding without excluding new contributors?", [
		["Impact Certificates (Hypercerts)", "impact-certificates-hypercerts"],
		["Retroactive Funding", "retroactive-funding"],
	]),
	...gitcoinPair("How should a community express priorities when allocating a shared budget?", [
		["Quadratic Funding", "quadratic-funding"],
		["Participatory Budgeting", "participatory-budgeting"],
	]),
	...gitcoinPair("How can several institutions fund shared infrastructure without one party controlling it?", [
		["Coalitional Funding", "coalitional-funding"],
		["Dedicated Domain Allocation", "dedicated-domain-allocation"],
	]),
	...gitcoinPair("What recurring revenue can sustain public infrastructure after grants end?", [
		["Percent-for-Public-Goods", "percent-for-public-goods"],
		["Fair Fees", "fair-fees"],
	]),
	...gitcoinPair("What governance support do funders need beyond the grant transaction itself?", [
		["Grant Ships", "grant-ships"],
		["Grants as a Service", "grants-as-a-service"],
	]),
	...gitcoinPair("How can invisible community work become visible and fairly rewarded?", [
		["SourceCred", "sourcecred"],
		["Praise", "praise"],
	]),
	...gitcoinPair("When should payment happen continuously instead of after a final deliverable?", [
		["Token Streaming", "token-streaming"],
		["Direct to Contract Incentives", "direct-to-contract-incentives"],
	]),
	...gitcoinPair("How can a network reward reliable service and respond to harmful behaviour?", [
		["Staking/Slashing", "staking-slashing"],
		["Decentralized Validators", "decentralized-validators"],
	]),
	...gitcoinPair("Where can data or AI improve allocation, and where must people remain in control?", [
		["Deep Funding (AI-PGF)", "deep-funding"],
		["Metrics-Based Voting", "metrics-based-voting"],
	]),
	...gitcoinPair("Can funding rules improve through experiments without making recipients bear all the risk?", [
		["AutoPGF", "autopgf"],
		["Evolutionary Grants Games", "evolutionary-grants-games"],
	]),
	...gitcoinPair("How can early commitments help a shared project reach the minimum support it needs?", [
		["Commitment Pooling", "commitment-pooling"],
		["Crowdstaking", "crowdstaking"],
	]),
	...gitcoinPair("Can a shared asset fund its own growth without relying on repeated fundraising?", [
		["Augmented Bonding Curve", "augmented-bonding-curve"],
		["Bonding Curves", "bonding-curves"],
	]),
	...gitcoinPair("Could local exchange systems widen participation when cash is scarce?", [
		["Community Currencies", "community-currencies"],
		["Mutual Credit", "mutual-credit"],
	]),
	...gitcoinPair("How can normal economic activity produce durable funding for shared infrastructure?", [
		["Retailism / Revenue Networks", "retailism-revenue-networks"],
		["Donation Mining", "donation-mining"],
	]),
	...gitcoinPair("Should projects seek funders, or should funders publish needs for projects to solve?", [
		["Proposal Inverter", "proposal-inverter"],
		["Prop House", "prop-house"],
	]),
	...gitcoinPair("How should long-term support influence decisions without letting wealth dominate?", [
		["Conviction Voting", "conviction-voting"],
		["Streaming Quadratic Voting", "streaming-quadratic-voting"],
	]),
	...gitcoinPair("Which comparison method helps a community make difficult trade-offs most clearly?", [
		["Pairwise (formerly Budget Box)", "pairwise"],
		["Quadratic Voting", "quadratic-voting"],
	]),
	...gitcoinPair("Which voting method best reflects broad consent rather than a narrow plurality?", [
		["Ranked Choice Voting", "ranked-choice-voting"],
		["STAR Voting", "star-voting"],
	]),
	...gitcoinPair("How can decision-making scale while limiting capture by a small group?", [
		["Sortition", "sortition"],
		["Holographic Consensus", "holographic-consensus"],
	]),
	...gitcoinPair("What is the smallest practical governance structure for a shared treasury?", [
		["MolochDAO", "molochdao"],
		["Multisig Treasury (Gnosis Safe)", "multisig-treasury"],
	]),
	...gitcoinPair("When should collaboration be temporary, and when should it become a lasting institution?", [
		["Ephemeral DAOs", "ephemeral-daos"],
		["Guilds", "guilds"],
	]),
	...gitcoinPair("Who should maintain a trusted registry, and how can bad entries be challenged?", [
		["Self-Curated Registries", "self-curated-registries"],
		["Token Curated Registry", "token-curated-registry"],
	]),
	...gitcoinPair("What proof should connect identity, contribution and reward without creating surveillance?", [
		["Decentralized Identity", "decentralized-identity"],
		["Proof-of-Work", "proof-of-work"],
	]),
	...gitcoinPair("How should resources flow across a network when value grows through shared use?", [
		["Aqueduct", "aqueduct"],
		["Network Goods", "network-goods"],
	]),
	...gitcoinPair("When can credible commitments solve the problem of funding something everyone needs?", [
		["Dominant Assurance Contracts", "dominant-assurance-contracts"],
		["Markets", "markets"],
	]),
	...gitcoinPair("Which automatic contribution rules are legitimate, transparent and easy to govern?", [
		["Taxes", "taxes"],
		["Tithing", "tithing"],
	]),
	...gitcoinPair("How can money be designed to circulate instead of concentrating or sitting idle?", [
		["Demurrage", "demurrage"],
		["Universal Basic Income", "universal-basic-income"],
	]),
	...gitcoinPair("What can formal digital institutions learn from reciprocal community support?", [
		["Mutual Aid Networks", "mutual-aid-networks"],
		["Gift Circles", "gift-circles"],
	]),
	...gitcoinPair("When can lightweight trust practices work, and when do they become too informal?", [
		["Honour", "honour"],
		["Cookie Jar", "cookie-jar"],
	]),
	...gitcoinPair("How should a funding system balance evidence, values and practical usability?", [
		["Effective Altruism", "effective-altruism"],
		["Skeuomorphism", "skeuomorphism"],
	]),
	...gitcoinPair("Can unconventional ownership or random allocation reveal better funding choices?", [
		["Harberger Taxes", "harberger-taxes"],
		["Lotto PGF", "lotto-pgf"],
	]),
	...gitcoinPair("How might quadratic mechanisms support projects from formation through growth?", [
		["Quadratic Acceleration (q/acc)", "quadratic-acceleration"],
		["Quadratic Funding Powered Social Network", "quadratic-funding-powered-social-network"],
	]),
	...gitcoinPair("When should forecasts guide governance, and what must remain a human judgement?", [
		["Futarchy", "futarchy"],
		["Voting", "voting"],
	]),
	...gitcoinPair("How can open groups coordinate useful work without a central manager?", [
		["Swarms", "swarms"],
		["Stigmergy", "stigmergy"],
	]),
	...gitcoinPair("Can social participation improve funding signals without turning governance into popularity?", [
		["JokeRace", "jokerace"],
		["Web3 Social", "web3-social"],
	]),
	...gitcoinPair("How can creative work and treasury auctions surface value that committees may miss?", [
		["Artizen Artifacts", "artizen-artifacts"],
		["Auction-Based Treasury Funding", "auction-based-treasury-funding"],
	]),
];

export const GITCOIN_FUNDING_MECHANISMS_CURRICULUM: LifeReadingCurriculum = {
	id: "gitcoin-funding-mechanisms",
	name: "Gitcoin funding mechanisms",
	items: gitcoinItems,
};

const curricula = new Map<string, LifeReadingCurriculum>([
	[GITCOIN_FUNDING_MECHANISMS_CURRICULUM.id, GITCOIN_FUNDING_MECHANISMS_CURRICULUM],
]);

export const findLifeReadingCurriculum = (id: string): LifeReadingCurriculum | null => curricula.get(id) ?? null;

const curriculumInput = (
	curriculum: LifeReadingCurriculum,
	item: LifeCurriculumItem,
	index: number,
): LifeReadingInput => ({
	url: item.url,
	title: item.title,
	topic: item.question,
	publishedAt: null,
	sourceName: curriculum.name,
	sourceKind: "curated",
	sourceId: `curriculum:${curriculum.id}:${String(index + 1).padStart(3, "0")}`,
});

/** Select the next ordered readings, keeping the same pair until delivery succeeds. */
export const nextLifeCurriculumReadings = (
	selection: LifeCurriculumSelection,
	existing: ReadonlyArray<Pick<LifeReadingCandidate, "identity" | "status">>,
): ReadonlyArray<LifeReadingInput> => {
	const delivered = new Set(
		existing.filter((candidate) => candidate.status === "delivered").map((candidate) => candidate.identity),
	);
	return selection.curriculum.items
		.map((item, index) => curriculumInput(selection.curriculum, item, index))
		.filter((input) => !delivered.has(readingIdentity(input).identity))
		.slice(0, Math.max(0, selection.maxPerBrief));
};
