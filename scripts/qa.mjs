#!/usr/bin/env node

import { runPinnedQaCli } from "./qa-runtime-bridge.mjs";

process.exitCode = await runPinnedQaCli(process.argv.slice(2));
