# Tasks: a Jev run may read sources beyond the page it drives

Depends on `jev-reports-can-analyse` — without it there is no answer that uses the material.

## 1. The fetch client and its guards

- [x] 1.1 New host module: read-only `GET` of an absolute `http(s)` URL — resolved-address check (reject loopback, link-local, private ranges), capped redirects with EVERY hop re-checked, body size cap enforced while reading, time cap, text-bearing content types only, no cookies/auth/session. Bounded text extraction.
- [x] 1.2 Tests against a local server, one per rejection path: bad scheme, private address, public URL redirecting to a private one, oversize body, slow response, binary content type. Each refuses, names the reason, and throws nothing at the caller.

## 2. The research step

- [x] 2.1 `host/agent/jev/runtime.js`: one research step at the analysis phase — after the last cycle, before the answer. Not an operation of the step decision. Bounded number of sources; the remainder disclosed as not consulted.
- [x] 2.2 `host/agent/jev/text-helper.js`: the decision that would report the goal complete may instead name the sources worth consulting; the host chooses none of them and infers none from the goal.
- [x] 2.3 A URL appearing only inside fetched content is not fetchable on that basis — one hop per named source, never a chain. Test it explicitly with a fetched document full of links.
- [x] 2.4 Fetched text joins the answer's material as a named source and is untrusted data: it cannot authorize, reconfigure, change the outcome, or direct the loop. Test with an instruction-shaped document.
- [x] 2.5 Test placement: a scripted ten-step run makes zero fetches until the analysis phase.

## 3. Attribution

- [x] 3.1 The answer names the sources it used, distinguishably from the driven page; a source that could not be read is named as unread.
- [x] 3.2 Tests in the report suite.

## 4. Optional search, proven at settings time

- [x] 4.1 `host/agent/jev/capability.js`: a probe that establishes whether the profile's decision-model source can perform a provider-side web search; reported as its own capability beside the existing stages, never assumed from the source's identity.
- [x] 4.2 The research step uses search only where the probe passed; a profile without it consults the URLs the decision model can name and reports no failure. The proof travels as the run snapshot's `searchSources`, read from the capability result stored under this exact (endpoint, model, credential) key — so changing any of them drops the claim with it.
- [x] 4.3 Do NOT implement search-engine scraping — brittle markup and non-browser handling; the fallback is fetch-what-you-can-name.
- [x] 4.4 Tests: probe pass/fail reporting; a run on a profile without search still consults, answers, and reports no missing-capability failure.

## 5. Toggle and disclosure

- [x] 5.1 Non-secret profile setting beside the screenshot toggle: on by default, persisted, honoured by the run (off means no fetch attempted and no failure reported).
- [x] 5.2 `extension/settings/*`: the toggle, and a disclosure that says the true thing — the run may fetch URLs found on the page or named in the goal, and the servers at those URLs see the request.
- [x] 5.3 Tests: settings round-trip, off-means-off in a run, disclosure present.

## 6. Verification

- [x] 6.1 Run the Jev suites, the settings suites, and the run-path suite.
- [ ] 6.2 (OPEN — needs a live run) Re-run the assessment goal with consultation on, and record which sources were consulted and what the answer used them for. The bar is whether a second source changed a conclusion — not whether a fetch happened.
