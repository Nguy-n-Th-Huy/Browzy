# Proposal: a Jev run may read sources beyond the page it is driving

## Why

The assessment the operator wants cites four sources: the listing site being driven, the company's own website, a construction-capability registry, and a tax lookup. Three of them were never open in the browser. The `anthropic` profile reached them with the SDK's own web tools — **one tab, no extra navigation**, the content fetched outside the browser entirely.

The Jev loop has no equivalent. It drives one bound tab through ten operations and writes its answer from what that tab showed. Every conclusion that needs a second source is out of reach, and the two most interesting observations about that contractor came from second sources: the registered business lines contradicting the actual tender history, and the vendor partnerships the company's own site claims.

The gap is smaller than it looks. In that very example, **`http://www.ktd.vn` was printed on the page the run was already reading.** A run that can fetch a URL it can see closes much of the distance without any search at all.

What this is not: a request for more browser operations. Nothing here navigates, clicks, opens a tab, or touches the page. It is a read of a document, performed by the companion, whose text becomes material for the answer.

## What Changes

- **A bounded research step, once per run.** When the goal calls for material the driven page does not hold, the run may consult sources outside it — **at the analysis phase, never inside the step loop.** The browsing cycle's cost is unchanged; the consultation happens once, on the way to the answer.
- **Fetch is the capability.** The companion performs an ordinary read-only HTTP GET of an absolute `http(s)` URL, extracts bounded text, and adds it to the run's material as a named source. It never executes anything, never sends credentials or cookies, and never touches the browser, the page, or the bound tab.
- **Search is optional and proven, never assumed.** Where the profile's decision-model source can perform a provider-side web search, the run may use it; where it cannot, the run fetches the URLs it can name — from the page it is reading, or from the goal. The profile's capability test decides which, at settings time, so a run never discovers it mid-flight. A profile without search is fully functional, with a smaller reach.
- **Fetched content is untrusted data, with the same standing as page text.** It cannot authorize an action, change configuration, alter the run's outcome, direct the loop, or become a URL to fetch next without the decision model naming it. The fetch guards are the hard kind: absolute `http(s)` only, no loopback and no private address ranges, a redirect cap that re-checks every hop, a response size cap, a time cap, and text-bearing content types only.
- **Every source is named in the answer.** An answer that used a fetched source lists it. A claim drawn from one is attributable to it, exactly as a claim drawn from the page is attributable to the page.
- **The operator can turn it off,** and the settings disclosure states plainly that runs may fetch URLs found on the page or named in the goal, to third-party servers, and that those servers see the request.

## The decision this change makes on the operator's behalf

**Fetching is enabled by default.** The alternative — off until discovered — means the feature does not exist for anyone who does not read release notes, while the guards above are what actually bound the risk. The run already visits pages on the operator's behalf; fetching a URL printed on such a page is a smaller act than navigating to it, because nothing is rendered and no script runs. The toggle exists for the operator who disagrees, and the disclosure exists so the choice is informed rather than silent.

**Search is not enabled by default; it is enabled by proof.** It depends on the decision-model source and cannot be assumed — the operator's own profile points at a proxy endpoint whose support is unknown until tested. Probing it in the capability test is the same discipline this provider already uses for reasoning and image support.

## Cost

Measured on the operator's run of 19 September: a step costs ~6 s (4,563 ms decision, 1,145 ms selection, 165 ms dispatch); the answer call cost 8,945 ms for 2,949 characters.

A fetch is one HTTP GET — a few hundred milliseconds to about two seconds — plus the enlarged prompt of the call that reads it. Three sources land near **+3 to 6 seconds, once per run**. Nothing is added per step. The commitment that keeps it that way is in the design: research happens at the analysis phase and never inside the cycle.

## Capabilities

### New Capabilities

- `typesafe-jev-provider/source-consultation`: the bounded research step, the fetch guards, the untrusted-content rules, the optional proven search, source attribution in the answer, and the operator's toggle.

### Modified Capabilities

- `agent-settings`: the `typesafe` profile gains the consultation toggle and the disclosure of what is fetched and to where.

## Impact

- **New host module**: the fetch client and its guards (SSRF, redirect, size, time, content-type, text extraction).
- `host/agent/jev/runtime.js` — the research step at the analysis phase, its bound, and the sources it hands to the report.
- `host/agent/jev/text-helper.js` — the instruction that asks for the sources to consult and the answer's source attribution; the optional provider-side search parameter.
- `host/agent/jev/capability.js` — the probe that decides whether search is available for this profile.
- `host/agent/settings/*`, `extension/settings/*` — the toggle and the disclosure.
- Tests: fetch guards against a local server (every rejection path), the research step's bound and its placement outside the loop, attribution in the answer, and the capability probe.
