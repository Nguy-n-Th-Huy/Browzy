// Generates a randomized local visual fixture for gate 1.3 (screenshot-based
// recognition). A fresh HTML page is written to a scratch temp directory on
// every call, with a random token, shape and color baked in, plus a small
// form whose submitted value the gate can check against the token
// programmatically. Nothing here is fetched from the network or checked into
// the repo — it is regenerated per run, which is the point: recognition must
// be proven against a value the model could not have memorized.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const SHAPES = ["circle", "square", "triangle", "star-ish blob"];
const COLORS = ["#e63946", "#2a9d8f", "#457b9d", "#f4a261", "#7209b7", "#ffb703"];

export function generateVisualFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocic-sdk-gate-"));
  const token = crypto.randomBytes(6).toString("hex").toUpperCase();
  const shape = SHAPES[crypto.randomInt(SHAPES.length)];
  const color = COLORS[crypto.randomInt(COLORS.length)];
  const inputId = `answer-${crypto.randomBytes(3).toString("hex")}`;

  const shapeCss =
    shape === "triangle"
      ? `width:0;height:0;background:transparent;border-left:80px solid transparent;border-right:80px solid transparent;border-bottom:160px solid ${color};`
      : shape === "circle"
        ? `width:160px;height:160px;background:${color};border-radius:50%;`
        : shape === "star-ish blob"
          ? `width:160px;height:160px;background:${color};border-radius:42% 58% 63% 37% / 41% 44% 56% 59%;`
          : `width:160px;height:160px;background:${color};`;

  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>SDK gate fixture</title>
<style>
  body { font-family: sans-serif; padding: 40px; background: #fff; color: #111; }
  #shape { margin: 24px 0; ${shapeCss} }
  #token { font-size: 28px; font-weight: bold; letter-spacing: 4px; }
</style></head>
<body>
  <p>Randomized SDK acceptance-gate fixture. Read the token below, then submit it.</p>
  <p>Token: <span id="token">${token}</span></p>
  <div id="shape" data-shape="${shape}" data-color="${color}"></div>
  <form id="gate-form">
    <label for="${inputId}">Type the token you see above:</label>
    <input id="${inputId}" name="answer" type="text" autocomplete="off" />
    <button type="submit" id="submit-btn">Submit</button>
  </form>
  <p id="result" style="display:none">SUBMITTED:<span id="submitted-value"></span></p>
  <script>
    document.getElementById('gate-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var val = document.getElementById('${inputId}').value;
      document.getElementById('submitted-value').textContent = val;
      document.getElementById('result').style.display = 'block';
    });
  </script>
</body></html>`;

  const filePath = path.join(dir, `fixture-${token}.html`);
  fs.writeFileSync(filePath, html, "utf-8");

  return {
    dir,
    filePath,
    fileUrl: `file://${filePath.replace(/\\/g, "/")}`,
    token,
    shape,
    color,
    inputId
  };
}

export function cleanupFixture(fixture) {
  try {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}
