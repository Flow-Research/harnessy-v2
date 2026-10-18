/** Entry point. Runs under `script-src 'self'; style-src 'self'`: no inline script, no injected style element. */
import "./styles/fonts.css";
import "./styles/tokens.css";
import "./styles/app.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.tsx";
import { applyTheme, storedTheme } from "./lib/browser.ts";
import { DataProvider, DataStore } from "./lib/data.tsx";
import { browserLocation } from "./lib/router.ts";
import { browserSessionEnvironment, SessionClient } from "./lib/session.ts";

const theme = storedTheme();
if (theme !== undefined) applyTheme(theme, false);

const client = new SessionClient(browserSessionEnvironment());
const store = new DataStore(client);
const root = document.getElementById("root");
if (root !== null)
	createRoot(root).render(
		<StrictMode>
			<DataProvider store={store}>
				<App client={client} store={store} location={browserLocation()} />
			</DataProvider>
		</StrictMode>,
	);
