import assert from "node:assert/strict";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { closeRelayTab } from "./relay-browser-helpers.mjs";

for (const disappears of [true, false]) {
  test(`acknowledged tab close ${disappears ? "waits for asynchronous target removal" : "still rejects a target that remains live"}`, { skip: process.platform === "win32" }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "oracle-relay-close-transition-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const targetId = "PAGE-owned-job";
    let closeCount = 0;
    let closingInventories = 0;
    let observedRemoval = false;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url === "/json/version") {
        response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/fixture" }));
      } else if (request.url === "/close") {
        closeCount++;
        response.end("{}");
      } else {
        if (closeCount) closingInventories++;
        const live = !disappears || closingInventories < 2;
        observedRemoval ||= !live;
        response.end(JSON.stringify([{ id: "PAGE-unowned" }, ...(live ? [{ id: targetId }] : [])]));
      }
    });
    t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const endpoint = `http://127.0.0.1:${server.address().port}`;
    const binary = join(root, "driver");
    await writeFile(binary, `#!${process.execPath}
(async () => {
  if (process.argv.at(-1) === "close") {
    await fetch(${JSON.stringify(endpoint + "/close")});
    console.log(JSON.stringify({ success: true, data: { targetId: ${JSON.stringify(targetId)} } }));
  } else {
    console.log(JSON.stringify({ success: true, data: { tabs: [{ targetId: ${JSON.stringify(targetId)}, active: true }] } }));
  }
})();
`);
    await chmod(binary, 0o700);
    const closing = closeRelayTab({ binary, sessionName: "fixture", endpoint, targetId });
    if (disappears) {
      assert.equal(await closing, "closed");
      assert.equal(observedRemoval, true, "cleanup must observe absence, not just accept the close acknowledgement");
    } else {
      await assert.rejects(closing);
      assert.equal(observedRemoval, false);
    }
    assert.equal(closeCount, 1, "wait for the same target; never issue another close");
  });
}

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
  assert.equal(await closeRelayTab({ binary, sessionName: "fixture", endpoint, targetId: "PAGE-owned-job" }), "absent");
  await assert.rejects(import("node:fs/promises").then((fs) => fs.access(invoked)), "a fresh pinned daemon would create a stray tab for a target that is already gone");
});

test("last-tab refusal releases only the owned pinned target to about:blank", { skip: process.platform === "win32" }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "oracle-relay-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const targetId = "PAGE-owned-job";
  const commands = [];
  const paths = [];
  let releaseRequested = false;
  let releaseInventories = 0;
  const server = createServer(async (request, response) => {
    paths.push(request.url);
    response.setHeader("content-type", "application/json");
    if (request.url === "/json/version") {
      response.end(JSON.stringify({ webSocketDebuggerUrl: "ws://127.0.0.1/fixture" }));
    } else if (request.url === "/command") {
      let body = "";
      for await (const chunk of request) body += chunk;
      const args = JSON.parse(body);
      commands.push(args);
      if (args.at(-2) === "open" && args.at(-1) === "about:blank") releaseRequested = true;
      response.end("{}");
    } else if (request.url === "/json/list") {
      if (releaseRequested) releaseInventories++;
      response.end(JSON.stringify([
        { id: targetId, url: releaseInventories >= 2 ? "about:blank" : "https://example.invalid/c/owned" },
        { id: "PAGE-unowned", url: "https://example.invalid/c/unowned" },
      ]));
    } else {
      response.writeHead(500).end("{}");
    }
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  const binary = join(root, "driver");
  await writeFile(binary, `#!${process.execPath}
(async () => {
  const args = process.argv.slice(2);
  await fetch(${JSON.stringify(endpoint + "/command")}, { method: "POST", body: JSON.stringify(args) });
  if (args.at(-2) === "tab" && args.at(-1) === "close") {
    console.log(JSON.stringify({ success: false, data: null, error: "Cannot close the last tab" }));
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({ success: true, data: { tabs: [{ targetId: ${JSON.stringify(targetId)}, active: true }] } }));
  }
})();
`);
  await chmod(binary, 0o700);
  assert.equal(await closeRelayTab({ binary, sessionName: "fixture", endpoint, targetId }), "released");
  assert.ok(releaseInventories >= 2, "release must verify the owned target is actually blank");
  const prefix = ["--session", "fixture", "--cdp", endpoint, "--pin-tab", "--json"];
  assert.deepEqual(commands, [[...prefix, "tab", "list"], [...prefix, "tab", "close"], [...prefix, "open", "about:blank"]]);
  assert.ok(paths.every((path) => !path.startsWith("/json/close")), "never close a relay window through CDP discovery");
});
