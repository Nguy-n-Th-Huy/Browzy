// Regenerate test/fixtures/registry-baseline.json from the live registry.
// Run after an intentional registry contract change:
//   node test/_regen-baseline.mjs
// then review `git diff test/fixtures/registry-baseline.json` — every hunk
// must correspond to an intended change, or the live code drifted by
// accident. Mirrors test/registry-baseline.test.mjs's buildLiveSnapshot()
// (kept in sync by hand; the test file is the authority and fails loudly on
// any divergence this script did not intend).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TOOLS, toolInputJsonSchema } from "../host/tool-definitions.js";
import { extractMethod, BACKGROUND } from "./_extract.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAPSHOT_PATH = path.join(__dirname, "fixtures", "registry-baseline.json");

const snapshot = TOOLS.map((t) => {
  const body = extractMethod(t.name);
  return {
    name: t.name,
    description: t.description,
    inputSchema: toolInputJsonSchema(t),
    resultShape: {
      producesImage: /type:\s*["']image["']/.test(body),
      currentlyStub: /not (yet )?implemented|not supported/i.test(body)
    }
  };
}).sort((a, b) => a.name.localeCompare(b.name));

fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2) + "\n");
console.log(`wrote ${snapshot.length} entries to ${SNAPSHOT_PATH}`);
void BACKGROUND;
