require("dotenv").config();

const express = require("express");
const { Stagehand } = require("@browserbasehq/stagehand");

const app = express();
app.use(express.json({ limit: "2mb" }));

app.get("/", (_req, res) => res.send("Stagehand service is running"));

const PORT = process.env.PORT || 3000;
const HARD_TIMEOUT_MS = 4 * 60 * 1000;
const INITIAL_RENDER_WAIT_MS = 12_000;
const POST_AGENT_RENDER_WAIT_MS = 10_000;

const MESSAGE_REGEX =
  /message|comments?|inquir(?:y|ies)|questions?|details|notes|tell us|how can we help|your\s*message|additional\s*(?:info|information)|describe|reason\s*(?:for|of)|what\s*can\s*we\s*help|anything\s*else|enquiry/i;

const HONEYPOT_REGEX =
  /honeypot|url2|trap|bot|website\b|company_website|confirm_email|email_confirm/i;

const SHORT_FIELD_REGEX =
  /first\s*name|last\s*name|full\s*name|name\b|email|e-mail|phone|mobile|tel\b|company|organization|business|address|city|state|zip|postal|country|subject|service|procedure|budget|date|time|birthday|birth\s*date/i;

const CONTACT_LINK_REGEX =
  /contact|reach us|inquir|appointment|consultation|get in touch|request|book/i;

const EDITABLE_SELECTOR = [
  "textarea",
  "input[type='text']",
  "input:not([type])",
  "[contenteditable='true']",
  "[role='textbox']",
  ".ProseMirror",
  ".ql-editor",
  ".public-DraftEditor-content",
  "[data-lexical-editor='true']",
].join(", ");

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

function sanitizeForCallback(value, maxLength = 2000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function candidateSummary(candidate) {
  const { frame, ...summary } = candidate;
  return summary;
}

function summarizeCandidates(candidates) {
  return candidates.map(candidateSummary);
}

async function waitForEditableControl(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      try {
        if (await frame.locator(EDITABLE_SELECTOR).count()) {
          return true;
        }
      } catch {}
    }

    await sleep(400);
  }

  return false;
}

async function clickLikelyContactLink(page) {
  try {
    const link = page
      .getByRole("link", { name: CONTACT_LINK_REGEX })
      .first();

    if (!(await link.count())) return false;

    await link.click({ timeout: 5000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {});
    await sleep(1000);

    return true;
  } catch {
    return false;
  }
}

async function inspectEditableControl(frame, frameIndex, locator, index) {
  return locator
    .evaluate(
      (el, { frameIndex, index, messageRegexSource, honeypotRegexSource, shortFieldRegexSource }) => {
        const messageRe = new RegExp(messageRegexSource, "i");
        const honeypotRe = new RegExp(honeypotRegexSource, "i");
        const shortFieldRe = new RegExp(shortFieldRegexSource, "i");

        const style = window.getComputedStyle(el);
        const rect = el.getBoundingClientRect();

        const visible =
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          style.opacity !== "0" &&
          rect.width > 0 &&
          rect.height > 0;

        const tag = el.tagName.toLowerCase();
        const type = (el.getAttribute("type") || "").toLowerCase();

        const isInput = tag === "input";
        const isTextarea = tag === "textarea";
        const isContentEditable =
          el.getAttribute("contenteditable") === "true" ||
          el.isContentEditable ||
          el.getAttribute("role") === "textbox";

        const name = el.getAttribute("name") || "";
        const id = el.getAttribute("id") || "";
        const placeholder = el.getAttribute("placeholder") || "";
        const ariaLabel = el.getAttribute("aria-label") || "";
        const ariaDescribedBy = el.getAttribute("aria-describedby") || "";
        const role = el.getAttribute("role") || "";

        let describedByText = "";
        for (const idPart of ariaDescribedBy.split(/\s+/).filter(Boolean)) {
          const described = document.getElementById(idPart);
          if (described) describedByText += ` ${described.textContent || ""}`;
        }

        let labelText = "";

        if (id) {
          const explicitLabel = document.querySelector(
            `label[for="${CSS.escape(id)}"]`,
          );
          if (explicitLabel) labelText = explicitLabel.textContent || "";
        }

        if (!labelText) {
          const wrappingLabel = el.closest("label");
          if (wrappingLabel) labelText = wrappingLabel.textContent || "";
        }

        const group = el.closest(
          ".gfield, .form-group, .field, .field-wrap, .form-field, .hs-form-field, .wpcf7-form-control-wrap, li, p, fieldset, [data-field]",
        );

        const groupText = group?.innerText || "";
        const legendText = el.closest("fieldset")?.querySelector("legend")?.innerText || "";
        const formText = el.closest("form")?.innerText?.slice(0, 2500) || "";

        const rows = Number.parseInt(el.getAttribute("rows") || "0", 10) || 0;
        const cols = Number.parseInt(el.getAttribute("cols") || "0", 10) || 0;

        const textContext = [
          name,
          id,
          placeholder,
          ariaLabel,
          describedByText,
          labelText,
          legendText,
          groupText,
          role,
        ]
          .join(" ")
          .replace(/\s+/g, " ")
          .trim();

        const lowerContext = textContext.toLowerCase();

        const disabled =
          Boolean(el.disabled) ||
          el.getAttribute("aria-disabled") === "true";

        const readOnly =
          Boolean(el.readOnly) ||
          el.getAttribute("aria-readonly") === "true";

        const hiddenByAttribute =
          el.hasAttribute("hidden") ||
          el.getAttribute("aria-hidden") === "true" ||
          type === "hidden";

        const existingValue =
          typeof el.value === "string"
            ? el.value
            : el.innerText || el.textContent || "";

        let score = 0;

        if (isTextarea) score += 10;
        if (isContentEditable) score += 8;
        if (role === "textbox") score += 6;
        if (messageRe.test(textContext)) score += 18;
        if (messageRe.test(labelText)) score += 7;
        if (messageRe.test(placeholder)) score += 5;
        if (messageRe.test(name) || messageRe.test(id)) score += 5;

        if (rect.height >= 80) score += 8;
        else if (rect.height >= 45) score += 3;

        if (rows >= 3) score += 5;
        if (cols >= 30) score += 2;

        // A plain input should need strong semantic evidence before it is treated
        // as a long-message target.
        if (isInput) score -= 10;

        if (shortFieldRe.test(textContext)) score -= 25;
        if (honeypotRe.test(textContext)) score -= 40;
        if (!visible || hiddenByAttribute) score -= 50;
        if (disabled || readOnly) score -= 50;

        const likelyLongText =
          isTextarea ||
          isContentEditable ||
          rect.height >= 70 ||
          rows >= 3 ||
          role === "textbox";

        const safeAsMessageTarget =
          score >= 12 ||
          (likelyLongText && score >= 0 && !shortFieldRe.test(textContext));

        return {
          frameIndex,
          frameUrl: window.location.href,
          index,
          tag,
          type,
          name,
          id,
          placeholder,
          ariaLabel,
          role,
          labelText: labelText.trim().slice(0, 500),
          context: textContext.slice(0, 1200),
          formText: formText.slice(0, 1200),
          visible,
          disabled,
          readOnly,
          hiddenByAttribute,
          isTextarea,
          isInput,
          isContentEditable,
          likelyLongText,
          safeAsMessageTarget,
          score,
          width: Math.round(rect.width),
          height: Math.round(rect.height),
          rows,
          cols,
          existingValueLength: String(existingValue || "").length,
        };
      },
      {
        frameIndex,
        index,
        messageRegexSource: MESSAGE_REGEX.source,
        honeypotRegexSource: HONEYPOT_REGEX.source,
        shortFieldRegexSource: SHORT_FIELD_REGEX.source,
      },
    )
    .catch((err) => ({
      frameIndex,
      index,
      error: `inspect_error: ${err.message || err}`,
      score: -999,
    }));
}

async function inventoryEditableControls(page) {
  const candidates = [];
  const frames = page.frames();

  for (let frameIndex = 0; frameIndex < frames.length; frameIndex++) {
    const frame = frames[frameIndex];

    let count = 0;
    try {
      count = await frame.locator(EDITABLE_SELECTOR).count();
    } catch {
      continue;
    }

    for (let index = 0; index < count; index++) {
      const locator = frame.locator(EDITABLE_SELECTOR).nth(index);
      const info = await inspectEditableControl(frame, frameIndex, locator, index);

      candidates.push({
        ...info,
        frame,
        selector: EDITABLE_SELECTOR,
      });
    }

    // Rich-text editors sometimes use an iframe whose body is contenteditable.
    // This handles accessible iframe editor documents as a special candidate.
    try {
      const body = frame.locator("body[contenteditable='true']").first();
      if (await body.count()) {
        const bodyInfo = await inspectEditableControl(
          frame,
          frameIndex,
          body,
          -1,
        );

        candidates.push({
          ...bodyInfo,
          frame,
          selector: "body[contenteditable='true']",
          isIframeBodyEditor: true,
        });
      }
    } catch {}
  }

  return candidates;
}

function chooseMessageCandidate(candidates) {
  const eligible = candidates.filter(
    (candidate) =>
      !candidate.error &&
      candidate.visible &&
      !candidate.disabled &&
      !candidate.readOnly &&
      !candidate.hiddenByAttribute &&
      candidate.safeAsMessageTarget,
  );

  const sorted = [...eligible].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.height !== a.height) return b.height - a.height;
    return a.index - b.index;
  });

  if (sorted.length) {
    return {
      candidate: sorted[0],
      reason: "highest_scoring_eligible_candidate",
      eligible,
    };
  }

  // Conservative fallback: only use a sole visible textarea/contenteditable,
  // never a generic short text input.
  const longControls = candidates.filter(
    (candidate) =>
      !candidate.error &&
      candidate.visible &&
      !candidate.disabled &&
      !candidate.readOnly &&
      !candidate.hiddenByAttribute &&
      (candidate.isTextarea || candidate.isContentEditable) &&
      !HONEYPOT_REGEX.test(candidate.context || ""),
  );

  if (longControls.length === 1) {
    return {
      candidate: longControls[0],
      reason: "only_visible_long_text_control",
      eligible: longControls,
    };
  }

  return {
    candidate: null,
    reason: "no_safe_message_candidate",
    eligible,
  };
}

function buildLocatorFromCandidate(candidate) {
  return candidate.frame.locator(candidate.selector).nth(candidate.index);
}

async function readControlValue(locator, candidate) {
  try {
    if (candidate.isTextarea || candidate.isInput) {
      return await locator.inputValue();
    }

    return await locator.evaluate((el) => el.innerText || el.textContent || "");
  } catch {
    return "";
  }
}

async function dispatchFrameworkEvents(locator) {
  return locator
    .evaluate((el) => {
      try {
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));
        return true;
      } catch {
        return false;
      }
    })
    .catch(() => false);
}

async function nativeValueSetterFallback(locator, candidate, message) {
  if (!candidate.isTextarea && !candidate.isInput) return false;

  return locator
    .evaluate((el, value) => {
      const proto =
        el.tagName.toLowerCase() === "textarea"
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;

      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");

      if (!descriptor?.set) return false;

      descriptor.set.call(el, value);

      el.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: value,
        }),
      );

      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));

      return true;
    }, message)
    .catch(() => false);
}

async function contentEditableFallback(locator, candidate, message) {
  if (!candidate.isContentEditable) return false;

  return locator
    .evaluate((el, value) => {
      try {
        el.focus();

        // Replace existing content in an editor-compatible way where possible.
        const selection = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        range.collapse(true);

        selection?.removeAllRanges();
        selection?.addRange(range);

        // execCommand remains useful for a broad set of browser editors.
        const inserted = document.execCommand("insertText", false, value);

        if (!inserted) {
          el.textContent = value;
        }

        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            inputType: "insertText",
            data: value,
          }),
        );

        el.dispatchEvent(new Event("change", { bubbles: true }));
        el.dispatchEvent(new Event("blur", { bubbles: true }));

        return true;
      } catch {
        return false;
      }
    }, message)
    .catch(() => false);
}

async function lockMessageControl(locator) {
  return locator
    .evaluate((el) => {
      try {
        el.setAttribute("data-lovable-prefilled", "1");

        if ("readOnly" in el) {
          el.readOnly = true;
        } else {
          el.setAttribute("contenteditable", "false");
          el.setAttribute("aria-readonly", "true");
        }

        if (typeof el.blur === "function") el.blur();
        return true;
      } catch {
        return false;
      }
    })
    .catch(() => false);
}

async function fillMessageCandidate(candidate, message, { lock = true } = {}) {
  const locator = buildLocatorFromCandidate(candidate);
  const minVerifiedLength = Math.min(20, String(message).length);

  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => {});
    await locator.click({ timeout: 5000 }).catch(() => {});

    // Preferred fast path. Playwright fill handles input, textarea and
    // contenteditable fields without character-by-character typing.
    await locator.fill(message, { timeout: 12_000 });

    await dispatchFrameworkEvents(locator);

    let value = await readControlValue(locator, candidate);

    if (value.length >= minVerifiedLength) {
      const locked = lock ? await lockMessageControl(locator) : false;

      return {
        filled: true,
        locked,
        method: "locator.fill",
        verifiedLength: value.length,
        candidate: candidateSummary(candidate),
      };
    }
  } catch {}

  // Framework fallback for React/Vue/Angular-style controlled inputs.
  const nativeSet = await nativeValueSetterFallback(locator, candidate, message);

  if (nativeSet) {
    await sleep(150);

    const value = await readControlValue(locator, candidate);

    if (value.length >= minVerifiedLength) {
      const locked = lock ? await lockMessageControl(locator) : false;

      return {
        filled: true,
        locked,
        method: "native_value_setter",
        verifiedLength: value.length,
        candidate: candidateSummary(candidate),
      };
    }
  }

  // Rich text / contenteditable fallback.
  const editorSet = await contentEditableFallback(locator, candidate, message);

  if (editorSet) {
    await sleep(150);

    const value = await readControlValue(locator, candidate);

    if (value.length >= minVerifiedLength) {
      const locked = lock ? await lockMessageControl(locator) : false;

      return {
        filled: true,
        locked,
        method: "contenteditable_injection",
        verifiedLength: value.length,
        candidate: candidateSummary(candidate),
      };
    }
  }

  return {
    filled: false,
    locked: false,
    method: null,
    verifiedLength: 0,
    candidate: candidateSummary(candidate),
    reason: "all_direct_fill_strategies_failed",
  };
}

async function directFillMessage(page, message, { waitMs = 0, lock = true } = {}) {
  if (!message) {
    return {
      filled: false,
      locked: false,
      reason: "no_message",
      inventory: [],
    };
  }

  if (waitMs > 0) {
    await waitForEditableControl(page, waitMs);
  }

  const inventory = await inventoryEditableControls(page);
  const { candidate, reason, eligible } = chooseMessageCandidate(inventory);

  if (!candidate) {
    return {
      filled: false,
      locked: false,
      reason,
      eligibleCount: eligible.length,
      inventory: summarizeCandidates(inventory),
    };
  }

  const result = await fillMessageCandidate(candidate, message, { lock });

  return {
    ...result,
    selectionReason: reason,
    eligibleCount: eligible.length,
    inventory: summarizeCandidates(inventory),
  };
}

function parseOutcome(text) {
  if (!text) return { outcome: undefined, excerpt: null };

  const match = String(text).match(
    /OUTCOME:\s*(CONFIRMED|CAPTCHA_BLOCKED|READY_FOR_MESSAGE|MESSAGE_FIELD_NOT_AUTOMATABLE|NO_CONFIRMATION|ERROR)\s*[—:-]?\s*(.{0,500})?/i,
  );

  if (!match) return { outcome: undefined, excerpt: null };

  return {
    outcome: match[1].toLowerCase(),
    excerpt: (match[2] || "").trim().slice(0, 300) || null,
  };
}

function agentResultToText(agentResult) {
  if (!agentResult) return "";
  if (typeof agentResult === "string") return agentResult;

  return [
    agentResult.message,
    agentResult.result,
    agentResult.output,
    agentResult.text,
    agentResult.summary,
    safeStringify(agentResult),
  ]
    .filter(Boolean)
    .join("\n");
}

async function getFinalPageDetails(page) {
  let finalUrl = "";
  let pageText = "";

  try {
    finalUrl = page.url();
  } catch {}

  try {
    pageText = (await page.locator("body").innerText()).slice(0, 2500);
  } catch {}

  return { finalUrl, pageText };
}

async function runStagehand({
  url,
  instructions,
  message,
  message_paragraphs,
  allow_agent_message_typing = false,
}) {
  let stagehand;

  try {
    stagehand = new Stagehand({ env: "BROWSERBASE" });
    await stagehand.init();

    const page = stagehand.context.pages()[0];

// TEMPORARY DIAGNOSTICS — remove after you send me the Render logs
try {
  console.log(
    "Stagehand version:",
    require("@browserbasehq/stagehand/package.json").version,
  );
} catch (err) {
  console.log("Could not read Stagehand version:", err.message);
}

console.log(
  "page methods:",
  Object.getOwnPropertyNames(Object.getPrototypeOf(page)),
);

const testLocator = page.locator("textarea");

console.log(
  "locator methods:",
  Object.getOwnPropertyNames(Object.getPrototypeOf(testLocator)),
);



    
    const targetUrl = url || "https://example.com";

    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {});
    await sleep(750);

    // PHASE 1: Deterministic attempt before the AI touches the form.
    let initialPrefill = await directFillMessage(page, message, {
      waitMs: INITIAL_RENDER_WAIT_MS,
      lock: true,
    });

    console.log("[stagehand] initial message fill", {
      filled: initialPrefill.filled,
      method: initialPrefill.method,
      reason: initialPrefill.reason,
      selectionReason: initialPrefill.selectionReason,
      candidate: initialPrefill.candidate?.context,
    });

    // If the contact form is not on the initially loaded screen, make a modest
    // deterministic navigation attempt before handing navigation to the agent.
    if (!initialPrefill.filled) {
      await clickLikelyContactLink(page);
    }

    const agent = stagehand.agent({
      model: "anthropic/claude-sonnet-4-6",
    });

    let preparationResult = null;
    let finalAgentResult = null;
    let secondPrefill = null;

    if (!initialPrefill.filled && message) {
      // PHASE 2: The agent prepares the form but never receives the long message.
      const preparationInstruction = `
You are preparing a contact-form submission in a real browser.

Your task:
- Navigate to the correct contact, inquiry, appointment, or consultation form.
- Open required modals, expand accordions, complete required preliminary steps, and make the complete form visible.
- Fill all required SHORT fields using the information in the original task: name, email, phone, subject, dropdowns, consent boxes, etc.
- Do NOT fill, edit, click, or focus the long message/comments/details/inquiry field.
- Do NOT submit the form.

Stop only when the message/comments/details field is visible, enabled, and ready for external automation to fill.

On your FINAL line, print exactly:
OUTCOME: READY_FOR_MESSAGE — <label, placeholder, or brief description of the message field>
or:
OUTCOME: CAPTCHA_BLOCKED — <captcha type>
or:
OUTCOME: ERROR — <what prevented form preparation>

Original task:
${instructions}
`.trim();

      preparationResult = await agent.execute({
        instruction: preparationInstruction,
        maxSteps: 28,
      });

      // PHASE 3: Re-inventory the rendered state and use direct fill again.
      secondPrefill = await directFillMessage(page, message, {
        waitMs: POST_AGENT_RENDER_WAIT_MS,
        lock: true,
      });

      console.log("[stagehand] post-preparation message fill", {
        filled: secondPrefill.filled,
        method: secondPrefill.method,
        reason: secondPrefill.reason,
        selectionReason: secondPrefill.selectionReason,
        candidate: secondPrefill.candidate?.context,
      });
    }

    const successfulPrefill =
      initialPrefill.filled ? initialPrefill : secondPrefill?.filled ? secondPrefill : null;

    if (successfulPrefill) {
      // PHASE 4: Submit only. The message is never supplied to the agent.
      const submitInstruction = `
You are completing a contact-form submission in a real browser.

The long message field has already been filled by the automation harness.
${successfulPrefill.locked
  ? "It has been intentionally locked. Do NOT click, focus, clear, edit, or retype it."
  : "Do NOT edit, clear, or retype the message field."}

Your task:
- Verify the other required fields are complete.
- Submit/send the form.
- Wait for the result and inspect the page.
- If a CAPTCHA is displayed, wait briefly for configured browser handling. If it remains blocked, report it.

On your FINAL line, print exactly one of:
OUTCOME: CONFIRMED — <first 200 chars of confirmation>
OUTCOME: CAPTCHA_BLOCKED — <captcha type>
OUTCOME: NO_CONFIRMATION — <what the page showed>
OUTCOME: ERROR — <what went wrong>
`.trim();

      finalAgentResult = await agent.execute({
        instruction: submitInstruction,
        maxSteps: 16,
      });
    } else if (allow_agent_message_typing && message) {
      // Explicitly opt-in only. This is disabled by default to avoid the slow
      // agent typing behaviour that prompted this redesign.
      const emergencyInstruction = `
The deterministic automation harness could not identify a safe long-message field.

As a last-resort fallback, complete the contact-form task below.
Use a browser direct fill/set-value action for the message field whenever available.
Do NOT use character-by-character typing unless the page rejects direct filling.
Submit the form and wait for the result.

MESSAGE TO ENTER VERBATIM:
---BEGIN MESSAGE---
${message}
---END MESSAGE---

Original task:
${instructions}

On your FINAL line, print exactly one of:
OUTCOME: CONFIRMED — <first 200 chars of confirmation>
OUTCOME: CAPTCHA_BLOCKED — <captcha type>
OUTCOME: NO_CONFIRMATION — <what the page showed>
OUTCOME: ERROR — <what went wrong>
`.trim();

      finalAgentResult = await agent.execute({
        instruction: emergencyInstruction,
        maxSteps: 28,
      });
    } else {
      finalAgentResult = {
        outcome: "MESSAGE_FIELD_NOT_AUTOMATABLE",
        message:
          "No safely identifiable editable long-message control was found after deterministic discovery and agent form preparation.",
      };
    }

    const { finalUrl, pageText } = await getFinalPageDetails(page);

    return {
      success: true,
      result: {
        message: "Stagehand workflow finished",
        instructionsReceived: instructions,
        urlVisited: targetUrl,
        finalUrl,
        pageText,
        agentResult: finalAgentResult,
        preparationResult,
        initialPrefill,
        secondPrefill,
        messagePrefill: successfulPrefill,
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
    allow_agent_message_typing = false,
  } = req.body || {};

  if (!instructions) {
    return res.status(400).json({
      accepted: false,
      error: "Missing 'instructions'",
    });
  }

  // Asynchronous job acknowledgment.
  res.json({ accepted: true, job_id });

  let result;

  try {
    result = await Promise.race([
      runStagehand({
        url,
        instructions,
        message,
        message_paragraphs,
        allow_agent_message_typing,
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
    extraction += agentResultToText(agentResult);
  }

  if (result.result?.preparationResult) {
    extraction += `\n\n[preparation_result]\n${agentResultToText(
      result.result.preparationResult,
    )}`;
  }

  if (result.result?.pageText) {
    extraction += `\n\n[final_page_text]\n${result.result.pageText}`;
  }

  if (result.result?.finalUrl) {
    extraction += `\n\n[final_url] ${result.result.finalUrl}`;
  }

  for (const key of ["initialPrefill", "secondPrefill", "messagePrefill"]) {
    const prefill = result.result?.[key];
    if (!prefill) continue;

    extraction += `\n\n[${key}]\n${safeStringify({
      filled: prefill.filled,
      locked: prefill.locked,
      method: prefill.method,
      reason: prefill.reason,
      selectionReason: prefill.selectionReason,
      verifiedLength: prefill.verifiedLength,
      candidate: prefill.candidate,
      eligibleCount: prefill.eligibleCount,
      inventory: prefill.inventory?.slice(0, 30),
    })}`;
  }

  const { outcome, excerpt } = parseOutcome(extraction);

  const messagePrefill = result.result?.messagePrefill || null;

  const success =
    outcome === "confirmed" ||
    (outcome === undefined && result.success && Boolean(messagePrefill?.filled));

  console.log("[stagehand] run finished", {
    job_id,
    success,
    outcome,
    error: result.error,
    messageFilled: messagePrefill?.filled || false,
    messageMethod: messagePrefill?.method || null,
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
        success,
        outcome,
        confirmation_excerpt: excerpt,
        extraction,
        messagePrefill,
        initialPrefill: result.result?.initialPrefill || null,
        secondPrefill: result.result?.secondPrefill || null,
        liveSessionUrl: result.result?.liveSessionUrl || null,
        result: result.result,
        error: result.error || null,
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

app.listen(PORT, () => {
  console.log(`Stagehand service listening on port ${PORT}`);
});
