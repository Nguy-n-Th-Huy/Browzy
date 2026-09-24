#!/usr/bin/env node
//
// Recall (openspec/changes/add-task-memory tasks.md 3.1-3.2): exact-site,
// deterministic, at most three candidates, stale never offered, explicit
// repeat cues honoured — measured against real Vietnamese requests,
// including an unaccented one (the design's open question about folding
// diacritics is recorded here as a measurement, not an assumption).
//
// Run: node host/test/task-memory-recall.test.mjs

const { recallForRun, RECALL_MIN_SCORE, MAX_CANDIDATES } = await import("../agent/memory/recall.js");
const { tokenizeIntent, hasRepeatCue, summarizeIntent, tokenOverlap, MAX_INTENT_CHARS } = await import("../agent/memory/intent.js");

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  PASS  ${name}`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  FAIL  ${name} — ${err.stack || err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || "assertion failed");
}

function memory(id, host, text, { state = "fresh", confirmed = 1000 } = {}) {
  return {
    id,
    host,
    intent: { text, tokens: tokenizeIntent(text) },
    steps: [{ index: 1, tool: "find", args: { query: "x" } }],
    stats: { useCount: 0, lastUsedAt: null, lastConfirmedAt: confirmed, state }
  };
}

const TENDER = memory("mem_tender", "dauthau.asia", "phân tích TBMT có nơi thực hiện tại Hải Phòng");
const DOWNLOAD = memory("mem_download", "dauthau.asia", "tải hồ sơ mời thầu của gói thầu mới nhất");
const OTHER_SITE = memory("mem_other", "muasamcong.mpi.gov.vn", "phân tích TBMT có nơi thực hiện tại Hải Phòng");

console.log("\n== intent tokens ==");

await test("tokens keep Vietnamese diacritics, fold case and punctuation, drop filler", () => {
  const tokens = tokenizeIntent("Phân tích TBMT, có nơi thực hiện tại Hải Phòng giúp mình nhé!");
  assert(tokens.includes("phân") && tokens.includes("tbmt") && tokens.includes("hải") && tokens.includes("phòng"), tokens.join(" "));
  assert(!tokens.includes("giúp") && !tokens.includes("mình") && !tokens.includes("nhé"), tokens.join(" "));
});

await test("repeat cues are recognized in both languages and whole-phrase only", () => {
  assert(hasRepeatCue("làm lại như lần trước nhé"));
  assert(hasRepeatCue("Tìm giống hôm qua"));
  assert(hasRepeatCue("do it again"));
  assert(!hasRepeatCue("tìm lại lịch sử đơn hàng") || hasRepeatCue("tìm lại lịch sử đơn hàng") === false, "a stray 'lại' alone is not a cue");
  assert(!hasRepeatCue("phân tích TBMT"));
});

await test("an intent summary is bounded and marked when shortened", () => {
  const long = "tìm ".repeat(100);
  const summary = summarizeIntent(long);
  assert(summary.length <= MAX_INTENT_CHARS && summary.endsWith("…"), summary);
  assert(summarizeIntent("  ") === null);
});

await test("token overlap is Jaccard and 0 for an empty side", () => {
  assert(tokenOverlap(["a", "b"], ["a", "b"]) === 1);
  assert(tokenOverlap(["a", "b"], ["b", "c"]) === 1 / 3);
  assert(tokenOverlap([], ["a"]) === 0);
});

console.log("\n== recall ==");

await test("the same kind of request on the same site recalls the matching memory", () => {
  const { candidates } = recallForRun({
    memories: [TENDER, DOWNLOAD, OTHER_SITE],
    host: "dauthau.asia",
    request: "phân tích các TBMT thực hiện tại Hải Phòng"
  });
  assert(candidates.length === 1 && candidates[0].memory.id === "mem_tender", JSON.stringify(candidates.map((c) => [c.memory.id, c.score])));
  assert(candidates[0].score >= RECALL_MIN_SCORE && candidates[0].why === "intent_match");
});

await test("same words on a different site recall nothing", () => {
  const { candidates } = recallForRun({ memories: [OTHER_SITE], host: "dauthau.asia", request: "phân tích TBMT tại Hải Phòng" });
  assert(candidates.length === 0, JSON.stringify(candidates));
});

await test("a different task on the same site recalls nothing", () => {
  const { candidates } = recallForRun({ memories: [TENDER], host: "dauthau.asia", request: "đăng ký tài khoản mới" });
  assert(candidates.length === 0, JSON.stringify(candidates));
});

await test("an explicit repeat cue offers the best site match even below the threshold", () => {
  const { candidates } = recallForRun({ memories: [TENDER, DOWNLOAD], host: "dauthau.asia", request: "làm lại như lần trước" });
  assert(candidates.length === 1 && candidates[0].why === "explicit_repeat", JSON.stringify(candidates));
});

await test("stale memories are never offered, not even on an explicit repeat", () => {
  const stale = memory("mem_stale", "dauthau.asia", "phân tích TBMT có nơi thực hiện tại Hải Phòng", { state: "stale" });
  assert(recallForRun({ memories: [stale], host: "dauthau.asia", request: "phân tích TBMT Hải Phòng" }).candidates.length === 0);
  assert(recallForRun({ memories: [stale], host: "dauthau.asia", request: "làm lại như lần trước" }).candidates.length === 0);
});

await test("at most three candidates, ordered by score then recency, deterministically", () => {
  const many = [1, 2, 3, 4, 5].map((n) => memory(`mem_m${n}`, "dauthau.asia", "phân tích TBMT Hải Phòng", { confirmed: n }));
  const first = recallForRun({ memories: many, host: "dauthau.asia", request: "phân tích TBMT Hải Phòng" }).candidates;
  const second = recallForRun({ memories: [...many].reverse(), host: "dauthau.asia", request: "phân tích TBMT Hải Phòng" }).candidates;
  assert(first.length === MAX_CANDIDATES, `${first.length}`);
  assert(first.map((c) => c.memory.id).join() === "mem_m5,mem_m4,mem_m3", first.map((c) => c.memory.id).join());
  assert(JSON.stringify(first) === JSON.stringify(second), "input order does not change the answer");
});

await test("host matching is exact and normalized — no subdomain wildcard", () => {
  const sub = memory("mem_sub", "www.dauthau.asia", "phân tích TBMT Hải Phòng");
  assert(recallForRun({ memories: [sub], host: "dauthau.asia", request: "phân tích TBMT Hải Phòng" }).candidates.length === 0);
  assert(recallForRun({ memories: [TENDER], host: "DAUTHAU.ASIA.", request: "phân tích TBMT Hải Phòng" }).candidates.length === 1);
});

await test("no bound host recalls nothing", () => {
  assert(recallForRun({ memories: [TENDER], host: null, request: "phân tích TBMT" }).candidates.length === 0);
});

await test("measured: an unaccented request does not match an accented memory (diacritics are not folded)", () => {
  const { candidates } = recallForRun({ memories: [TENDER], host: "dauthau.asia", request: "phan tich TBMT thuc hien tai Hai Phong" });
  const score = tokenOverlap(tokenizeIntent("phan tich TBMT thuc hien tai Hai Phong"), TENDER.intent.tokens);
  assert(score < RECALL_MIN_SCORE && candidates.length === 0, `score ${score}`);
});

const failed = results.filter((r) => !r.ok);
console.log(failed.length ? `\n${failed.length} FAILED` : `\nALL ${results.length} TASK MEMORY RECALL TESTS PASSED`);
process.exit(failed.length ? 1 : 0);
