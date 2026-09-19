// URLs in an answer are evidence, not content the model may synthesize from
// identifiers. Keep complete destinations; a truncated URL is a different URL.
export const MAX_EVIDENCE_URL_CHARS = 8192;
export const MAX_REPORT_LINKS_BYTES = 24 * 1024;

export function evidenceUrl(value) {
  if (typeof value !== "string" || value.length > MAX_EVIDENCE_URL_CHARS || /\s/.test(value)) return null;
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function reportLinks(links) {
  const rows = [];
  const seen = new Set();
  let bytes = 2;
  let omitted = 0;
  for (const link of Array.isArray(links) ? links : []) {
    const url = evidenceUrl(link?.url);
    if (!url) { omitted++; continue; }
    if (seen.has(url)) continue;
    seen.add(url);
    const row = { url, label: String(link.label ?? "").slice(0, 200) };
    const size = Buffer.byteLength(JSON.stringify(row), "utf8") + 1;
    if (bytes + size > MAX_REPORT_LINKS_BYTES) { omitted++; continue; }
    bytes += size;
    rows.push(row);
  }
  return { ...(rows.length ? { links: rows } : {}), ...(omitted ? { links_omitted: omitted } : {}) };
}

// Covers bare URLs, Markdown destinations/autolinks and HTML hrefs. Strip
// prose punctuation and unbalanced closing parentheses, retaining parentheses
// inside actual URL paths and preserving query ordering/percent encodings.
export function urlsInText(text, known = null) {
  const urls = [];
  for (const match of String(text ?? "").matchAll(/https?:\/\/[^\s<>"'`\[\]\\]+/gi)) {
    const raw = match[0].replace(/&amp;/g, "&");
    const candidates = [raw];
    let value = raw.replace(/[.,;:!?]+$/, "");
    candidates.push(value);
    while (value.endsWith(")") && (value.match(/\)/g)?.length ?? 0) > (value.match(/\(/g)?.length ?? 0)) {
      value = value.slice(0, -1);
      candidates.push(value);
    }
    // A trailing !, ? or . can belong to a URL too. Prefer a complete known
    // destination before interpreting it as punctuation surrounding the link.
    const url = candidates.map(evidenceUrl).find((candidate) => known?.has(candidate)) ?? evidenceUrl(value);
    if (url) urls.push(url);
    else if (known) urls.push(raw);
  }
  return urls;
}

export function reportEvidence(user) {
  const known = new Set(urlsInText(user?.goal));
  for (const page of [user?.page, ...(user?.observed_pages ?? []), ...(user?.consulted_sources ?? [])]) {
    if (!page) continue;
    // An attempted fetch does not establish a document or a result URL. A
    // failed model-proposed source must not launder an invented destination.
    // URLs independently present on the observed page/goal remain in known.
    if (page.unread) continue;
    const url = evidenceUrl(page.url);
    if (url) known.add(url);
    for (const link of page.links ?? []) {
      const href = evidenceUrl(link.url);
      if (href) known.add(href);
    }
    for (const href of urlsInText(page.text)) known.add(href);
  }
  return known;
}

function decodeDestination(value) {
  return value.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~\\])/g, "$1")
    .replace(/&(?:amp|quot|apos|lt|gt|#\d+|#x[\da-f]+);/gi, (entity) => {
      const named = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">" };
      if (named[entity.toLowerCase()]) return named[entity.toLowerCase()];
      const code = entity[2].toLowerCase() === "x" ? parseInt(entity.slice(3, -1), 16) : parseInt(entity.slice(2, -1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : entity;
    });
}

// Read a Markdown destination by syntax rather than guessing URL prefixes.
// This covers relative names, angle destinations, escaped delimiters and
// balanced path parentheses. An optional quoted title is not part of the URL.
function markdownDestination(text, start) {
  let index = start;
  while (/\s/.test(text[index] ?? "") && index < text.length) index++;
  const angle = text[index] === "<";
  if (angle) index++;
  let value = "";
  let depth = 0;
  for (; index < text.length; index++) {
    const char = text[index];
    if (char === "\\" && index + 1 < text.length) { value += char + text[++index]; continue; }
    if (angle ? char === ">" : /\s/.test(char) || (char === ")" && depth === 0)) break;
    if (!angle && char === "(") depth++;
    if (!angle && char === ")") depth--;
    value += char;
  }
  return decodeDestination(value);
}

export function declaredDestinations(text) {
  const destinations = [];
  // Inline links/images. No scheme/path-prefix filtering: every declared
  // destination must pass the same complete observed-URL contract.
  for (let index = 0; index < text.length - 1; index++) {
    if (text[index] === "\\") { index++; continue; }
    if (text[index] === "]" && text[index + 1] === "(") destinations.push(markdownDestination(text, index + 2));
  }
  // Reference definitions are not currently clickable in markdown-lite, but
  // are still asserted destinations in exported/report text.
  for (const match of text.matchAll(/^\s{0,3}\[(?:\\.|[^\]\\\n])+\]:[ \t]*/gm)) destinations.push(markdownDestination(text, match.index + match[0].length));
  // HTML is escaped by the renderer. Validate its declared href/src too so
  // it cannot serve as an alternate spelling for a fabricated report link.
  for (const tag of text.matchAll(/<[a-z](?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
    for (const attr of tag[0].matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      destinations.push(decodeDestination(attr[1] ?? attr[2] ?? attr[3]));
    }
  }
  return destinations;
}

export function addSearchEvidence(json, known) {
  // Only provider tool-result/citation metadata is evidence. Assistant prose,
  // tool inputs, memory and prior answers cannot self-authorize a fabricated URL.
  for (const block of json?.content ?? []) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const result of block.content) {
        if (result.type !== "web_search_result") continue;
        const url = evidenceUrl(result.url);
        if (url) known.add(url);
      }
    }
    for (const citation of block.type === "text" ? block.citations ?? [] : []) {
      if (citation.type !== "web_search_result_location") continue;
      const url = evidenceUrl(citation.url);
      if (url) known.add(url);
    }
  }
}

export function groundReport(parsed, known) {
  if (!parsed.ok || typeof parsed.report !== "string") return parsed;
  const unsupported = urlsInText(parsed.report, known).filter((url) => !known.has(url));
  for (const destination of declaredDestinations(parsed.report)) {
    const url = evidenceUrl(destination);
    if (!url || !known.has(url)) unsupported.push(destination || "(empty destination)");
  }
  if (!unsupported.length) return parsed;
  return { ok: false, code: "INVALID_RESPONSE", message: `Report contains an unobserved URL: ${unsupported[0]}. Use only complete URLs from page.links, observed pages, consulted sources or actual search results. Never construct detail URLs from identifiers; omit unavailable links and disclose that limitation.` };
}
