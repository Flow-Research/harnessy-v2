import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { BriefGenerationStatus } from "../../brief-generation.ts";
import { useDataStore, useResource } from "../lib/data.tsx";
import type { ApiResult } from "../lib/session.ts";

const GenerationContext = createContext<() => Promise<ApiResult>>(async () => ({ kind: "signed_out" }));
export const BriefGenerationProvider = ({
	generate,
	children,
}: {
	generate: () => Promise<ApiResult>;
	children: ReactNode;
}) => <GenerationContext.Provider value={generate}>{children}</GenerationContext.Provider>;

export const GenerateBrief = ({ missing }: { missing: boolean }) => {
	const generate = useContext(GenerationContext);
	const store = useDataStore();
	const status = useResource<BriefGenerationStatus>("/v1/life/brief/generation");
	const [starting, setStarting] = useState(false);
	const [notice, setNotice] = useState("");
	const running = starting || status.data?.state === "running";
	useEffect(() => {
		if (status.data?.state === "succeeded") {
			void store.refresh("/v1/life/brief");
			void store.refresh("/v1/today");
		}
	}, [status.data?.state, store]);
	const start = async () => {
		if (running) return;
		setStarting(true);
		setNotice("Starting daily brief…");
		try {
			const result = await generate();
			if (result.kind === "ok") {
				setNotice("");
				await store.refresh("/v1/life/brief/generation");
			} else
				setNotice(
					result.kind === "signed_out" ? "Your session ended. Run harnessy open and try again." : result.message,
				);
		} catch {
			setNotice("Could not start the daily brief. Try again shortly.");
		} finally {
			setStarting(false);
		}
	};
	return (
		<div>
			<button type="button" className="button button-primary" disabled={running} onClick={() => void start()}>
				{running ? "Generating today’s brief…" : missing ? "Generate today’s brief" : "Regenerate today’s brief"}
			</button>
			<p className="fine-print">Uses your configured AI provider. Generation can take several minutes.</p>
			<output aria-live="polite">{notice || status.data?.message || ""}</output>
		</div>
	);
};
