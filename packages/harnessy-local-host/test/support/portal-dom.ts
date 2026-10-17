/**
 * A recording document for portal page tests. It implements only the DOM calls
 * the page makes (see `src/portal/page/mount.ts`) and records every attribute,
 * so a test can prove that no markup was parsed and no unexpected attribute was
 * set. It is the DOM boundary only; the page code under test runs unchanged.
 */
import type { PortalDomDocument, PortalDomElement } from "../../src/portal/page/mount.ts";

export class RecordingElement implements PortalDomElement {
	readonly tag: string;
	readonly attributes = new Map<string, string>();
	readonly children: RecordingElement[] = [];
	#text: string | null = null;
	replaced = 0;

	constructor(tag: string) {
		this.tag = tag;
	}

	get textContent(): string | null {
		return this.#text ?? this.children.map((child) => child.textContent ?? "").join("");
	}

	set textContent(value: string | null) {
		this.children.length = 0;
		this.#text = value;
	}

	setAttribute(name: string, value: string): void {
		this.attributes.set(name, value);
	}

	appendChild(child: PortalDomElement): unknown {
		if (!(child instanceof RecordingElement)) throw new Error("foreign node");
		this.children.push(child);
		return child;
	}

	replaceChildren(): void {
		this.children.length = 0;
		this.#text = null;
		this.replaced += 1;
	}

	/** Every element in this subtree, depth first, this one included. */
	all(): RecordingElement[] {
		return [this, ...this.children.flatMap((child) => child.all())];
	}

	/** A readable outline: one line per element with its tag, attributes and own text. */
	outline(depth = 0): string {
		const attributes = [...this.attributes].map(([name, value]) => ` ${name}=${JSON.stringify(value)}`).join("");
		const own = this.#text === null ? "" : ` ${JSON.stringify(this.#text)}`;
		return [
			`${"  ".repeat(depth)}<${this.tag}${attributes}>${own}`,
			...this.children.map((child) => child.outline(depth + 1)),
		].join("\n");
	}
}

export class RecordingDocument implements PortalDomDocument {
	readonly created: RecordingElement[] = [];
	readonly byId = new Map<string, RecordingElement>();

	constructor(ids: ReadonlyArray<string> = ["main", "page-title"]) {
		for (const id of ids) this.byId.set(id, new RecordingElement(id === "main" ? "main" : "h1"));
	}

	createElement(tag: string): RecordingElement {
		const element = new RecordingElement(tag);
		this.created.push(element);
		return element;
	}

	getElementById(id: string): RecordingElement | null {
		return this.byId.get(id) ?? null;
	}
}
