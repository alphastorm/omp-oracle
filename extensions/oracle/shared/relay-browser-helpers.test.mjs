import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeRelayTab } from "./relay-browser-helpers.mjs";

test("cleanup refuses to forget a live target omitted by the driver", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oracle-relay-cleanup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "driver");
  await writeFile(binary, `#!${process.execPath}
console.log(JSON.stringify({success:true,data:{tabs:[]}}));
`);
  await chmod(binary, 0o700);
  const targetId = "PAGE-owned-job";
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/json/version"
      ? { webSocketDebuggerUrl: "ws://127.0.0.1/fixture" }
      : [{ id: targetId, url: "about:blank" }]));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await assert.rejects(closeRelayTab({ binary, sessionName: "fixture", endpoint, targetId }));
});

test("cleanup of a target the relay no longer lists never spawns the driver", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oracle-relay-cleanup-gone-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const binary = join(root, "driver");
  const invoked = join(root, "driver-invoked");
  await writeFile(binary, `#!${process.execPath}
require("node:fs").writeFileSync(${JSON.stringify(invoked)}, process.argv.slice(2).join(" "));
console.log(JSON.stringify({success:true,data:{tabs:[]}}));
`);
  await chmod(binary, 0o700);
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(request.url === "/json/version"
      ? { webSocketDebuggerUrl: "ws://127.0.0.1/fixture" }
      : [{ id: "PAGE-someone-else", url: "https://example.invalid/" }]));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  await closeRelayTab({ binary, sessionName: "fixture", endpoint, targetId: "PAGE-owned-job" });
  await assert.rejects(import("node:fs/promises").then((fs) => fs.access(invoked)), "a fresh pinned daemon would create a stray tab for a target that is already gone");
});
