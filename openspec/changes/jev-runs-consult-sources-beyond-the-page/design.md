# Design: a Jev run may read sources beyond the page it is driving

> Builds on `jev-reports-can-analyse` (the answer's material and its licence to
> infer). Without that change this one has somewhere to put the material and no
> answer that uses it.

## 1. Where it happens, and why that placement is the whole design

```
observe → decide → act → observe → decide → act → … → [research] → answer
                                                        ↑ once
```

The research step sits between the run's last cycle and its answer. It is **not** an operation the step decision can choose, and that is deliberate:

- a per-cycle fetch would put a network round trip inside a loop whose per-step cost the operator explicitly values (a step is ~6 s today, of which Jev is 1.1 s);
- a loop that can fetch will fetch while it still has browsing to do, and each fetched page is new material for the next decision — the failure mode is a run that reads instead of acting;
- the material is wanted for the *answer*, and the answer is written once.

So: one research step, bounded in the number of sources it may consult, reached only when the run is about to write an answer that needs them.

**Who decides that it is needed**: the decision model, in the same call that would otherwise answer `DONE` — it names the sources worth consulting, or names none. Not a host heuristic, and not a keyword test on the goal.

## 2. Fetching, and the guards that make it safe

A fetch is an ordinary read: `GET` an absolute `http(s)` URL, follow a bounded number of redirects, read a bounded body of a text-bearing type, extract bounded text. Every one of those words is a guard:

| guard | rule | why |
|---|---|---|
| scheme | `http`/`https` only | `file:`, `data:`, `chrome-extension:` and the rest are not documents on the web |
| address | reject loopback, link-local, and private ranges, **resolved**, not merely as written | the companion runs on the operator's machine, beside their LAN and their own services; `http://192.168.1.1/` is not a source |
| redirects | capped, and **every hop re-checked** against the same rules | a public URL that redirects to `127.0.0.1` is the classic way past a check performed once |
| size | capped body, enforced while reading | not after, or the cap is decoration |
| time | capped, with the whole step bounded too | a slow server must not hold a run |
| content type | text-bearing only | a PDF, an image or a binary is not text this path can honestly extract |
| credentials | none: no cookies, no auth headers, no session | the run is reading a public document, not acting as the operator |

What is fetched is **data** on exactly the terms page text already is: it cannot authorize anything, cannot change configuration, cannot alter the run's outcome, cannot direct the loop. One addition specific to this path: **a URL discovered inside fetched content is not automatically fetchable.** Otherwise a hostile page could walk the run through an arbitrary chain of requests. A source is consulted because the decision model named it, from the page or the goal — one hop, named deliberately, not a crawl.

## 3. Search: proven, not assumed

Search needs a source of results, and this loop has no privileged one. Two mechanisms exist, with different dependencies:

- **provider-side search** — the decision-model source performs the search itself as part of the request. It is the cheapest (no separate round trip) and the most capable, and it exists only where that source supports it. The operator's own profile points at a proxy whose support is unknown.
- **fetching a search engine** — provider-independent, and brittle in the way scraping always is: result markup changes, and engines answer non-browser clients differently.

The decision: **support provider-side search when the profile's capability test proves it, and do not implement engine scraping.** A profile without search still fetches the URLs the run can name — which in the case that motivated this change covers the company's own site, printed on the page the run was reading.

This keeps one promise the provider already makes elsewhere: a capability the profile cannot perform is discovered at settings time, with a named result, rather than at the moment a run needs it.

## 4. Attribution

An answer that used fetched material names its sources, and a claim drawn from one is attributable to it. This is not decoration: the fact/inference rule from `jev-reports-can-analyse` requires facts to trace to material, and once material comes from more than one place, "the material" is no longer a single thing. The answer that motivated all of this ends with a Sources list for exactly that reason.

## 5. The toggle, and what the operator is told

One non-secret profile setting, beside the screenshot toggle, with the same shape: on by default, persisted, and honoured by the run.

The disclosure has to say the true thing, which is not "the assistant may browse the web": it is that **the run may fetch URLs it found on the page, or that the goal named, and the servers at those URLs will see the request** — including its timing, and the fact that someone is interested in that page. An operator analysing a competitor should know that the competitor's own site may receive a request while they do it.

## 6. What this is not

- **Not new browser operations.** Nothing navigates, clicks, opens a tab, or renders. The bound tab is untouched, the approval gate is untouched, and `runHostSideChecks` has nothing to check here because nothing is dispatched.
- **Not a crawler.** One hop per named source, a bounded number of sources, once per run.
- **Not a document store.** Fetched text is material for one answer. It is not saved, not indexed, and not carried into another run.
- **Not for the SDK runtimes.** They already have their own web tools; this exists because the Jev loop does not.

## 7. Verification

- Every rejection path, against a local server: scheme, private address, a redirect to a private address, an oversize body, a slow response, a binary content type, and a URL that appeared only inside fetched content.
- Placement: a run's fetches happen after its last cycle and never between two steps; a scripted run that browses ten steps makes zero fetches until the analysis phase.
- Bound: a decision naming more sources than the bound allows consults the bound's worth and discloses the rest as not consulted.
- Attribution: an answer that used a fetched source names it; one that used none names none.
- Toggle: off means no fetch is attempted and the answer is written from the page alone, with no failure reported.
- Search: the capability probe reports availability for the profile's decision-model source; a profile without it runs, fetches, and answers.
