# Design: a Jev run's answer analyses instead of transcribing

> Builds on `jev-runs-answer-the-operator` (the final report) and
> `improve-jev-step-reasoning` (the evaluation, the element table). Rebase the
> delta if those archive after this one.

## 1. The sentence that caused it

```
Report ONLY what the provided material shows.
Never invent a result, a page, a number, or a step that is not there.
```

Read as an instruction by a model asked to analyse, that says: restate. It is doing what it was told.

The rule it was meant to express is narrower and is the one worth keeping: **a factual claim must be traceable to the material.** What it accidentally also forbade is derivation — and derivation is the whole of analysis. "35 of 42 is 83.3%" invents nothing. "28 of 42 packages are in one province, so this contractor is concentrated there" invents nothing either; it names a fact and states what follows.

So the instruction gains a distinction rather than a relaxation:

- a **fact** is a value the material shows — it may be quoted or restated, never altered, and never produced when the material does not show it;
- an **inference** is a ratio, a comparison, a trend, a risk or a judgment the facts support — it is allowed, it must be recognisable as the answer's own reasoning rather than as something the page said, and it must rest on facts the answer names;
- what stays forbidden, in exactly the words it is forbidden today: claiming an outcome the run did not reach, and reporting a value the material does not contain.

The phrase that does the work: *do not report what the page did not show; do say what the facts you have add up to, and name the facts you used.*

## 2. What the answer gets to look at

Today the report's context is the last observation plus the memory notes plus ten action rows. A run that walked a listing → a filter → a detail page can only report the detail page.

**The run accumulates observations.** Each successful observation contributes one bounded record — page identity plus bounded text — to a per-run list. The list has its own byte budget, and when it does not fit, the **oldest** records are dropped first (the newest pages are the ones an answer is usually about) with the omission disclosed in the context, exactly as the element table's ladder already does.

Two properties worth pinning:

- **Deduplicate by page identity + text**: a run that observes the same unchanged page six times while hovering a menu must contribute one record, not six. Without this the budget is spent on repeats of one page — precisely what a stalled run produces.
- **The accumulation is material, never memory**: it is not the run's `notes`, it is not summarised by any model, and nothing in it steers a decision. It exists so the answer can look back at pages the run has left.

The step decision keeps carrying the **current** observation only. It decides what to do next on the page in front of it; giving it a scrollback of earlier pages would grow every request in the loop for no decision it has to make. The accumulation is read by the report, once.

## 3. Length follows the goal, not a constant

`MAX_REPORT_CHARS = 4000` is one bound for two different things: a sentence confirming a click, and an assessment of a company.

The decision model already separates the two — `NEXT_STEP` tells it to answer `DONE` for an informational goal "once the gathered material is enough for the requested analysis". The same distinction drives the answer:

| the goal asked for | bound | shape |
|---|---|---|
| an action on the page | today's bound | today's order: what was accomplished, what was not, why |
| analysis, a report, an assessment | a larger bound, sized for an assessment | conclusion first, then evidence, then what could not be established |

**Who decides which kind it is**: the completion check and the final report are told the run's goal; the instruction asks them to answer in the shape the goal asked for. The host does not classify goals with a keyword list — a rule that would mis-file "kiểm tra giúp tôi trang này có gì" in either direction. The bound is the larger of the two by default and the instruction is what keeps an action answer short; a short answer costs nothing extra because output is billed and timed by what is written, not by the ceiling.

That last point is the reason this is safe to do with one raised ceiling instead of two code paths: the 8,945 ms the operator's run spent writing 2,949 characters was spent on the characters, not on the limit.

## 4. What does not change

- No new call, no new event, no change to the loop, the guards, the bounds, the dispatch discipline or the approval gate.
- The completion check keeps its verdict job; only the wording of what its report may contain changes.
- The report stays advisory: a failure leaves the outcome exactly as it was, disclosed, never replaced by host-written prose.
- A `typesafe` profile's settings surface is untouched.

## 5. Verification

- Unit: the accumulation respects its budget, drops oldest first, deduplicates an unchanged page, and discloses omissions; the report's context carries it.
- Instruction: the fact/inference distinction is present verbatim in both instructions, and the "never claim an outcome the run did not reach" sentence survives unchanged.
- Runtime: a run that observed three distinct pages produces a report whose context contains all three; a run that observed one page six times contributes one record.
- Judgment (the only way to test the actual outcome): re-run the analysis goal that produced the transcription, on the same page, and compare. The bar is not length — it is whether the answer states a conclusion and names the facts under it.
