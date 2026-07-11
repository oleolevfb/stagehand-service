require("dotenv").config();

const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.send("Stagehand service is running"));

const MESSAGE_REGEX =
  /message|comments?|inquir(?:y|ies)|questions?|details|notes|how can we help|tell us|your\s*message|additional\s*(?:info|information)|describe|reason\s*for|what\s*can\s*we\s*help/i;

const HONEYPOT_REGEX =
  /honeypot|url2|trap|bot|website\b|company_website|your_website/i;

const FORM_HINT_REGEX =
  /contact|reach us|inquir|appointment|consultation|get in touch|request/i;

const HARD_TIMEOUT_MS = 4 * 60 * 1000;
const INITIAL_FORM_WAIT_MS = 15_000;
const SECONDARY_FORM_WAIT_MS = 8_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function getFrameDescription(frame, index) {
  let url = "";
  try {
    url = frame.url();
  } catch {}

  return {
    frameIndex: index,
    frameUrl: url || "unknown",
    isMainFrame: index === 0,
  };
}

async function waitForFormRender(page, timeoutMs = INITIAL_FORM_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frames = page.frames();

    for (const frame of frames) {
      try {
        const count = await frame.locator("textarea, [contenteditable='true']").count();
        if (count > 0) return true;
      } catch {}
    }

    await sleep(500);
  }

  return false;
}

async function clickLikelyContactLink(page) {
  try {
    const contactLink = page
      .getByRole("link", { name: FORM_HINT_REGEX })
      .first();

    if (await contactLink.count()) {
      await contactLink.click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("domcontentloaded").catch(() => {});
      await sleep(1200);
      return true;
    }
  } catch {}

  return false;
}

async function collectTextareaCandidates(page) {
  const frames = page.frames();
  const results = [];

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const frame = frames[frameIndex];
    const frameInfo = getFrameDescription(frame, frameIndex);

    try {
      const candidates = await frame.$$eval(
        "textarea",
        (nodes, regexes) => {
          const messageRe = new RegExp(regexes.message, "i");
          const honeypotRe = new RegExp(regexes.honeypot, "i");

          return nodes.map((el, idx) => {
            const style = window.getComputedStyle(el);
            const rect = el.getBoundingClientRect();

            const visible =
              style.display !== "none" &&
              style.visibility !== "hidden" &&
              style.opacity !== "0" &&
              rect.width > 0 &&
              rect.height > 0;

            const disabled =
              el.hasAttribute("disabled") ||
              el.getAttribute("aria-disabled") === "true";

            const readOnly =
              el.hasAttribute("readonly") ||
              el.getAttribute("aria-readonly") === "true";

            const name = el.getAttribute("name") || "";
            const id = el.getAttribute("id") || "";
            const placeholder = el.getAttribute("placeholder") || "";
            const aria = el.getAttribute("aria-label") || "";
            const autocomplete = el.getAttribute("autocomplete") || "";

            let labelText = "";

            if (id) {
              const label = document.querySelector(
                `label[for="${CSS.escape(id)}"]`,
              );
              if (label) labelText = label.textContent || "";
            }

            if (!labelText) {
              const closestLabel = el.closest("label");
              if (closestLabel) labelText = closestLabel.textContent || "";
            }

            if (!labelText && el.parentElement) {
              const parentLabel = el.parentElement.querySelector("label");
              if (parentLabel) labelText = parentLabel.textContent || "";
            }

            const surroundingText = [
              el.parentElement?.innerText || "",
              el.closest("fieldset")?.innerText || "",
              el.closest("form")?.innerText?.slice(0, 2000) || "",
            ].join(" ");

            const haystack = [
              name,
              id,
              placeholder,
              aria,
              autocomplete,
              labelText,
              surroundingText,
            ].join(" ");

            const rows =
              parseInt(el.getAttribute("rows") || "0", 10) || 0;
            const cols =
              parseInt(el.getAttribute("cols") || "0", 10) || 0;

            let score = 0;

            if (messageRe.test(haystack)) score += 8;
            if (messageRe.test(labelText)) score += 4;
            if (messageRe.test(placeholder)) score += 3;
            if (messageRe.test(name) || messageRe.test(id)) score += 3;

            score += Math.min(5, Math.floor((rows * cols) / 100));

            if (visible) score += 2;
            if (!visible) score -= 25;
            if (disabled || readOnly) score -= 25;
            if (honeypotRe.test(haystack)) score -= 30;

            let selector = "";
            if (id) selector = `textarea#${CSS.escape(id)}`;
            else if (name) {
              selector = `textarea[name="${CSS.escape(name)}"]`;
            } else {
              selector = `textarea >> nth=${idx}`;
            }

            return {
              idx,
              selector,
              score,
              visible,
              disabled,
              readOnly,
              name,
              id,
              placeholder,
              aria,
              labelText: labelText.trim().slice(0, 300),
              rows,
              cols,
            };
          });
        },
        {
          message: MESSAGE_REGEX.source,
          honeypot: HONEYPOT_REGEX.source,
        },
      );

      for (const candidate of candidates) {
        results.push({
          ...candidate,
          ...frameInfo,
          frame,
        });
      }
    } catch (err) {
      results.push({
        ...frameInfo,
        selector: null,
        score: -999,
        visible: false,
        error: `candidate_scan_error: ${err.message || err}`,
        frame,
      });
    }
  }

  return results;
}

function selectBestTextarea(candidates) {
  const usable = candidates.filter(
    (candidate) =>
      candidate.selector &&
      candidate.visible &&
      !candidate.disabled &&
      !candidate.readOnly &&
      candidate.score > -20,
  );

  const scoredMatches = usable
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scoredMatches.length) {
    return {
      best: scoredMatches[0],
      selectionReason: "best_scored_message_candidate",
      usable,
    };
  }

  if (usable.length === 1) {
    return {
      best: usable[0],
      selectionReason: "only_visible_usable_textarea",
      usable,
    };
  }

  const largeTextarea = usable
    .filter((candidate) => candidate.rows >= 3 || candidate.cols >= 20)
    .sort((a, b) => b.score - a.score)[0];

  if (largeTextarea) {
    return {
      best: largeTextarea,
      selectionReason: "largest_visible_usable_textarea_fallback",
      usable,
    };
  }

  return {
    best: null,
    selectionReason: "no_suitable_textarea",
    usable,
  };
}

async function fillTextareaCandidate(
  candidate,
  message,
  messageParagraphs,
  { lockAfterFill = true } = {},
) {
  const loc = candidate.frame.locator(candidate.selector).first();

  let verifiedLength = 0;
  let usedSequentialFallback = false;
  let locked = false;

  try {
    await loc.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await loc.click({ timeout: 5000 }).catch(() => {});
    await loc.fill("", { timeout: 5000 }).catch(() => {});

    // Fast, one-operation value replacement. This is the preferred path.
    await loc.fill(message, { timeout: 12_000 });

    const value = await loc.inputValue().catch(() => "");
    verifiedLength = value.length;

    if (value.length >= Math.min(20, message.length)) {
      if (lockAfterFill) {
        locked = await loc
          .evaluate((el) => {
            try {
              el.setAttribute("data-lovable-prefilled", "1");
              el.readOnly = true;

              // Ensure frameworks listening for input/change see the final value.
              el.dispatchEvent(new Event("input", { bubbles: true }));
              el.dispatchEvent(new Event("change", { bubbles: true }));

              if (typeof el.blur === "function") el.blur();
              return true;
            } catch {
              return false;
            }
          })
          .catch(() => false);
      }

      return {
        filled: true,
        selector: candidate.selector,
        frameUrl: candidate.frameUrl,
        frameIndex: candidate.frameIndex,
        reason: "fill_ok",
        verifiedLength,
        usedSequentialFallback,
        locked,
      };
    }

    // Only use character-by-character entry if the site's control rejects fill().
    usedSequentialFallback = true;
    await loc.fill("", { timeout: 5000 }).catch(() => {});
    await loc.click({ timeout: 5000 }).catch(() => {});

    const paragraphs =
      Array.isArray(messageParagraphs) && messageParagraphs.length
        ? messageParagraphs
        : String(message).split(/\n{2,}/g);

    for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
      const lines = String(paragraphs[paragraphIndex]).split("\n");

      for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        await loc.pressSequentially(lines[lineIndex], { delay: 1 });

        if (lineIndex < lines.length - 1) {
          await candidate.frame.keyboard.press("Shift+Enter").catch(() => {});
        }
      }

      if (paragraphIndex < paragraphs.length - 1) {
        await candidate.frame.keyboard.press("Enter").catch(() => {});
        await candidate.frame.keyboard.press("Enter").catch(() => {});
      }
    }

    const fallbackValue = await loc.inputValue().catch(() => "");
    verifiedLength = fallbackValue.length;

    if (!fallbackValue.length) {
      return {
        filled: false,
        selector: candidate.selector,
        frameUrl: candidate.frameUrl,
        frameIndex: candidate.frameIndex,
        reason: "fill_and_sequential_fallback_failed",
        verifiedLength,
        usedSequentialFallback,
        locked: false,
      };
    }

    if (lockAfterFill) {
      locked = await loc
        .evaluate((el) => {
          try {
            el.setAttribute("data-lovable-prefilled", "1");
            el.readOnly = true;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
            if (typeof el.blur === "function") el.blur();
            return true;
          } catch {
            return false;
          }
        })
        .catch(() => false);
    }

    return {
      filled: true,
      selector: candidate.selector,
      frameUrl: candidate.frameUrl,
      frameIndex: candidate.frameIndex,
      reason: "sequential_fallback_ok",
      verifiedLength,
      usedSequentialFallback,
      locked,
    };
  } catch (err) {
    return {
      filled: false,
      selector: candidate.selector,
      frameUrl: candidate.frameUrl,
      frameIndex: candidate.frameIndex,
      reason: `fill_error: ${err.message || err}`,
      verifiedLength,
      usedSequentialFallback,
      locked,
    };
  }
}

function sanitizeCandidates(candidates) {
  return candidates.map(({ frame, ...candidate }) => candidate);
}

async function prefillMessageTextarea(
  page,
  message,
  messageParagraphs,
  { waitMs = INITIAL_FORM_WAIT_MS, lockAfterFill = true } = {},
) {
  if (!message) {
    return {
      filled: false,
      locked: false,
      selector: null,
      reason: "no_message",
      candidates: [],
    };
  }

  let formFound = await waitForFormRender(page, waitMs);

  if (!formFound) {
    await clickLikelyContactLink(page);
    formFound = await waitForFormRender(page, SECONDARY_FORM_WAIT_MS);
  }

  const candidates = await collectTextareaCandidates(page);
  const { best, selectionReason, usable } = selectBestTextarea(candidates);

  if (!best) {
    return {
      filled: false,
      locked: false,
      selector: null,
      reason: formFound
        ? `no_matching_textarea:${selectionReason}`
        : "no_textarea_after_wait_and_contact_link_attempt",
      selectionReason,
      usableTextareaCount: usable.length,
      candidates: sanitizeCandidates(candidates),
    };
  }

  const result = await fillTextareaCandidate(best, message, messageParagraphs, {
    lockAfterFill,
  });

  return {
    ...result,
    selectionReason,
    usableTextareaCount: usable.length,
    candidates: sanitizeCandidates(candidates),
  };
}

function getAgentText(agentResult) {
  if (!agentResult) return "";

  if (typeof agentResult === "string") return agentResult;

  const possibleText = [
    agentResult.message,
    agentResult.result,
    agentResult.output,
    agentResult.text,
    agentResult.summary,
  ]
    .filter(Boolean)
    .join("\n");

  return `${possibleText}\n${safeStringify(agentResult)}`;
}

function parseOutcome(text) {
  if (!text) return { outcome: undefined, excerpt: null };

  const match = String(text).match(
    /OUTCOME:\s*(CONFIRMED|CAPTCHA_BLOCKED|NO_CONFIRMATION|ERROR)\s*[—:-]?\s*(.{0,400})?/i,
  );

  if (!match) return { outcome: undefined, excerpt: null };

  return {
    outcome: match[1].toLowerCase(),
    excerpt: (match[2] || "").trim().slice(0, 300) || null,
  };
}

async function getFinalPageDetails(page) {
  let finalUrl = "";
  let pageText = "";

  try {
    finalUrl = page.url();
  } catch {}

  try {
    pageText = (await page.locator("body").innerText()).slice(0, 2000);
  } catch {}

  return { finalUrl, pageText };
}

async function runStagehand({ url, instructions, message, message_paragraphs }) {
  let stagehand;

  try {
    stagehand = new Stagehand({ env: "BROWSERBASE" });
    await stagehand.init();

    const page = stagehand.context.pages()[0];
    const targetUrl = url || "https://example.com";

    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await sleep(1000);

    // Phase 1: Attempt deterministic message fill before agent work.
    let prefill = await prefillMessageTextarea(page, message, message_paragraphs, {
      waitMs: INITIAL_FORM_WAIT_MS,
      lockAfterFill: true,
    });

    console.log("[stagehand] initial prefill result", {
      filled: prefill.filled,
      locked: prefill.locked,
      selector: prefill.selector,
      frameUrl: prefill.frameUrl,
      reason: prefill.reason,
      selectionReason: prefill.selectionReason,
      verifiedLength: prefill.verifiedLength,
      usedSequentialFallback: prefill.usedSequentialFallback,
    });

    const agent = stagehand.agent({
      model: "anthropic/claude-sonnet-4-6",
    });

    const initialMessageNote =
      prefill.filled && prefill.locked
        ? `The message/comments textarea is ALREADY FILLED and LOCKED by the automation harness. It is tagged data-lovable-prefilled="1" and is intentionally readOnly. Do NOT click, focus, clear, type in, or edit it. Fill all OTHER required fields and submit the form.`
        : prefill.filled
          ? `The message/comments textarea has already been filled by the automation harness. Do NOT retype, clear, or edit it. Fill all OTHER required fields and submit the form.`
          : `The long message has NOT yet been filled. Locate and prepare the contact form, and fill every required field EXCEPT the message/comments/inquiry field. Do NOT type the long message character by character. Do NOT submit yet. Stop only after the form and message field are visible and ready for a deterministic fill by the automation harness.`;

    const initialInstruction = `
You are a browser automation agent controlling a real browser.

Your task is to complete a contact-form submission workflow.

${initialMessageNote}

HARD RULES:
- Fill every required field other than the message field described above.
- If a CAPTCHA is detected, wait for Browserbase CAPTCHA handling to complete. If it does not resolve, return: OUTCOME: CAPTCHA_BLOCKED — <captcha type>
- If the message is already filled, submit the form and wait for a confirmation.
- If the message is not filled, do NOT submit. Prepare the form and stop.
- On your FINAL line, print exactly one of:
  OUTCOME: CONFIRMED — <first 200 chars of confirmation>
  OUTCOME: CAPTCHA_BLOCKED — <captcha type>
  OUTCOME: READY_FOR_MESSAGE — <brief description of visible message field>
  OUTCOME: NO_CONFIRMATION — <what the page showed>
  OUTCOME: ERROR — <what went wrong>

Original task:
${instructions}
`.trim();

    const initialAgentResult = await agent.execute({
      instruction: initialInstruction,
      maxSteps: 30,
    });

    let finalAgentResult = initialAgentResult;
    let secondPrefill = null;

    // Phase 2: If message could not be filled earlier, retry after the agent has
    // opened/expanded/rendered the form. This keeps long-text entry deterministic.
    if (message && !prefill.filled) {
      secondPrefill = await prefillMessageTextarea(page, message, message_paragraphs, {
        waitMs: SECONDARY_FORM_WAIT_MS,
        lockAfterFill: true,
      });

      console.log("[stagehand] second prefill result", {
        filled: secondPrefill.filled,
        locked: secondPrefill.locked,
        selector: secondPrefill.selector,
        frameUrl: secondPrefill.frameUrl,
        reason: secondPrefill.reason,
        selectionReason: secondPrefill.selectionReason,
        verifiedLength: secondPrefill.verifiedLength,
        usedSequentialFallback: secondPrefill.usedSequentialFallback,
      });

      if (secondPrefill.filled) {
        prefill = secondPrefill;

        const submitInstruction = `
You are continuing a contact-form workflow.

The long message field has now been filled by the automation harness.
${secondPrefill.locked
  ? "It is locked intentionally. Do NOT click, focus, clear, edit, or retype it."
  : "Do NOT edit or retype the message field."}

Now:
1. Review that all other required fields are completed.
2. Submit/send the form.
3. Wait for and observe the result.
4. If a CAPTCHA is detected, wait for Browserbase CAPTCHA handling to complete. If it does not resolve, return: OUTCOME: CAPTCHA_BLOCKED — <captcha type>

On your FINAL line, print exactly one of:
OUTCOME: CONFIRMED — <first 200 chars of confirmation>
OUTCOME: CAPTCHA_BLOCKED — <captcha type>
OUTCOME: NO_CONFIRMATION — <what the page showed>
OUTCOME: ERROR — <what went wrong>
`.trim();

        finalAgentResult = await agent.execute({
          instruction: submitInstruction,
          maxSteps: 20,
        });
      } else {
        // Absolute final fallback: agent may enter the long message, but is instructed
        // to use direct fill/set-value first rather than simulated slow keystrokes.
        const emergencyInstruction = `
The automation harness could not directly fill the message field.

As a final fallback:
1. Locate the message/comments/inquiry field.
2. Enter the COMPLETE message below in one direct fill/set-value operation whenever possible.
3. Do NOT type character by character or use a simulated keystroke sequence unless direct fill/set-value is rejected by the site.
4. Preserve paragraph breaks exactly.
5. Submit the form and wait for a confirmation.
If a CAPTCHA is detected, wait for Browserbase CAPTCHA handling to complete.
If it does not resolve, return: OUTCOME: CAPTCHA_BLOCKED — <captcha type>

MESSAGE TO ENTER VERBATIM:
---BEGIN MESSAGE---
${message}
---END MESSAGE---

On your FINAL line, print exactly one of:
OUTCOME: CONFIRMED — <first 200 chars of confirmation>
OUTCOME: CAPTCHA_BLOCKED — <captcha type>
OUTCOME: NO_CONFIRMATION — <what the page showed>
OUTCOME: ERROR — <what went wrong>
`.trim();

        finalAgentResult = await agent.execute({
          instruction: emergencyInstruction,
          maxSteps: 34,
        });
      }
    }

    const { finalUrl, pageText } = await getFinalPageDetails(page);

    return {
      success: true,
      result: {
        message: "Stagehand agent finished",
        instructionsReceived: instructions,
        urlVisited: targetUrl,
        finalUrl,
        pageText,
        agentResult: finalAgentResult,
        initialAgentResult,
        prefill,
        secondPrefill,
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
        console.error("Stagehand close failed:", err);
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

  // Return immediately; the automation and optional callback continue in background.
  res.json({ accepted: true, job_id });

  let result;

  try {
    result = await Promise.race([
      runStagehand({
        url,
        instructions,
        message,
        message_paragraphs,
      }),
      new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              success: false,
              result: null,
              error: "render_hard_timeout_4min",
            }),
          HARD_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    result = {
      success: false,
      result: null,
      error: err.message || "unknown_error",
    };
  }

  if (!callback_url) return;

  let extraction = "";
  const agentResult = result.result?.agentResult;

  if (agentResult) {
    extraction = getAgentText(agentResult);
  }

  if (result.result?.pageText) {
    extraction += `\n\n[final_page_text]\n${result.result.pageText}`;
  }

  if (result.result?.finalUrl) {
    extraction += `\n\n[final_url] ${result.result.finalUrl}`;
  }

  if (result.result?.prefill) {
    extraction += `\n\n[prefill]\n${safeStringify({
      filled: result.result.prefill.filled,
      locked: result.result.prefill.locked,
      selector: result.result.prefill.selector,
      frameUrl: result.result.prefill.frameUrl,
      frameIndex: result.result.prefill.frameIndex,
      reason: result.result.prefill.reason,
      selectionReason: result.result.prefill.selectionReason,
      verifiedLength: result.result.prefill.verifiedLength,
      usedSequentialFallback: result.result.prefill.usedSequentialFallback,
      usableTextareaCount: result.result.prefill.usableTextareaCount,
    })}`;
  }

  if (result.result?.secondPrefill) {
    extraction += `\n\n[second_prefill]\n${safeStringify({
      filled: result.result.secondPrefill.filled,
      locked: result.result.secondPrefill.locked,
      selector: result.result.secondPrefill.selector,
      frameUrl: result.result.secondPrefill.frameUrl,
      frameIndex: result.result.secondPrefill.frameIndex,
      reason: result.result.secondPrefill.reason,
      selectionReason: result.result.secondPrefill.selectionReason,
      verifiedLength: result.result.secondPrefill.verifiedLength,
      usedSequentialFallback:
        result.result.secondPrefill.usedSequentialFallback,
      usableTextareaCount: result.result.secondPrefill.usableTextareaCount,
    })}`;
  }

  const { outcome, excerpt } = parseOutcome(extraction);

  console.log("[stagehand] run finished", {
    job_id,
    success: result.success,
    outcome,
    error: result.error,
    prefillFilled: result.result?.prefill?.filled,
    prefillLocked: result.result?.prefill?.locked,
    secondPrefillFilled: result.result?.secondPrefill?.filled,
  });

  try {
    const callbackResponse = await fetch(callback_url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-stagehand-secret":
          shared_secret || process.env.STAGEHAND_SHARED_SECRET || "",
      },
      body: JSON.stringify({
        job_id,
        success: outcome === "confirmed" || (outcome === undefined && result.success),
        outcome,
        confirmation_excerpt: excerpt,
        extraction,
        prefill: result.result?.prefill
          ? {
              filled: result.result.prefill.filled,
              locked: result.result.prefill.locked,
              selector: result.result.prefill.selector,
              frameUrl: result.result.prefill.frameUrl,
              frameIndex: result.result.prefill.frameIndex,
              reason: result.result.prefill.reason,
              selectionReason: result.result.prefill.selectionReason,
              verifiedLength: result.result.prefill.verifiedLength,
              usedSequentialFallback:
                result.result.prefill.usedSequentialFallback,
              usableTextareaCount:
                result.result.prefill.usableTextareaCount,
            }
          : null,
        secondPrefill: result.result?.secondPrefill
          ? {
              filled: result.result.secondPrefill.filled,
              locked: result.result.secondPrefill.locked,
              selector: result.result.secondPrefill.selector,
              frameUrl: result.result.secondPrefill.frameUrl,
              frameIndex: result.result.secondPrefill.frameIndex,
              reason: result.result.secondPrefill.reason,
              selectionReason: result.result.secondPrefill.selectionReason,
              verifiedLength: result.result.secondPrefill.verifiedLength,
              usedSequentialFallback:
                result.result.secondPrefill.usedSequentialFallback,
              usableTextareaCount:
                result.result.secondPrefill.usableTextareaCount,
            }
          : null,
        liveSessionUrl: result.result?.liveSessionUrl ?? null,
        result: result.result,
        error: result.error ?? null,
      }),
    });

    console.log("[stagehand] callback POST", {
      job_id,
      status: callbackResponse.status,
      ok: callbackResponse.ok,
    });
  } catch (err) {
    console.error("Callback POST failed:", err);
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Stagehand service listening on port ${PORT}`);
});
