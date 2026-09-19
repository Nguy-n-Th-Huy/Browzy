#!/usr/bin/env node
//
// The source fetch client (host/agent/jev/source-fetch.js): every guard that
// stands between a run and an arbitrary URL — per spec `typesafe-jev-provider`,
// "A run may consult sources beyond the page it drives".
//
// Each test drives the real client against a local server (or an injected
// fetch); no external host is contacted. The point of every case here is that
// the client REFUSES, by name, and throws nothing the caller has to catch
// blind.
//
// Run: node host/test/jev-source-fetch.test.mjs

import http from "node:http";

import {
  fetchSource,
  parseSourceUrl,
  isBlockedAddress,
  isTextContentType,
  extractText,
  SourceFetchError,
  MAX_SOURCE_BYTES,
  MAX_SOURCE_TEXT_CHARS,
  MAX_REDIRECTS
} from "../agent/jev/source-fetch.js";

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false, err: err.message });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

/** A local server whose handler each test supplies. */
async function startServer(handler) {
  const state = { paths: [], headers: [] };
  const server = http.createServer((req, res) => {
    state.paths.push(req.url);
    state.headers.push(req.headers);
    handler(req, res, state);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    state,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

// Every local server answers on loopback, which the client blocks by design.
// So a test that must actually read a body uses a public-looking hostname and
// injects two things: a resolver that calls it public (so the ADDRESS guard is
// exercised as it would be in production) and a fetch that sends the socket to
// the local server. Everything between those two — redirect hops, the size
// cap, the content-type check, the timeout, the body reader — is the real
// client running its real path.
const allowPublic = async () => [{ address: "93.184.216.34", family: 4 }];
const toLocal = (server) => (url, init) => globalThis.fetch(String(url).replace(/^http:\/\/[^/]+/, server.url), init);

async function expectCode(promise, code, label) {
  try {
    await promise;
  } catch (err) {
    assert(err instanceof SourceFetchError, `${label}: expected a SourceFetchError, got ${err?.name}: ${err?.message}`);
    assert(err.code === code, `${label}: expected ${code}, got ${err.code} (${err.message})`);
    return err;
  }
  throw new Error(`${label}: expected ${code}, but the call resolved`);
}

console.log("\nJev source fetch\n");

await test("only an absolute http(s) URL is a source", () => {
  for (const [raw, label] of [
    ["file:///C:/Windows/win.ini", "a file URL"],
    ["data:text/html,<b>hi</b>", "a data URL"],
    ["chrome-extension://abc/page.html", "an extension URL"],
    ["/relative/path", "a relative path"],
    ["not a url", "prose"],
    ["", "nothing at all"]
  ]) {
    let code = null;
    try {
      parseSourceUrl(raw);
    } catch (err) {
      code = err.code;
    }
    assert(code === "INVALID_URL", `${label} must be refused as INVALID_URL, got ${code}`);
  }
  assert(parseSourceUrl("https://example.com/a?b=1").host === "example.com", "an ordinary https URL is accepted");
});

await test("the private, loopback and link-local ranges are not sources", () => {
  for (const address of [
    "127.0.0.1",
    "0.0.0.0",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254", // the cloud metadata address
    "100.64.0.1",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "::ffff:10.0.0.1" // the same private address wearing IPv6 clothes
  ]) {
    assert(isBlockedAddress(address) === true, `${address} must be blocked`);
  }
  for (const address of ["93.184.216.34", "8.8.8.8", "172.32.0.1", "2606:2800:220:1:248:1893:25c8:1946"]) {
    assert(isBlockedAddress(address) === false, `${address} is public and must be allowed`);
  }
  assert(isBlockedAddress("example.com") === false, "a hostname is not judged here — its resolved addresses are");
});

await test("a hostname that resolves to a private address is refused", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>secret</body></html>");
  });
  try {
    await expectCode(
      // The hostname looks public; DNS says otherwise. The check is on the
      // ANSWER, not on the spelling.
      fetchSource({ url: `http://internal.example.com:${server.port}/`, resolver: async () => [{ address: "10.0.0.5", family: 4 }] }),
      "BLOCKED_ADDRESS",
      "a hostname resolving inside the LAN"
    );
    assert(server.state.paths.length === 0, "nothing may be requested from a blocked host");
  } finally {
    await server.close();
  }
});

await test("a redirect into a private address is caught at the hop, not at the start", async () => {
  const server = await startServer((req, res, state) => {
    if (state.paths.length === 1) {
      res.writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" });
      res.end();
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("should never be read");
  });
  try {
    await expectCode(
      fetchSource({ fetchImpl: toLocal(server), url: `http://public.example.com:${server.port}/start`, resolver: allowPublic }),
      "BLOCKED_ADDRESS",
      "a public URL redirecting to the metadata address"
    );
  } finally {
    await server.close();
  }
});

await test("a redirect loop is bounded", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(302, { Location: "/again" });
    res.end();
  });
  try {
    await expectCode(
      fetchSource({ fetchImpl: toLocal(server), url: `http://public.example.com:${server.port}/start`, resolver: allowPublic }),
      "TOO_MANY_REDIRECTS",
      "an endless redirect"
    );
    assert(server.state.paths.length <= MAX_REDIRECTS + 1, `the hops are capped (${server.state.paths.length})`);
  } finally {
    await server.close();
  }
});

await test("a body over the limit is refused while it is being read", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    // No content-length: the cap has to hold on the stream itself.
    for (let i = 0; i < 40; i += 1) res.write("x".repeat(32 * 1024));
    res.end();
  });
  try {
    await expectCode(
      fetchSource({ fetchImpl: toLocal(server), url: `http://public.example.com:${server.port}/big`, resolver: allowPublic }),
      "TOO_LARGE",
      "an undeclared oversize body"
    );
  } finally {
    await server.close();
  }
});

await test("a declared oversize body is refused before it is read at all", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain", "Content-Length": String(MAX_SOURCE_BYTES * 4) });
    res.end("x");
  });
  try {
    await expectCode(
      fetchSource({ fetchImpl: toLocal(server), url: `http://public.example.com:${server.port}/declared`, resolver: allowPublic }),
      "TOO_LARGE",
      "a declared oversize body"
    );
  } finally {
    await server.close();
  }
});

await test("a binary or unknown content type is refused by name", async () => {
  for (const [type, label] of [
    ["application/pdf", "a PDF"],
    ["image/png", "an image"],
    ["application/octet-stream", "a binary blob"],
    ["", "no content type at all"]
  ]) {
    const server = await startServer((req, res) => {
      res.writeHead(200, type ? { "Content-Type": type } : {});
      res.end("....");
    });
    try {
      await expectCode(
        fetchSource({ fetchImpl: toLocal(server), url: `http://public.example.com:${server.port}/doc`, resolver: allowPublic }),
        "UNSUPPORTED_CONTENT",
        label
      );
    } finally {
      await server.close();
    }
  }
  assert(isTextContentType("text/html; charset=utf-8") === true, "html with a charset is text");
  assert(isTextContentType("application/json") === true, "json is text");
  assert(isTextContentType("image/jpeg") === false, "an image is not");
});

await test("a slow server cannot hold a run open", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain" });
    // Never finishes within the test's own timeout.
    setTimeout(() => res.end("late"), 5_000).unref?.();
  });
  try {
    await expectCode(
      fetchSource({ fetchImpl: toLocal(server), url: `http://public.example.com:${server.port}/slow`, resolver: allowPublic, timeoutMs: 120 }),
      "TIMEOUT",
      "a server that never answers"
    );
  } finally {
    await server.close();
  }
});

await test("an error status is reported, never treated as a document", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<html><body>not found</body></html>");
  });
  try {
    const err = await expectCode(
      fetchSource({ fetchImpl: toLocal(server), url: `http://public.example.com:${server.port}/missing`, resolver: allowPublic }),
      "HTTP_ERROR",
      "a 404"
    );
    assert(/404/.test(err.message), `the status is named: ${err.message}`);
  } finally {
    await server.close();
  }
});

await test("a readable page comes back as bounded text, with no credential sent", async () => {
  const server = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(
      "<html><head><title>KTD — Giới thiệu</title></head><body>" +
        "<script>var secret = 'do not read me';</script>" +
        "<style>.a{color:red}</style>" +
        "<h1>Tích hợp hệ thống</h1><p>An toàn thông tin &amp; dịch vụ CNTT</p>" +
        "</body></html>"
    );
  });
  try {
    const source = await fetchSource({ fetchImpl: toLocal(server), url: `http://public.example.com:${server.port}/about`, resolver: allowPublic });
    assert(source.title === "KTD — Giới thiệu", `the document's own title is kept: ${source.title}`);
    assert(/Tích hợp hệ thống/.test(source.text), "the prose is extracted");
    assert(/An toàn thông tin & dịch vụ CNTT/.test(source.text), "entities are decoded");
    assert(!/do not read me/.test(source.text), "script contents are code, not prose — they never reach the model");
    assert(!/color:red/.test(source.text), "…and neither does stylesheet text");
    assert(!/<h1>/.test(source.text), "markup is stripped");
    const sent = server.state.headers[0];
    assert(!sent.cookie && !sent.authorization, `no credential of the operator's is sent: ${JSON.stringify({ cookie: sent.cookie, auth: sent.authorization })}`);
  } finally {
    await server.close();
  }
});

await test("extracted text is bounded", () => {
  const long = extractText("<html><body>" + "a".repeat(MAX_SOURCE_TEXT_CHARS * 2) + "</body></html>", "text/html");
  assert(long.length === MAX_SOURCE_TEXT_CHARS, `bounded to ${MAX_SOURCE_TEXT_CHARS}, got ${long.length}`);
});

const failed = results.filter((r) => !r.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} passed` +
    (failed.length ? `\n\nFailures:\n${failed.map((f) => `  - ${f.name}: ${f.err}`).join("\n")}` : "") +
    "\n"
);
process.exitCode = failed.length ? 1 : 0;
