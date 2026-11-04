/**
 * Keeps one failing part of the page from taking the whole app down. Without a
 * boundary, React unmounts everything when a render throws, and the page goes
 * blank. The fallback is plain text through React escaping, never markup.
 */
import { Component, type ReactNode } from "react";

interface ErrorBoundaryProps {
	/** Shown instead of the children after a render error. */
	readonly fallback: ReactNode;
	/** A change of this value clears the error, for example a new screen or a new text. */
	readonly resetKey?: string;
	readonly children: ReactNode;
}

interface ErrorBoundaryState {
	readonly failed: boolean;
	/** The `resetKey` the state belongs to; a new key starts afresh. */
	readonly key: string | undefined;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
	override state: ErrorBoundaryState = { failed: false, key: this.props.resetKey };

	static getDerivedStateFromProps(props: ErrorBoundaryProps, state: ErrorBoundaryState): ErrorBoundaryState | null {
		return props.resetKey === state.key ? null : { failed: false, key: props.resetKey };
	}

	static getDerivedStateFromError(): Partial<ErrorBoundaryState> {
		return { failed: true };
	}

	override render(): ReactNode {
		return this.state.failed ? this.props.fallback : this.props.children;
	}
}

/** The fallback for a screen that failed to render. */
export const ScreenFailed = () => (
	<div className="empty" role="alert">
		<p className="empty-title">This screen could not be shown.</p>
		<p className="empty-body">The rest of Harnessy still works. Pick another screen, or read again.</p>
	</div>
);

/** The fallback for a text that failed to render as Markdown: the text as written. */
export const PlainTextFallback = ({ text }: { text: string }) => (
	<div className="markdown" role="alert">
		<p className="tone-attention">This text could not be formatted; it is shown as written.</p>
		<pre className="code-block">
			<code>{text}</code>
		</pre>
	</div>
);
