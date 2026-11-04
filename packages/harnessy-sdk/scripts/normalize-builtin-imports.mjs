import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../dist/node.js", import.meta.url);
const source = await readFile(path, "utf8");
const normalized = source.replace(/(from\s+|import\(\s*)"sqlite"/g, '$1"node:sqlite"');
if (normalized !== source) await writeFile(path, normalized);
