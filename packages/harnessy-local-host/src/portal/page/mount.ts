/**
 * Turns view-model nodes into DOM elements. This is the page's only DOM writer.
 *
 * It uses `createElement`, `textContent`, `appendChild`, `replaceChildren` and
 * `setAttribute` for exactly three attributes: a fixed `class`, and `href` plus
 * `rel` on a link that passes {@link safeHref}. It never parses markup, so text
 * from the API can never become an element, a script or an event handler.
 *
 * The DOM is described by the small interfaces below rather than the `dom`
 * library, so the package keeps one global type environment and tests can use a
 * recording document at this exact boundary.
 */
import { type PortalNode, safeHref } from "./view-model.ts";

export interface PortalDomElement {
	textContent: string | null;
	setAttribute(name: string, value: string): void;
	appendChild(child: PortalDomElement): unknown;
	replaceChildren(): void;
}

export interface PortalDomDocument {
	createElement(tag: string): PortalDomElement;
}

const build = (document: PortalDomDocument, node: PortalNode): PortalDomElement => {
	const element = document.createElement(node.tag);
	if (node.className !== undefined) element.setAttribute("class", node.className);
	if (node.tag === "a") {
		const href = safeHref(node.href);
		if (href !== undefined) {
			element.setAttribute("href", href);
			element.setAttribute("rel", "noreferrer noopener");
		}
	}
	if (node.text !== undefined) element.textContent = node.text;
	for (const child of node.children ?? []) element.appendChild(build(document, child));
	return element;
};

/** Replace everything inside `parent` with `nodes`. */
export const mount = (
	document: PortalDomDocument,
	parent: PortalDomElement,
	nodes: ReadonlyArray<PortalNode>,
): void => {
	parent.replaceChildren();
	for (const node of nodes) parent.appendChild(build(document, node));
};
