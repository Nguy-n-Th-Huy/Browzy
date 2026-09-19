import assert from "node:assert/strict";
import test from "node:test";
import { requestCompletionCheck, requestFinalReport, observationsContext, COMPLETION_CHECK, FINAL_REPORT } from "../agent/jev/text-helper.js";
import { reportLinks, MAX_REPORT_LINKS_BYTES, groundReport } from "../agent/jev/report-grounding.js";

const actual = "https://dauthau.asia/thong-bao-moi-thau/mua-sam-may-tinh-123456.html";
const invented = "https://dauthau.asia/thong-bao-moi-thau/IB2600473784-01";
const pageUrl = "https://dauthau.asia/search/?keyword=m%C3%A1y+t%C3%ADnh&filter=" + "x".repeat(600);
const page = { url: pageUrl, title: "Search results", text: "IB2600473784-01: Mua sắm máy tính", links: [{ url: actual, label: "Mua sắm máy tính" }] };

function fixture(wire, replies) {
  const bodies = [];
  return {
    bodies,
    textModel: { baseUrl: "https://provider.test/v1", kind: wire === "anthropic" ? "anthropic" : "openai", model: "fixture", apiKey: "fixture" },
    fetchImpl: async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      const next = replies[Math.min(bodies.length - 1, replies.length - 1)];
      const data = next.content ? next : wire === "anthropic" ? { content: [{ type: "text", text: JSON.stringify(next) }] } : { choices: [{ message: { content: JSON.stringify(next) } }] };
      return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    }
  };
}

for (const wire of ["openai", "anthropic"]) {
  for (const completion of [true, false]) {
    const name = completion ? "completion" : "final";
    const request = completion ? requestCompletionCheck : requestFinalReport;
    const reply = (report) => completion ? { achieved: true, report } : { report };
    test(`${wire} ${name}: repairs fabricated detail links using actual observed destinations`, async () => {
      const f = fixture(wire, [reply(`[Result](${invented})`), reply(`[Mua sắm máy tính](${actual}) — IB2600473784-01`)]);
      const result = await request({ ...f, page, goal: "Report first result", outcome: "done" });
      assert.match(result.report, /mua-sam-may-tinh-123456/);
      assert.equal(f.bodies.length, 2);
      const user = JSON.parse(f.bodies[0].messages.find((m) => m.role === "user").content);
      assert.equal(user.page.url, pageUrl);
      assert.equal(user.page.links[0].url, actual);
      assert.match(f.bodies[1].messages.at(-1).content, /unobserved URL/);
    });
    test(`${wire} ${name}: repeated fabrication fails after exactly one corrective attempt`, async () => {
      const f = fixture(wire, [reply(invented)]);
      await assert.rejects(request({ ...f, page, goal: "Report", outcome: "done", memory: { notes: invented }, conversation: [{ answer: invented }] }), (err) => err.code === "INVALID_RESPONSE" && err.detail.attempts === 2);
      assert.equal(f.bodies.length, 2);
    });
    test(`${wire} ${name}: preserves full URLs, query encoding, parentheses, observed history and prose analysis`, async () => {
      const detail = "https://example.com/part_(one)?q=m%C3%A1y%20t%C3%ADnh&token=" + "z".repeat(500);
      const f = fixture(wire, [reply(`Kết luận: 3 kết quả. [Tìm kiếm](${pageUrl}), [Chi tiết](${detail}).`)]);
      const result = await request({ ...f, page, observations: [{ url: "https://example.com/previous", links: [{ url: detail, label: "prior result" }] }], outcome: "done" });
      assert.ok(result.report.includes(detail));
      assert.equal(f.bodies.length, 1);
    });
  }
}

test("consulted source URLs are exact evidence and their complete destinations reach the model", async () => {
  const f = fixture("openai", [{ report: `[Nguồn](${pageUrl})` }]);
  const result = await requestFinalReport({ ...f, goal: "Analyze", outcome: "done", sources: [{ url: pageUrl, text: "facts" }] });
  assert.ok(result.report.includes(pageUrl));
  assert.equal(JSON.parse(f.bodies[0].messages[1].content).consulted_sources[0].url, pageUrl);
});

test("provider search results survive pause continuation and ground final citations", async () => {
  const url = "https://search-evidence.test/fact";
  const f = fixture("anthropic", [
    { stop_reason: "pause_turn", content: [{ type: "web_search_tool_result", content: [{ type: "web_search_result", url }] }] },
    { report: `[Evidence](${url})` }
  ]);
  const result = await requestFinalReport({ ...f, outcome: "done", search: true });
  assert.ok(result.report.includes(url));
  assert.equal(f.bodies.length, 2);
});

test("link budgets omit complete records, never create shortened URL evidence", () => {
  const links = Array.from({ length: 100 }, (_, i) => ({ url: `https://example.com/${i}?q=${"a".repeat(1000)}`, label: "Máy tính" }));
  const projected = reportLinks(links);
  assert.ok(projected.links_omitted > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(projected.links)) <= MAX_REPORT_LINKS_BYTES);
  for (const row of projected.links) assert.ok(links.some((link) => link.url === row.url));
  assert.deepEqual(reportLinks([{ url: "https://example.com/" + "x".repeat(8192) }]), { links_omitted: 1 });
  assert.equal(observationsContext([{ url: pageUrl }]).pages[0].url, pageUrl);
});

test("invented query subsets, relative links and credential URLs cannot bypass grounding", async () => {
  for (const report of ["https://dauthau.asia/search/?keyword=m%C3%A1y+t%C3%ADnh", "[Result](/thong-bao-moi-thau/IB2600473784-01)", "[Result](https://user:pass@example.com/fabricated)"]) {
    const f = fixture("openai", [{ report }]);
    await assert.rejects(requestFinalReport({ ...f, page, outcome: "done" }), /unobserved URL/);
  }
});

test("exact observed URL punctuation and ordinary domain mentions remain usable", async () => {
  for (const url of ["https://example.com/why?", "https://example.com/wow!", "https://example.com/file."]) {
    const f = fixture("openai", [{ report: `Kết quả từ dauthau.asia và www.example.com: [chi tiết](${url}).` }]);
    assert.ok((await requestFinalReport({ ...f, page: { links: [{ url }] }, outcome: "done" })).report.includes(url));
  }
});

test("every declared destination uses the same evidence gate regardless of syntax or path prefix", () => {
  const reports = [
    "[Chi tiết](thong-bao-moi-thau/IB2600473784-01)",
    "[Chi tiết](<thong-bao-moi-thau/IB2600473784-01>)",
    "[Chi tiết](thong-bao-moi-thau/IB2600473784-01 \"Title\")",
    "[Chi tiết](#invented)", "[Chi tiết]()",
    "[Chi tiết][result]\n\n[result]: thong-bao-moi-thau/IB2600473784-01",
    "[Chi tiết][result]\n\n[result]: <thong-bao-moi-thau/IB2600473784-01> \"Title\"",
    '<a href="/thong-bao-moi-thau/IB2600473784-01">Chi tiết</a>',
    "<a href='thong-bao-moi-thau/IB2600473784-01'>Chi tiết</a>",
    "<a href=thong-bao-moi-thau/IB2600473784-01>Chi tiết</a>",
    '<a title=">" href="/invented">Chi tiết</a>',
    '<a href="https&#58;//example.com/invented">Chi tiết</a>',
    "![result](unobserved.png)"
  ];
  for (const report of reports) assert.equal(groundReport({ ok: true, report }, new Set()).ok, false, report);
  const known = new Set([actual]);
  for (const report of [`[Chi tiết](${actual} "Title")`, `[Chi tiết](<${actual}>)`, `[result]: ${actual}`, `<a href="${actual}">Chi tiết</a>`]) {
    assert.equal(groundReport({ ok: true, report }, known).ok, true, report);
  }
});

for (const wire of ["openai", "anthropic"]) {
  test(`${wire}: unread attempted source cannot authorize invented result URL, correction can retain names/codes`, async () => {
    const f = fixture(wire, [{ report: `[Mua sắm máy tính](${invented})` }, { report: `IB2600473784-01 — Mua sắm máy tính. [Chi tiết](${actual})` }]);
    const result = await requestFinalReport({ ...f, page, outcome: "done", sources: [{ url: invented, unreadReason: "HTTP 404" }] });
    assert.equal(f.bodies.length, 2);
    assert.ok(result.report.includes(actual));
  });
}

test("failed fetch of independently observed URL may still be disclosed accurately", async () => {
  const f = fixture("openai", [{ report: `Không đọc được [nguồn](${actual}).` }]);
  assert.ok((await requestFinalReport({ ...f, page, outcome: "done", sources: [{ url: actual, unreadReason: "HTTP 404" }] })).report.includes(actual));
  assert.equal(f.bodies.length, 1);
});

test("report instructions explain limitations without exposing internal protocol vocabulary", () => {
  for (const instruction of [COMPLETION_CHECK, FINAL_REPORT]) {
    assert.match(instruction, /plain language/);
    assert.match(instruction, /internal field names/);
    assert.match(instruction, /Say which links or facts were available instead/);
  }
  assert.match(FINAL_REPORT, /Never claim an outcome better than the one you were given/);
});

test("completion and terminal reports share concise extraction and visible-incompleteness guidance", () => {
  for (const instruction of [COMPLETION_CHECK, FINAL_REPORT]) {
    assert.match(instruction, /requested fields and answer first/);
    assert.match(instruction, /compact Markdown table/);
    assert.match(instruction, /never dump a long search\/query URL/);
    assert.match(instruction, /never put material incompleteness only in this secondary section/);
    assert.match(instruction, /### Chi tiết bổ sung/);
    assert.doesNotMatch(instruction, /Close with two or three concrete next steps/);
  }
});
