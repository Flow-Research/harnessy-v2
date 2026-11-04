/**
 * Development-only component showcase (docs/portal-design-system.md#showcase).
 * The Vite dev server serves it at /showcase/; the production build emits only
 * the app's own index.html, so this page is never packaged or installed.
 */
import "../styles/fonts.css";
import "../styles/tokens.css";
import "../styles/app.css";
import "../components/quick-actions.css";
import "../screens/terminal.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { Showcase } from "./Showcase.tsx";

const root = document.getElementById("root");
if (root !== null)
	createRoot(root).render(
		<StrictMode>
			<Showcase />
		</StrictMode>,
	);
