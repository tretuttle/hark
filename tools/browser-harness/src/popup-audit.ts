// Audits of the real popup document: contrast, accessible names, size, motion and copy. The pure rules are plain
// functions so Node tests run them on sample inputs; the in-page script embeds their source, so the browser runs the
// same code.

export type Rgba = {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
};

/** A computed `rgb()` or `rgba()` value. */
export function parseColor(css: string): Rgba {
  const inner = /rgba?\(([^)]+)\)/u.exec(css)?.[1] ?? "0 0 0 0";
  const parts = inner
    .split(/[\s,/]+/u)
    .filter((p) => p.length > 0)
    .map(Number);
  return { r: parts[0] ?? 0, g: parts[1] ?? 0, b: parts[2] ?? 0, a: parts[3] ?? 1 };
}

/** WCAG 2.1 contrast ratio of two opaque colours. */
export function contrastRatio(a: Rgba, b: Rgba): number {
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (c: Rgba) =>
    0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Product copy rules: no en or em dash, no emoji. */
export function copyProblems(text: string): string[] {
  const problems: string[] = [];
  const dash = new RegExp("[\\u2013\\u2014]", "u").exec(text);
  if (dash !== null)
    problems.push(
      `dash U+${dash[0].codePointAt(0)!.toString(16)} in "${text.slice(Math.max(0, dash.index - 30), dash.index + 30)}"`,
    );
  const emoji = /\p{Extended_Pictographic}/u.exec(text);
  if (emoji !== null)
    problems.push(`emoji in "${text.slice(Math.max(0, emoji.index - 30), emoji.index + 30)}"`);
  return problems;
}

export type PopupBox = {
  /** The popup's `<browser>` in the browser window, as the user sees it. */
  readonly width: number;
  readonly height: number;
  /** The document's full size, which is larger than the box when content scrolls. */
  readonly scrollWidth: number;
  readonly scrollHeight: number;
};

const POPUP_LIMIT = { width: 400, height: 600 } as const;

export function sizeProblems(box: PopupBox): string[] {
  const problems: string[] = [];
  const width = Math.max(box.width, box.scrollWidth);
  const height = Math.max(box.height, box.scrollHeight);
  if (width > POPUP_LIMIT.width)
    problems.push(`popup ${String(width)} px wide, limit ${String(POPUP_LIMIT.width)}`);
  if (height > POPUP_LIMIT.height)
    problems.push(`popup ${String(height)} px tall, limit ${String(POPUP_LIMIT.height)}`);
  return problems;
}

export type DomAudit = {
  readonly problems: readonly string[];
  readonly checked: {
    readonly text: number;
    readonly icons: number;
    readonly borders: number;
    readonly controls: number;
  };
  readonly scrollWidth: number;
  readonly scrollHeight: number;
};

/**
 * Runs in a page that can reach the popup's window as `w`, with the helpers above passed in as `h`. Plain JavaScript:
 * it is sent to the browser as source text. Disabled controls are exempt from contrast, as in WCAG 1.4.3.
 */
const DOM_AUDIT = `(w, h) => {
  const doc = w.document;
  const style = (el, pseudo) => w.getComputedStyle(el, pseudo ?? null);
  const over = (top, bottom) => ({
    r: top.r * top.a + bottom.r * (1 - top.a),
    g: top.g * top.a + bottom.g * (1 - top.a),
    b: top.b * top.a + bottom.b * (1 - top.a),
    a: 1,
  });
  const backgroundOf = (el) => {
    const layers = [];
    for (let e = el; e; e = e.parentElement) {
      const c = h.parseColor(style(e).backgroundColor);
      if (c.a > 0) layers.push(c);
      if (c.a === 1) break;
    }
    let acc = layers.pop() ?? h.parseColor(style(doc.documentElement).backgroundColor);
    if (acc.a < 1) acc = over(acc, { r: 255, g: 255, b: 255, a: 1 });
    while (layers.length > 0) acc = over(layers.pop(), acc);
    return acc;
  };
  const describe = (el) => "<" + el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\\s+/).join(".") : "") + "> \\"" + (el.textContent ?? "").trim().slice(0, 40) + "\\"";
  const shown = (el) => {
    const r = el.getBoundingClientRect();
    const s = style(el);
    return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
  };
  const disabled = (el) => el.closest(":disabled") !== null;
  const problems = [];
  const checked = { text: 0, icons: 0, borders: 0, controls: 0 };
  for (const el of doc.body.querySelectorAll("*")) {
    const s = style(el);
    if (s.animationName !== "none" || s.transitionDuration.split(",").some((d) => parseFloat(d) > 0))
      problems.push("motion on " + describe(el));
    if (!shown(el) || disabled(el) || ["SCRIPT", "STYLE", "OPTION"].includes(el.tagName)) continue;
    const ownText = [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim() !== "");
    const field = (el.tagName === "INPUT" && !["checkbox", "radio"].includes(el.type)) || el.tagName === "SELECT";
    if (ownText || (field && el.value)) {
      checked.text += 1;
      const px = parseFloat(s.fontSize);
      const weight = parseInt(s.fontWeight, 10);
      const large = px >= 24 || (px >= 18.66 && weight >= 700);
      const ratio = h.contrastRatio(h.parseColor(s.color), backgroundOf(el));
      const min = large ? 3 : 4.5;
      if (ratio < min) problems.push("text contrast " + ratio.toFixed(2) + ":1, needs " + min + ", " + describe(el));
      if (px < 12) problems.push("text below 12 px: " + describe(el));
    }
    if (el.tagName === "INPUT" && el.placeholder) {
      checked.text += 1;
      const ratio = h.contrastRatio(h.parseColor(style(el, "::placeholder").color), backgroundOf(el));
      if (ratio < 4.5) problems.push("placeholder contrast " + ratio.toFixed(2) + ":1, " + describe(el));
    }
    if (el.tagName.toLowerCase() === "svg" && el.classList.contains("ic")) {
      checked.icons += 1;
      const ratio = h.contrastRatio(h.parseColor(s.color), backgroundOf(el.parentElement));
      if (ratio < 3) problems.push("icon contrast " + ratio.toFixed(2) + ":1, needs 3, in " + describe(el.parentElement));
    }
    if (el.matches(".ctl, .seg, .btn-secondary, .preset") && s.borderTopWidth !== "0px") {
      checked.borders += 1;
      const ratio = h.contrastRatio(h.parseColor(s.borderTopColor), backgroundOf(el.parentElement));
      if (ratio < 3) problems.push("control border " + ratio.toFixed(2) + ":1, needs 3, " + describe(el));
    }
  }
  for (const el of doc.querySelectorAll("button, a[href], input, select, textarea, summary, [role=button]")) {
    checked.controls += 1;
    if (["INPUT", "SELECT"].includes(el.tagName) && !["checkbox", "radio"].includes(el.type) && shown(el)) {
      const sized = el.tagName === "SELECT" || /^(date|time|datetime-local|month|week)$/.test(el.type);
      let needs = el.scrollWidth;
      if (sized) {
        const copy = el.cloneNode(true);
        copy.removeAttribute("id");
        copy.style.cssText = "position:absolute;visibility:hidden;width:max-content;max-width:none";
        el.parentElement.append(copy);
        needs = copy.getBoundingClientRect().width;
        copy.remove();
      }
      const has = sized ? el.getBoundingClientRect().width : el.clientWidth;
      if (needs > has + 1)
        problems.push("content clipped (" + Math.round(needs) + " px in " + Math.round(has) + "): " + describe(el));
    }
    const labelled = el.getAttribute("aria-labelledby");
    const name = [
      el.getAttribute("aria-label"),
      labelled ? labelled.split(/\\s+/).map((id) => doc.getElementById(id)?.textContent ?? "").join(" ") : null,
      el.labels ? [...el.labels].map((l) => l.textContent).join(" ") : null,
      el.tagName === "INPUT" || el.tagName === "SELECT" ? null : el.textContent,
      el.getAttribute("title"),
      el.getAttribute("placeholder"),
    ].find((v) => v !== null && v !== undefined && v.trim() !== "");
    if (name === undefined) problems.push("no accessible name: " + describe(el));
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) < 0) problems.push("removed from tab order: " + describe(el));
  }
  const attributes = [...doc.querySelectorAll("[aria-label], [title], [placeholder], [alt]")]
    .flatMap((el) => ["aria-label", "title", "placeholder", "alt"].map((a) => el.getAttribute(a) ?? ""));
  problems.push(...h.copyProblems([doc.title, doc.body.innerText, ...attributes].join("\\n")));
  return {
    problems,
    checked,
    scrollWidth: doc.documentElement.scrollWidth,
    scrollHeight: doc.documentElement.scrollHeight,
  };
}`;

/** An expression for an extension page of the same add-on: audits the open popup, or rejects when none is open. */
export const popupAuditExpression = (): string => `(() => {
  const w = browser.extension.getViews({ type: "popup" })[0];
  if (w === undefined) throw new Error("no popup is open");
  const h = { parseColor: ${parseColor.toString()}, contrastRatio: ${contrastRatio.toString()}, copyProblems: ${copyProblems.toString()} };
  return (${DOM_AUDIT})(w, h);
})()`;

/** An expression for an extension page in a tab: the same audits run on that page's own document. */
export const pageAuditExpression = (): string => `(() => {
  const h = { parseColor: ${parseColor.toString()}, contrastRatio: ${contrastRatio.toString()}, copyProblems: ${copyProblems.toString()} };
  return (${DOM_AUDIT})(window, h);
})()`;
