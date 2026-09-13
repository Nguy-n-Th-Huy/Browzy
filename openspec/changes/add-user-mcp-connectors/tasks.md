## 1. Catalog and persistence

- [ ] 1.1 Add connector catalog persistence following the existing atomic-store and profile-store patterns: name, transport, source, enabled state.
- [ ] 1.2 Add, inspect, enable, disable and remove operations over that catalog, exposed to the settings UI through the existing settings op channel.
- [ ] 1.3 Make adding inert: record configuration without starting the connector or executing anything from it.
- [ ] 1.4 Contact the connector only on inspect or enable, and record the tools it advertises for display.
- [ ] 1.5 Reject an invalid configuration, a duplicate name, or a connector that cannot be contacted on inspection, with a specific reason, leaving the existing catalog unchanged.
- [ ] 1.6 Make removal drop the connector's stored credential along with its entry. ← (verify: adding a connector and never enabling it starts no process and opens no connection)

## 2. Credentials

- [ ] 2.1 Store a connector credential through the same OS credential-store path the provider credential uses.
- [ ] 2.2 Clear the raw value after submission; show only whether a credential is saved.
- [ ] 2.3 Keep connector credentials out of diagnostics, exported settings, logs, command-line arguments, and extension storage.
- [ ] 2.4 Fail persistence explicitly when secure storage is unavailable and offer a clearly labeled memory-only mode.
- [ ] 2.5 Make calls requiring a removed credential fail with a specific reason until a new one is entered. ← (verify: no connector credential appears anywhere in diagnostics or an exported settings file)

## 3. Exposure to a run

- [ ] 3.1 Pass enabled connectors to the SDK alongside this product's own browser server, keyed so the tool list and the server map cannot drift apart.
- [ ] 3.2 Keep connector tools out of `allowedTools` deliberately, so they reach the permission path instead of being auto-approved before it. Record the reason where the option is built.
- [ ] 3.3 Namespace every connector tool by its connector.
- [ ] 3.4 Resolve a name collision with a browser operation in favour of the browser operation, keep the connector's tool reachable under its namespaced name, and surface the collision.
- [ ] 3.5 Keep two connectors advertising the same tool name distinguishable and independently callable.
- [ ] 3.6 Give connector tools an explicit conservative classification, matching the precedent for tools whose side effects are unknowable in advance.
- [ ] 3.7 Exclude connector tools from browser-registry baseline accounting, so they neither satisfy a missing baseline operation nor appear as an unaccounted-for discrepancy.
- [ ] 3.8 Refuse a call to a disabled connector by name without contacting it, including when it is disabled mid-run. ← (verify: a connector advertising a tool named like a browser operation cannot be reached under that name, and the browser operation still resolves to itself)

## 4. Failure containment

- [ ] 4.1 Bound every connector call so an unreachable or hung connector resolves rather than staying outstanding.
- [ ] 4.2 Make timeout, refusal, unreachable, and successful-empty outcomes distinguishable from each other.
- [ ] 4.3 Report malformed output as malformed instead of passing it on as valid content.
- [ ] 4.4 Isolate connectors from each other and from the browser tools, so one failing connector affects neither. ← (verify: with one connector failing, browser tools and a second connector are unaffected and the run stays usable)

## 5. Boundaries a connector cannot cross

- [ ] 5.1 Ensure a connector cannot change provider settings, obtain a credential, change the permission mode, alter a remembered permission decision, expand the run's tab scope, or enable another connector — and surface any attempt.
- [ ] 5.2 Treat connector-returned content as untrusted external data that never authorizes an action and never resolves a pending decision.
- [ ] 5.3 Route connector-returned content through the injection probe on the same terms as page content, warning without blocking. ← (verify: text in a connector result that reads as an approval resolves no pending decision, and an attempted settings or scope change from a connector takes no effect)

## 6. Panel surfaces

- [ ] 6.1 Add the connector catalog UI in settings, alongside the existing skills catalog.
- [ ] 6.2 Identify connector tool calls in the action timeline by their connector, distinguishable from browser actions and from other connectors.
- [ ] 6.3 Show a connector call's failure, timeout, or disabled refusal with its specific reason rather than as a generic tool failure.
- [ ] 6.4 Display connector-returned content as quoted data so markup or instructions inside it are neither rendered nor acted on. ← (verify: a timeline built from a mixed run attributes every entry to the right source)

## 7. Documentation

- [ ] 7.1 Document how to add a connector, that adding does not start it, and that only an enabled connector reaches a run.
- [ ] 7.2 Document where connector credentials are stored and what never contains them.
- [ ] 7.3 Document the boundaries a connector cannot cross, and that connector output is treated as untrusted content.
