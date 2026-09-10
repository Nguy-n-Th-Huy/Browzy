// WebMCP relay — ISOLATED-world content script.
//
// document.modelContext lives in the page's MAIN world, which cannot use
// chrome.*. This script is the other half of the pair from detect-main.js:
// it runs in the ordinary ISOLATED content-script world (so it can talk to
// the service worker over chrome.runtime), and bridges the two over
// window.postMessage under the namespaced WEBMCP_MARKER key.
//
// It is registered dynamically from extension/background.js via
// chrome.scripting.registerContentScripts (run_at "document_start", world
// "ISOLATED"), NOT declared in extension/manifest.json — see that
// registration call for why: task 1.5 adds exactly one new manifest entry,
// for the MAIN-world detector, and the two pre-existing entries (including
// the recorder's load-bearing one) must stay byte-identical. A dynamically
// registered content script gets the same real document_start timing as a
// manifest-declared one, without touching the manifest at all.
(function () {
  "use strict";

  var WEBMCP_MARKER = "browzy_webmcp_v1";
  var CALL_TIMEOUT_MS = 18000; // fires before background.js's own (longer) timeout, so a timed-out call gets this script's more specific "timed out waiting for the page" message rather than a generic messaging error.

  // requestId -> { resolve(data), timer, via }
  var pending = new Map();

  window.addEventListener("message", function (event) {
    // Only same-document, same-window messages carrying the namespaced
    // marker are accepted. This is what stops cross-talk with other
    // extension channels or with a frame posting into this window — it does
    // NOT make the tool inventory itself trustworthy. A page can declare
    // whatever tools it wants with whatever names and descriptions it wants;
    // that is not a bypass of this check, it is the feature's entire
    // premise (the page is the authority on its own tools). Trust is
    // handled by labelling this content as page-supplied wherever it
    // reaches the agent (extension/background.js's webmcp_list_tools /
    // webmcp_call_tool handlers), never by validating this channel harder.
    if (event.source !== window) return;
    var data = event.data;
    if (!data || data[WEBMCP_MARKER] !== true) return;

    if (data.kind === "inventory") {
      try {
        chrome.runtime
          .sendMessage({
            browzy_webmcp_v1: true,
            type: "webmcp_inventory_report",
            tools: Array.isArray(data.tools) ? data.tools : [],
            executeToolAvailable: !!data.executeToolAvailable
          })
          .catch(function () {});
      } catch (_e) {
        // The extension context can be invalidated (e.g. mid-reload) while
        // this script is still attached to an old page; nothing to recover
        // here, the next navigation gets a fresh copy of this script.
      }
      return;
    }

    if (data.kind === "call_started") {
      var starting = pending.get(data.requestId);
      if (starting) starting.via = data.via || null;
      return;
    }

    if (data.kind === "call_result") {
      var waiter = pending.get(data.requestId);
      if (!waiter) return;
      pending.delete(data.requestId);
      clearTimeout(waiter.timer);
      waiter.resolve({ ok: !!data.ok, via: data.via || waiter.via || null, result: data.result, error: data.error });
    }
  });

  // background.js's callWebmcpTool() sends this request directly to this
  // tab (chrome.tabs.sendMessage), not the other way around — this listener
  // is what answers it.
  chrome.runtime.onMessage.addListener(function (msg, _sender, sendResponse) {
    if (!msg || msg[WEBMCP_MARKER] !== true || msg.type !== "call_request") return;
    var requestId = msg.requestId;
    var timer = setTimeout(function () {
      var waiter = pending.get(requestId);
      pending.delete(requestId);
      sendResponse({
        ok: false,
        via: (waiter && waiter.via) || null,
        error: "WebMCP call timed out waiting for the page"
      });
    }, CALL_TIMEOUT_MS);
    pending.set(requestId, {
      resolve: function (data) {
        sendResponse(data);
      },
      timer: timer,
      via: null
    });
    try {
      window.postMessage(
        { browzy_webmcp_v1: true, kind: "call_request", requestId: requestId, name: msg.name, toolArgs: msg.toolArgs },
        "*"
      );
    } catch (_e) {
      clearTimeout(timer);
      pending.delete(requestId);
      sendResponse({ ok: false, via: null, error: "could not reach the page's WebMCP detector" });
      return;
    }
    return true; // async sendResponse
  });

  // Ask the MAIN-world detector to re-report its current inventory. This
  // script can load either before or after detect-main.js has already
  // reported once — postMessage has no queue for a listener that was not
  // yet registered, so without this handshake a report made before this
  // script attached would simply be lost. Either way, this guarantees at
  // least one report reaches background.js shortly after this script starts.
  try {
    window.postMessage({ browzy_webmcp_v1: true, kind: "relay_ready" }, "*");
  } catch (_e) {}
})();
