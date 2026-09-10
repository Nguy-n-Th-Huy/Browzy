// WebMCP page-tool detector — MAIN-world content script.
//
// document.modelContext (WebMCP, W3C WebML CG, Chrome origin trial 149-156,
// expiring 2026-11-16) is a PAGE-CONTEXT object: it is only reachable from a
// script that runs in the page's own (MAIN) JS world, which is why this file
// exists as a separate script from the rest of the extension's content
// scripts — MAIN-world scripts cannot use chrome.* at all. It talks to
// extension/webmcp/relay-isolated.js (the ISOLATED-world half of this pair,
// which owns the chrome.runtime connection) over window.postMessage, under
// the WEBMCP_MARKER key below, per design.md decision 3.
//
// The overwhelmingly common case is that document.modelContext is undefined
// — the API is gated by an origin trial, not by browser version, so most
// visited pages never have it regardless of Chrome build. That case (and any
// failure while probing for the API) MUST be silent: no thrown error, no
// console output, no visible effect on the page. See the try/catch wrapping
// the whole body below.
//
// Declared at document_start (extension/manifest.json) deliberately: a
// registerTool wrapper installed any later would miss every tool a page
// registers synchronously as part of its own early script execution.
(function () {
  "use strict";

  var WEBMCP_MARKER = "browzy_webmcp_v1";

  try {
    if (typeof document === "undefined" || !document.modelContext) {
      return; // ordinary case — nothing here for this page
    }
  } catch (_e) {
    // Reading the accessor itself threw. Contained here, per spec's
    // "Detection failure does not break the page or the agent" — the page
    // and every other extension feature continue exactly as if the API
    // were simply absent.
    return;
  }

  try {
    var mc = document.modelContext;

    // name -> { name, description, inputSchema, execute }. This is this
    // script's OWN record of what has been registered, built purely by
    // observing calls through the wrapper below. It exists because
    // getTools() (the API's authoritative list) does not hand back the
    // execute callback — only this wrapper's snapshot can supply that, and
    // it is what the captured-callback fallback path (below) calls when the
    // browser exposes no executeTool entry point of its own.
    var registeredTools = new Map();

    function safeString(v) {
      return typeof v === "string" ? v : "";
    }
    // Accepts BOTH shapes deliberately. A page's own registerTool() call
    // (webmcp-types 0.1.7's ModelContextTool.inputSchema) passes a real
    // object, and that shape is passed through unchanged below. But
    // getTools()'s RETURNED RegisteredTool.inputSchema is documented by the
    // W3C spec's own serialization algorithm as a STRINGIFIED JSON Schema —
    // independently corroborated against real Chrome 150/153 builds by
    // third-party WebMCP integration testing (not verified against a
    // browser in THIS session; see design.md Decision 2's addendum for
    // sources) — so a string here is the ordinary case for the getTools()
    // path, not a malformed input, and must be parsed rather than collapsed
    // to an empty object. Always returns an object (or {} on failure),
    // never throws, per this file's own never-throw discipline.
    function safeSchema(v) {
      if (v && typeof v === "object") return v;
      if (typeof v === "string") {
        try {
          var parsed = JSON.parse(v);
          return parsed && typeof parsed === "object" ? parsed : {};
        } catch (_e) {
          return {};
        }
      }
      return {};
    }

    function snapshotFromRegistrations() {
      var out = [];
      registeredTools.forEach(function (t) {
        out.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
      });
      return out;
    }

    // name -> the LIVE RegisteredTool object getTools() itself returned.
    // Chrome's shipped executeTool() (see the call-request handling below)
    // requires this EXACT object as its first argument — verified against
    // Chrome's own documentation (developer.chrome.com/docs/ai/webmcp/
    // imperative-api): a bare name string, or a reconstructed object literal
    // with a matching `name`, are both rejected ("The provided value is not
    // of type 'RegisteredTool'"). Populated only from a real getTools()
    // array below, never from this script's own snapshotFromRegistrations()
    // bookkeeping, which never had real RegisteredTool instances to begin
    // with. NOTE: Chrome's own developer documentation examples suggest
    // RegisteredTool.inputSchema is an object, but that reading turned out
    // to be an artifact of how the docs illustrate the schema, not the
    // actual wire shape — see safeSchema() above, which handles both.
    var liveToolObjects = new Map();
    function updateLiveToolObjects(tools) {
      liveToolObjects.clear();
      if (!Array.isArray(tools)) return;
      tools.forEach(function (t) {
        if (t && typeof t.name === "string") liveToolObjects.set(t.name, t);
      });
    }

    // Post the current inventory to the ISOLATED relay. Never throws outward
    // — a postMessage failure (e.g. the page tore down mid-navigation) must
    // never surface as a page-visible error.
    function post(inventory) {
      try {
        window.postMessage(
          {
            browzy_webmcp_v1: true,
            kind: "inventory",
            tools: inventory.map(function (t) {
              return {
                name: safeString(t.name),
                description: safeString(t.description),
                inputSchema: safeSchema(t.inputSchema)
              };
            }),
            // Reported alongside the inventory so the relay/background never
            // has to guess which execution path a later call will take —
            // see the call-request handling below for how this is used.
            executeToolAvailable: typeof mc.executeTool === "function"
          },
          "*"
        );
      } catch (_e) {
        // Reporting must never surface as a page-visible error.
      }
    }

    // Resolve the current inventory and report it once. getTools() (when
    // present) is preferred as the source of truth — it is the API's own
    // authoritative list, which can include entries this wrapper's own
    // bookkeeping never saw (a registration that landed before this script
    // ran despite document_start, or one the browser routes through some
    // other path). getTools() always resolves a Promise (webmcp-types
    // 0.1.7), so this function is async by construction; every call site
    // below fires it and lets it settle on its own rather than awaiting it
    // inline, which is why the promise chain here is self-contained and
    // terminates in exactly one post() — never a loop.
    function refresh() {
      if (typeof mc.getTools === "function") {
        try {
          var maybePromise = mc.getTools();
          if (maybePromise && typeof maybePromise.then === "function") {
            maybePromise.then(
              function (tools) {
                updateLiveToolObjects(tools);
                post(Array.isArray(tools) ? tools : snapshotFromRegistrations());
              },
              function () {
                post(snapshotFromRegistrations());
              }
            );
            return;
          }
          // Not documented as a possibility by webmcp-types, but handled
          // defensively in case a build resolves synchronously.
          updateLiveToolObjects(maybePromise);
          post(Array.isArray(maybePromise) ? maybePromise : snapshotFromRegistrations());
          return;
        } catch (_e) {
          // Fall through to the wrapper's own snapshot below.
        }
      }
      post(snapshotFromRegistrations());
    }

    // Install the wrapper FIRST, before anything else touches
    // registerTool, so no call the page makes — synchronously during this
    // same task, or any time later — is missed.
    if (typeof mc.registerTool === "function") {
      var originalRegisterTool = mc.registerTool.bind(mc);
      mc.registerTool = function (toolDefinition, options) {
        try {
          if (toolDefinition && typeof toolDefinition.name === "string") {
            registeredTools.set(toolDefinition.name, {
              name: toolDefinition.name,
              description: safeString(toolDefinition.description),
              inputSchema: safeSchema(toolDefinition.inputSchema),
              execute: typeof toolDefinition.execute === "function" ? toolDefinition.execute : null
            });
          }
        } catch (_e) {
          // Bookkeeping must never break the page's own registration call.
        }
        var outcome = originalRegisterTool(toolDefinition, options);
        // Report the wrapper's own synchronous snapshot immediately (so a
        // caller that never awaits registerTool's own promise is still
        // tracked promptly), then refresh again once the browser confirms
        // the registration (registerTool resolves a Promise per
        // webmcp-types), in case getTools() ends up differing from what
        // this wrapper alone observed.
        refresh();
        if (outcome && typeof outcome.then === "function") {
          outcome.then(refresh, function () {});
        }
        return outcome;
      };
    }

    // Tools can also change after load (spec: "Tools registered or removed
    // by a page after load, as signalled by the API's tool-change
    // notification, SHALL be reflected"). document.modelContext is an
    // EventTarget (webmcp-types 0.1.7); subscribe rather than poll.
    try {
      if (typeof mc.addEventListener === "function") {
        mc.addEventListener("toolchange", refresh);
      }
    } catch (_e) {
      // No toolchange support on this build — reports still happen on every
      // registerTool call above, just not on removals this script cannot
      // otherwise observe.
    }

    // --- Inbound call requests from the ISOLATED relay -----------------
    //
    // The relay forwards a webmcp_call_tool request here as a "call_request"
    // postMessage; this is the only place page code is ever invoked from
    // this script. Every branch below reports what actually happened —
    // including which of the two execution paths was used — never a guess.
    window.addEventListener("message", function (event) {
      if (event.source !== window) return;
      var data = event.data;
      if (!data || data[WEBMCP_MARKER] !== true) return;

      if (data.kind === "relay_ready") {
        // The ISOLATED relay just (re)loaded and may have missed whatever
        // this script already reported (load order between the two worlds
        // is not guaranteed). Re-report the current inventory so nothing is
        // silently lost.
        refresh();
        return;
      }

      if (data.kind !== "call_request") return;

      var requestId = data.requestId;
      var name = data.name;
      var toolArgs = data.toolArgs && typeof data.toolArgs === "object" ? data.toolArgs : {};
      var via = typeof mc.executeTool === "function" ? "executeTool" : "captured-callback";

      // Report which path this call is about to take BEFORE awaiting it, so
      // a call that later hangs past the extension's own timeout still has
      // a known, honestly-reported path rather than an invented one — see
      // relay-isolated.js's handling of "call_started".
      try {
        window.postMessage({ browzy_webmcp_v1: true, kind: "call_started", requestId: requestId, via: via }, "*");
      } catch (_e) {}

      if (via === "executeTool") {
        // Chrome's shipped executeTool() is string-in/string-out, which the
        // W3C explainer's plainer sketch does not say — verified against
        // Chrome's own documentation (developer.chrome.com/docs/ai/webmcp/
        // imperative-api). The first argument must be the LIVE
        // RegisteredTool object getTools() returned (never a bare name or a
        // reconstructed object — both are rejected), and the second must be
        // a JSON string, never a plain object. This is exactly the kind of
        // build-to-build divergence design.md Decision 1 exists to absorb
        // through runtime feature-detection rather than a hard-coded
        // assumption about either shape.
        var liveTool = liveToolObjects.get(name);
        if (!liveTool) {
          // Answered entirely from this script's own getTools()-derived
          // table — executeTool is never called for a name outside it.
          reportCallResult(requestId, {
            ok: false,
            via: via,
            error: 'Tool "' + safeString(name) + '" is not in the current getTools() inventory.'
          });
          return;
        }
        var argsJson;
        try {
          argsJson = JSON.stringify(toolArgs);
        } catch (stringifyErr) {
          reportCallResult(requestId, {
            ok: false,
            via: via,
            error: "toolArgs could not be serialized to JSON: " + describeError(stringifyErr)
          });
          return;
        }
        Promise.resolve()
          .then(function () {
            return mc.executeTool(liveTool, argsJson);
          })
          .then(
            function (raw) {
              // The browser resolves a JSON string, not an already-parsed
              // value. If a build ever returns something that isn't valid
              // JSON (or isn't a string at all), report it as-is rather than
              // silently discarding it or throwing past the caller.
              var parsed = raw;
              if (typeof raw === "string") {
                try {
                  parsed = JSON.parse(raw);
                } catch (parseErr) {
                  parsed = raw;
                }
              }
              reportCallResult(requestId, { ok: true, via: via, result: parsed });
            },
            function (err) {
              reportCallResult(requestId, { ok: false, via: via, error: describeError(err) });
            }
          );
        return;
      }

      // captured-callback fallback: the page's own execute(args, options)
      // callback takes and returns PLAIN OBJECTS (webmcp-types 0.1.7's
      // ToolExecuteCallback), the mirror image of the branch above — no
      // JSON string conversion here, deliberately.
      var entry = registeredTools.get(name);
      if (!entry || typeof entry.execute !== "function") {
        reportCallResult(requestId, {
          ok: false,
          via: via,
          error: 'Tool "' + safeString(name) + '" is not registered on this page.'
        });
        return;
      }
      Promise.resolve()
        .then(function () {
          return entry.execute(toolArgs, {});
        })
        .then(
          function (result) {
            reportCallResult(requestId, { ok: true, via: via, result: result });
          },
          function (err) {
            reportCallResult(requestId, { ok: false, via: via, error: describeError(err) });
          }
        );
    });

    function describeError(err) {
      if (err && typeof err.message === "string") return err.message;
      try {
        return String(err);
      } catch (_e) {
        return "unknown error";
      }
    }

    function reportCallResult(requestId, outcome) {
      try {
        window.postMessage(
          {
            browzy_webmcp_v1: true,
            kind: "call_result",
            requestId: requestId,
            ok: outcome.ok,
            via: outcome.via,
            result: outcome.result,
            error: outcome.error
          },
          "*"
        );
      } catch (_e) {
        // Never surfaces to the page.
      }
    }

    // Initial report. Covers the (rare) case of a page that had already
    // registered tools through some path this wrapper did not intercept, and
    // gives the relay something to answer with even before any registerTool
    // call happens.
    refresh();
  } catch (_e) {
    // Any unexpected failure anywhere above is contained here — it must
    // never propagate into the page.
  }
})();
