require("dotenv").config();

const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.send("Stagehand service is running"));

const MESSAGE_REGEX =
  /message|comments?|inquiry|inquiries|questions?|details|notes|how can we help|tell us|your\s*message/i;

const HONEYPOT_REGEX = /honeypot|url2|trap|bot|website\b/i;

const HARD_TIMEOUT_MS = 4 * 60 * 1000;

async function prefillMessageTextarea(page, message, messageParagraphs) {
  if (!message) {
    return {
      filled: false,
      locked: false,
      selector: null,
      reason: "no_message",
      verifiedLength: 0,
      usedFallback: false,
      candidates: [],
    };
  }

  const waitForAny = async (ms) => {
    try {
      await page.waitForSelector("textarea", {
        timeout: ms,
        state: "visible",
      });
      return true;
    } catch {
      return false;
    }
  };

  let found = await waitForAny(8000);

  if (!found) {
    try {
      const contactLink = page
        .getByRole("link", {
          name: /contact|reach us|inquire|appointment|consultation|get in touch/i,
        })
        .first();

      if (await contactLink.count()) {
        await contactLink.click({ timeout: 5000 }).catch(() => {});
        await page.waitForLoadState("domcontentloaded").catch(() => {});
      }
    } catch {}

    found = await waitForAny(8000);
  }

  if (!found) {
    return {
      filled: false,
      locked: false,
      selector: null,
      reason: "no_textarea",
      verifiedLength: 0,
      usedFallback: false,
      candidates: [],
    };
  }

  const candidates = await page.$$eval(
    "textarea",
    (nodes, rx) => {
      const messageRe = new RegExp(rx.message, "i");
      const honeypotRe = new RegExp(rx.honeypot, "i");

      return nodes.map((el, idx) => {
        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          rect.width > 0 &&
          rect.height > 0;

        const name = el.getAttribute("name") || "";
        const id = el.getAttribute("id") || "";
        const placeholder = el.getAttribute("placeholder") || "";
        const aria = el.getAttribute("aria-label") || "";

        let labelText = "";

        if (id) {
          const label = document.querySelector(
            `label[for="${CSS.escape(id)}"]`,
          );

          if (label) {
            labelText = label.textContent || "";
          }
        }

        if (!labelText && el.parentElement) {
          const label = el.parentElement.querySelector("label");

          if (label) {
            labelText = label.textContent || "";
          }
        }

        const haystack = `${name} ${id} ${placeholder} ${aria} ${labelText}`;

        let score = 0;

        if (messageRe.test(haystack)) score += 5;
        if (messageRe.test(labelText)) score += 3;

        const rows = parseInt(el.getAttribute("rows") || "0", 10) || 0;
        const cols = parseInt(el.getAttribute("cols") || "0", 10) || 0;

        score += Math.min(5, Math.floor((rows * cols) / 100));

        if (!visible) score -= 20;
        if (el.hasAttribute("readonly") || el.hasAttribute("disabled")) {
          score -= 20;
        }

        if (honeypotRe.test(haystack)) score -= 20;

        let selector = "";

        if (id) {
          selector = `textarea#${CSS.escape(id)}`;
        } else if (name) {
          selector = `textarea[name="${name}"]`;
        } else {
          selector = `textarea >> nth=${idx}`;
        }

        return {
          idx,
          selector,
          score,
          visible,
          name,
          id,
          placeholder,
          labelText,
        };
      });
    },
    {
      message: MESSAGE_REGEX.source,
      honeypot: HONEYPOT_REGEX.source,
    },
  );

  const best = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0];

  if (!best) {
    return {
      filled: false,
      locked: false,
      selector: null,
      reason: "no_matching_textarea",
      verifiedLength: 0,
      usedFallback: false,
      candidates,
    };
  }

  const loc = page.locator(best.selector).first();

  let filled = false;
  let usedFallback = false;
  let reason = "unknown";
  let verifiedLength = 0;

  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 3000 }).catch(() => {});
    await loc.click({ timeout: 3000 }).catch(() => {});
    await loc.fill("", { timeout: 3000 }).catch(() => {});
    await loc.fill(message, { timeout: 8000 });

    const got = await loc.inputValue().catch(() => "");
    verifiedLength = got.length;

    if (got && got.length >= Math.min(20, message.length)) {
      filled = true;
      reason = "fill_ok";
    } else {
      usedFallback = true;

      await loc.fill("").catch(() => {});
      await loc.click({ timeout: 3000 }).catch(() => {});

      const paragraphs =
        Array.isArray(messageParagraphs) && messageParagraphs.length
          ? messageParagraphs
          : message.split(/\n{2,}/g);

      for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
        const lines = String(paragraphs[paragraphIndex]).split("\n");

        for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
          await loc.pressSequentially(lines[lineIndex], { delay: 5 });

          if (lineIndex < lines.length - 1) {
            await page.keyboard.press("Shift+Enter");
          }
        }

        if (paragraphIndex < paragraphs.length - 1) {
          await page.keyboard.press("Enter");
          await page.keyboard.press("Enter");
        }
      }

      const got2 = await loc.inputValue().catch(() => "");
      verifiedLength = got2.length;
      filled = got2.length > 0;

      reason = filled
        ? "sequential_ok"
        : "fill_and_sequential_failed";
    }
  } catch (err) {
    return {
      filled: false,
      locked: false,
      selector: best.selector,
      reason: `fill_error: ${err.message || err}`,
      verifiedLength,
      usedFallback,
      candidates,
    };
  }

  let locked = false;

  if (filled) {
    try {
      locked = await loc.evaluate((el) => {
        try {
          el.setAttribute("data-lovable-prefilled", "1");
          el.readOnly = true;

          if (typeof el.blur === "function") {
            el.blur();
          }

          return true;
        } catch {
          return false;
        }
      });
    } catch {
      locked = false;
    }
  }

  return {
    filled,
    locked,
    selector: best.selector,
    reason,
    verifiedLength,
    usedFallback,
    candidates,
  };
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/*
  Converts a Stagehand agent result into text, but does not mix it with:
  - prompts
  - original instructions
  - page diagnostics
  - callback diagnostics
  - agent transcript history

  This is important because instructions themselves contain the literal
  text "OUTCOME: CONFIRMED", which must never be treated as proof of success.
*/
function agentResultToText(agentResult) {
  if (agentResult == null) return "";

  if (typeof agentResult === "string") {
    return agentResult;
  }

  if (typeof agentResult === "object") {
    const preferredFields = [
      "text",
      "message",
      "output",
      "content",
      "result",
      "final",
      "completion",
    ];

    for (const field of preferredFields) {
      const value = agentResult[field];

      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }

    try {
      return JSON.stringify(agentResult);
    } catch {
      return String(agentResult);
    }
  }

  return String(agentResult);
}

/*
  Only accept an outcome if it appears as a standalone line near the end
  of the final agent response.

  This prevents false matches from:
  - the prompt's "OUTCOME: CONFIRMED" example
  - internal agent reasoning
  - pasted transcript/history
  - diagnostic logs
*/
function parseTrustedOutcome(agentText) {
  const text = String(agentText || "").trim();

  if (!text) {
    return {
      outcome: undefined,
      excerpt: null,
      matchedLine: null,
    };
  }

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const finalLines = lines.slice(-8).reverse();

  for (const line of finalLines) {
    const match = line.match(
      /^OUTCOME:\s*(CONFIRMED|CAPTCHA_BLOCKED|NO_CONFIRMATION|ERROR)\s*(?:—|--|:|-)?\s*(.*)$/i,
    );

    if (!match) continue;

    return {
      outcome: match[1].toLowerCase(),
      excerpt: (match[2] || "").trim().slice(0, 300) || null,
      matchedLine: line,
    };
  }

  return {
    outcome: undefined,
    excerpt: null,
    matchedLine: null,
  };
}

function buildExtraction(result) {
  const agentResult = result?.result?.agentResult;
  const agentText = agentResultToText(agentResult);

  let extraction = "";

  if (agentText) {
    extraction += `[agent_final_result]\n${agentText}`;
  }

  if (result?.result?.pageText) {
    extraction += `\n\n[final_page_text]\n${result.result.pageText}`;
  }

  if (result?.result?.finalUrl) {
    extraction += `\n\n[final_url]\n${result.result.finalUrl}`;
  }

  if (result?.result?.prefill) {
    extraction += `\n\n[prefill]\n${safeStringify({
      filled: result.result.prefill.filled,
      locked: result.result.prefill.locked,
      selector: result.result.prefill.selector,
      reason: result.result.prefill.reason,
      verifiedLength: result.result.prefill.verifiedLength,
      usedFallback: result.result.prefill.usedFallback,
    })}`;
  }

  if (result?.error) {
    extraction += `\n\n[run_error]\n${result.error}`;
  }

  return extraction.trim();
}

async function runStagehand({
  url,
  instructions,
  message,
  message_paragraphs,
}) {
  let stagehand;

  try {
    stagehand = new Stagehand({ env: "BROWSERBASE" });
    await stagehand.init();

    const page = stagehand.context.pages()[0];
    const targetUrl = url || "https://example.com";

    await page.goto(targetUrl, {
      waitUntil: "domcontentloaded",
    });

    const prefill = await prefillMessageTextarea(
      page,
      message,
      message_paragraphs,
    );

    console.log("[stagehand] prefill result", {
      filled: prefill.filled,
      locked: prefill.locked,
      selector: prefill.selector,
      reason: prefill.reason,
      verifiedLength: prefill.verifiedLength,
      usedFallback: prefill.usedFallback,
    });

    const messageNote =
      prefill.filled && prefill.locked
        ? `The message/comments/inquiry textarea has ALREADY BEEN FILLED and LOCKED for you by the automation harness (selector "${prefill.selector}"). DO NOT navigate to the current page URL, refresh the page, click the message field, focus it, clear it, retype it, or edit it. It is intentionally readOnly and will submit correctly as-is. Fill ONLY the other fields and submit the form.`
        : prefill.filled
          ? `The message textarea has already been filled by the automation harness but could not be locked. Do NOT navigate to the current page URL, refresh, retype, or edit that message. Fill only the other fields and submit.`
          : `The message textarea could NOT be pre-filled automatically (reason: ${prefill.reason}). Locate the message/comments field yourself and paste the message verbatim before submitting.`;

    const wrappedInstruction = `
You are a browser automation agent controlling a real browser.

Your job is to fill out and SUBMIT the contact form on this page.

${messageNote}

HARD RULES:
- Do NOT call page.goto(), navigate to the current page URL, or refresh the page unless the user explicitly requires navigation to another page.
- Fill every required field before submitting.
- Click the actual submit/send/request-appointment button at the end.
- After clicking submit, wait and observe the result.
- A successful submission requires visible evidence on the resulting page, such as a confirmation message, thank-you page, success state, or a clear submission confirmation.
- Do NOT claim confirmation merely because the form button was clicked.
- If the form was not submitted, validation failed, required data is missing, or no visible confirmation was observed, report NO_CONFIRMATION or ERROR.
- Your final non-empty line MUST be exactly one of these forms:
  OUTCOME: CONFIRMED — <first 200 characters of visible confirmation>
  OUTCOME: CAPTCHA_BLOCKED — <captcha type>
  OUTCOME: NO_CONFIRMATION — <what the page showed after the submit attempt>
  OUTCOME: ERROR — <what went wrong>

Original task:
${instructions}
`.trim();

    const agent = stagehand.agent({
      model: "anthropic/claude-sonnet-4-6",
    });

    const agentResult = await agent.execute({
      instruction: wrappedInstruction,
      maxSteps: 35,
    });

    let finalUrl = "";
    let pageText = "";

    try {
      finalUrl = page.url();
    } catch {}

    try {
      pageText = (await page.locator("body").innerText()).slice(0, 2000);
    } catch {}

    return {
      success: true,
      result: {
        message: "Stagehand agent finished",
        instructionsReceived: instructions,
        urlVisited: targetUrl,
        finalUrl,
        pageText,
        agentResult,
        prefill,
        liveSessionUrl: `https://browserbase.com/sessions/${stagehand.browserbaseSessionID}`,
      },
      error: null,
    };
  } catch (err) {
    console.error("Error in runStagehand:", err);

    return {
      success: false,
      result: null,
      error: err.message || "Unknown error",
    };
  } finally {
    if (stagehand) {
      try {
        await stagehand.close();
      } catch (err) {
        console.error("Error closing Stagehand:", err);
      }
    }
  }
}

app.post("/run", async (req, res) => {
  const {
    url,
    instructions,
    message,
    message_paragraphs,
    callback_url,
    job_id,
    shared_secret,
  } = req.body || {};

  if (!instructions) {
    return res.status(400).json({
      accepted: false,
      error: "Missing 'instructions'",
    });
  }

  res.json({
    accepted: true,
    job_id,
  });

  let result;

  try {
    result = await Promise.race([
      runStagehand({
        url,
        instructions,
        message,
        message_paragraphs,
      }),
      new Promise((resolve) => {
        setTimeout(() => {
          resolve({
            success: false,
            result: null,
            error: "render_hard_timeout_4min",
          });
        }, HARD_TIMEOUT_MS);
      }),
    ]);
  } catch (err) {
    result = {
      success: false,
      result: null,
      error: err.message || "unknown_error",
    };
  }

  if (!callback_url) {
    return;
  }

  /*
    Parse the outcome ONLY from the direct agent result.

    Do NOT parse `extraction`, because it intentionally contains diagnostic
    content and may include prompt examples such as "OUTCOME: CONFIRMED".
  */
  const agentFinalText = agentResultToText(result?.result?.agentResult);

  const {
    outcome: trustedOutcome,
    excerpt: confirmationExcerpt,
    matchedLine,
  } = parseTrustedOutcome(agentFinalText);

  const extraction = buildExtraction(result);

  /*
    Fail closed:
    Only a trusted, final `OUTCOME: CONFIRMED` counts as success.

    A run that finishes technically (`result.success === true`) is not proof
    that the form was submitted successfully.
  */
  const callbackSuccess = trustedOutcome === "confirmed";

  const outcome =
    trustedOutcome ||
    (result.success ? "no_confirmation" : "error");

  const fallbackExcerpt =
    trustedOutcome
      ? confirmationExcerpt
      : result.error
        ? String(result.error).slice(0, 300)
        : "The agent did not provide a trusted final outcome line.";

  console.log("[stagehand] run finished", {
    job_id,
    stagehandRunSuccess: result.success,
    callbackSuccess,
    outcome,
    trustedOutcome,
    matchedLine,
    error: result.error,
    prefill_filled: result.result?.prefill?.filled,
    prefill_locked: result.result?.prefill?.locked,
  });

  try {
    const cbRes = await fetch(callback_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-stagehand-secret":
          shared_secret ||
          process.env.STAGEHAND_SHARED_SECRET ||
          "",
      },
      body: JSON.stringify({
        job_id,

        /*
          `success` now strictly means the website visibly confirmed the
          submission, not merely that the browser agent completed execution.
        */
        success: callbackSuccess,

        outcome,
        confirmation_excerpt: fallbackExcerpt,

        trusted_agent_outcome: trustedOutcome || null,
        trusted_outcome_line: matchedLine || null,
        agent_final_text: agentFinalText || null,

        extraction,

        prefill: result.result?.prefill
          ? {
              filled: result.result.prefill.filled,
              locked: result.result.prefill.locked,
              selector: result.result.prefill.selector,
              reason: result.result.prefill.reason,
              verifiedLength: result.result.prefill.verifiedLength,
              usedFallback: result.result.prefill.usedFallback,
            }
          : null,

        liveSessionUrl: result.result?.liveSessionUrl ?? null,
        result: result.result,
        error: result.error ?? null,
      }),
    });

    console.log("[stagehand] callback POST", {
      job_id,
      status: cbRes.status,
      ok: cbRes.ok,
    });
  } catch (err) {
    console.error("callback POST failed:", err);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Stagehand service listening on port ${PORT}`);
});
