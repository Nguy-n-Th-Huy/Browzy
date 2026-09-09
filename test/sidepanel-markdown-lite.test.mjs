#!/usr/bin/env node
// markdown-lite.js has two jobs, and this file holds both to the same bar.
//
// SAFETY: it must escape ALL untrusted input before applying any formatting.
// Page and tool content flows into the transcript (get_page_text/read_page
// results, the model quoting a page verbatim) and must never become live
// HTML. That is a security property, not a rendering nicety, and none of the
// formatting below is allowed to erode it.
//
// FORMATTING: it must actually render what the model actually writes.
// Answers used to arrive in the panel as one undifferentiated paragraph —
// headings showing as literal `###`, GFM tables as rows of pipes, list
// markers and quote carets as raw punctuation — even though
// extension/ui/prose.css already styles every one of those elements. Nothing
// was producing them.
//
// Run: node test/sidepanel-markdown-lite.test.mjs

import { renderMarkdownLite, renderPlainEscaped, escapeHtml } from "../extension/sidepanel/markdown-lite.js";

let fail = 0;
function ok(cond, msg) {
  console.log((cond ? "  PASS " : "  FAIL ") + msg);
  if (!cond) fail++;
}
// The diagnostic tail is appended only on failure, so a passing run reads as
// a list of behaviours rather than a wall of HTML.
const detail = (label, needle, html) => `\n         ${label}: ${needle}\n         in: ${html.slice(0, 400)}`;
const has = (html, needle, msg) =>
  ok(html.includes(needle), html.includes(needle) ? msg : msg + detail("looked for", needle, html));
const lacks = (html, needle, msg) =>
  ok(!html.includes(needle), !html.includes(needle) ? msg : msg + detail("must not contain", needle, html));

console.log("== untrusted content is never inserted as live HTML ==");
{
  const hostile = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  const html = renderMarkdownLite(hostile);
  ok(!html.includes("<img"), "a raw <img> tag from page content never survives unescaped");
  ok(!html.includes("<script>"), "a raw <script> tag from page content never survives unescaped");
  ok(html.includes("&lt;img") && html.includes("&lt;script&gt;"), "the hostile markup is shown as literal escaped text instead");

  const plain = renderPlainEscaped(hostile);
  ok(!plain.includes("<img") && !plain.includes("<script>"), "renderPlainEscaped also never emits live tags");
}
// Every block construct escapes its own content — a table cell, a heading and
// a list item are not exceptions to the rule above.
has(renderMarkdownLite("| a |\n| --- |\n| <b>x</b> |"), "&lt;b&gt;x&lt;/b&gt;", "a table cell escapes HTML like everywhere else");
has(renderMarkdownLite("# <b>x</b>"), "<h1>&lt;b&gt;x&lt;/b&gt;</h1>", "so does a heading");
has(renderMarkdownLite("- <b>x</b>"), "<li>&lt;b&gt;x&lt;/b&gt;</li>", "so does a list item");
has(renderMarkdownLite("> <b>x</b>"), "&lt;b&gt;x&lt;/b&gt;", "so does a blockquote");

console.log("== links: only http(s) and mailto ever become clickable ==");
{
  const html = renderMarkdownLite("[chi tiết](https://dauthau.asia/thongbao/moithau/goi-so-03.html)");
  has(
    html,
    '<a href="https://dauthau.asia/thongbao/moithau/goi-so-03.html" target="_blank" rel="noopener noreferrer">chi tiết</a>',
    "an https link becomes an anchor that opens out of the panel"
  );
}
has(renderMarkdownLite("[mail](mailto:a@b.co)"), '<a href="mailto:a@b.co"', "mailto is allowed too");
{
  const html = renderMarkdownLite("[click](javascript:alert(1))");
  lacks(html, "<a ", "a javascript: URL never becomes an anchor");
  has(html, "javascript:alert(1)", "it is shown as the literal text it is");
}
{
  const html = renderMarkdownLite("[x](data:text/html,<script>alert(1)</script>)");
  lacks(html, "<a ", "a data: URL never becomes an anchor");
  lacks(html, "<script>", "and its payload is escaped, not embedded");
}

console.log("== headings, rules, paragraphs ==");
{
  const html = renderMarkdownLite("# One\n\n## Two\n\n### Three\n\n#### Four");
  has(html, "<h1>One</h1>", "# renders an h1");
  has(html, "<h2>Two</h2>", "## renders an h2");
  has(html, "<h3>Three</h3>", "### renders an h3");
  has(html, "<h4>Four</h4>", "#### renders an h4");
  lacks(html, "#", "no literal hash survives into the output");
}
has(renderMarkdownLite("##### Five"), "<p>##### Five</p>", "h5 is outside prose.css's range, so it stays plain text rather than rendering unstyled");
has(renderMarkdownLite("a\n\n---\n\nb"), "<hr>", "--- renders a thematic break");
has(renderMarkdownLite("first\nsecond"), "first<br>second", "a soft line break inside a paragraph is kept as <br>");
{
  const html = renderMarkdownLite("Xin chào **bạn**, đây là `code` và một đoạn văn khác.\n\nĐoạn hai.");
  ok(html.includes("<strong>bạn</strong>"), "bold renders");
  ok(html.includes("<code>code</code>"), "inline code renders");
  ok(html.split("<p>").length - 1 === 2, "blank-line-separated text becomes two paragraphs");
}
has(renderMarkdownLite("**bold** and *italic*"), "<em>italic</em>", "* renders italic");
{
  const html = renderMarkdownLite("`a * b * c` stays literal");
  has(html, "<code>a * b * c</code>", "asterisks inside a code span are not treated as emphasis");
  lacks(html, "<em>", "so no stray em is produced from them");
}

console.log("== GFM pipe tables ==");
{
  const html = renderMarkdownLite(
    "| Thông tin | Chi tiết |\n| :--- | :--- |\n| Mã TBMT | IB2600505709-00 |\n| Tỉnh/Thành | Thái Nguyên |"
  );
  has(html, '<div class="table-wrap">', "a table is wrapped in .table-wrap, which prose.css scrolls a wide one inside");
  has(html, "<thead><tr><th>Thông tin</th><th>Chi tiết</th></tr></thead>", "the header row becomes thead/th");
  has(html, "<td>Mã TBMT</td><td>IB2600505709-00</td>", "body rows become td");
  has(html, "<td>Thái Nguyên</td>", "every body row is rendered, not just the first");
  lacks(html, "|", "no literal pipe survives into the output");
}
has(
  renderMarkdownLite("| a | b |\n| --- | --- |\n| only-one |"),
  "<td>only-one</td><td></td>",
  "a row short of cells is padded to the header width rather than shifting the columns"
);
has(
  renderMarkdownLite("cost | benefit was the tradeoff"),
  "<p>cost | benefit was the tradeoff</p>",
  "a sentence containing a pipe is prose, not a table — a delimiter row is required"
);

console.log("== lists ==");
has(renderMarkdownLite("1. CÔNG TY A\n2. CÔNG TY B"), "<ol><li>CÔNG TY A</li><li>CÔNG TY B</li></ol>", "an ordered list renders as ol/li");
has(renderMarkdownLite("- one\n- two"), "<ul><li>one</li><li>two</li></ul>", "a bullet list renders as ul/li");
has(
  renderMarkdownLite("- outer\n  - inner\n- outer again"),
  "<ul><li>outer<ul><li>inner</li></ul></li><li>outer again</li></ul>",
  "an indented item nests inside its parent item"
);
{
  const html = renderMarkdownLite("- bullet\n\n1. number");
  has(html, "<ul><li>bullet</li></ul>", "a bullet run closes as a ul");
  has(html, "<ol><li>number</li></ol>", "and the numbered run after it opens its own ol");
}

console.log("== blockquotes ==");
{
  const html = renderMarkdownLite("> Lưu ý: cần **đăng nhập**.\n> Dòng thứ hai.");
  has(html, "<blockquote>", "a > line renders as a blockquote");
  has(html, "<strong>đăng nhập</strong>", "and its contents are still inline-formatted");
  has(html, "Dòng thứ hai", "a multi-line quote keeps every line");
  lacks(html, "&gt;", "the quote marker itself is consumed, not shown");
}
has(
  renderMarkdownLite("> - a\n> - b"),
  "<blockquote><ul><li>a</li><li>b</li></ul></blockquote>",
  "a quote renders its contents recursively, so it can hold a list"
);

console.log("== fenced code blocks are never markdown-interpreted inside ==");
{
  const html = renderMarkdownLite("```js\nconst x = **not bold** in code;\n```");
  ok(html.includes("<pre><code"), "a fenced block becomes <pre><code>");
  ok(html.includes("**not bold**"), "content inside a fence is shown literally, not further interpreted as markdown");
  ok(!html.includes("<strong>"), "no bold tag leaks out of a fenced block");
}
{
  const html = renderMarkdownLite("intro\n\n```js\n# not a heading\n| not | a table |\n```\n\nafter");
  has(html, '<pre><code class="lang-js">', "a language-tagged fence keeps its lang class");
  lacks(html, "<h1>", "no heading is produced from fenced content");
  lacks(html, "<table>", "and no table either");
  has(html, "<p>intro</p>", "text before the fence still renders");
  has(html, "<p>after</p>", "and so does text after it");
}
has(renderMarkdownLite("```\nunclosed"), "<pre><code>unclosed</code></pre>", "an unclosed fence still renders rather than silently swallowing the rest");

console.log("== escapeHtml is a strict character-level escape ==");
{
  ok(escapeHtml(`&<>"'`) === "&amp;&lt;&gt;&quot;&#39;", "every reserved character is escaped");
  ok(escapeHtml(null) === "" && escapeHtml(undefined) === "", "null/undefined degrade to empty string, never throw or print 'null'");
  ok(renderPlainEscaped("<b>\nx") === "&lt;b&gt;<br>x", "renderPlainEscaped applies no inline formatting at all");
  ok(renderMarkdownLite("") === "" && renderMarkdownLite(null) === "", "empty and null input render to nothing");
}

console.log("== a whole real answer, end to end ==");
{
  const html = renderMarkdownLite(
    [
      "### IB2600505709-00 - Gói số 03 Thi công xây dựng công trình",
      "",
      "| Thông tin | Chi tiết |",
      "| :--- | :--- |",
      "| Mã TBMT | IB2600505709-00 |",
      "| Tỉnh/Thành | Thái Nguyên |",
      "",
      "Đơn vị tư vấn đã tham gia:",
      "1. CÔNG TY TNHH AN TÂM PHÁT BK",
      "2. CÔNG TY CP XÂY DỰNG BẮC KẠN",
      "",
      "> Lưu ý: DauThau.info yêu cầu Đăng nhập để xem đầy đủ thông tin."
    ].join("\n")
  );
  has(html, "<h3>", "the heading renders");
  has(html, "<table>", "the table renders");
  has(html, "<ol>", "the numbered list renders");
  has(html, "<blockquote>", "the note renders as a quote");
  lacks(html, "###", "and none of the markup leaks through as literal text");
}

console.log(fail === 0 ? "\nALL SIDEPANEL MARKDOWN-LITE TESTS PASSED" : `\n${fail} FAILED`);
process.exit(fail ? 1 : 0);
