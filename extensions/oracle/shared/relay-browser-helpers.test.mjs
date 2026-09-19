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
