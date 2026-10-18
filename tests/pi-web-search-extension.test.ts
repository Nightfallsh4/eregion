import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions } from "@mariozechner/pi-coding-agent";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const wrapperPath = "./extensions/eregion/pi-web-search.ts";

test("loads pi-web-search from Eregion's named extension wrapper", async () => {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "eregion-pi-web-search-test-"));
	try {
		const result = await discoverAndLoadExtensions([wrapperPath], repositoryRoot, agentDir);

		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		assert.equal(result.extensions[0]?.path, path.join(repositoryRoot, "extensions/eregion/pi-web-search.ts"));
		assert.ok(result.extensions[0]?.tools.has("web_search"));
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
