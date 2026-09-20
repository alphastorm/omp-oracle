import assert from "node:assert/strict";
import test from "node:test";

import { parseSnapshotEntries } from "./artifact-heuristics.mjs";
import { classifyDeepResearchTurn, effortSelectionVisible, isDeepResearchMenuEntry, parseDeepResearchWidgetText, parsePowerSliderDescription, powerSliderStepKey, powerSliderTargetLabel, snapshotCanSafelySkipModelConfiguration, snapshotHasDeepResearchPill, snapshotHasModelConfigurationUi, snapshotHasModelOpener, snapshotHasPowerSliderMenu, snapshotHasSelectedLatestModel, snapshotStronglyMatchesRequestedModel, snapshotWeaklyMatchesRequestedModel } from "./chatgpt-ui-helpers.mjs";

test("a versioned Pro button opens configuration without attesting its effort", () => {
  const snapshot = '- button "6 Pro" [expanded=false, ref=e48]';
  assert.equal(snapshotHasModelOpener(snapshot), true);
  assert.equal(snapshotCanSafelySkipModelConfiguration(snapshot, { modelFamily: "pro", effort: "extended" }), false);
});

test("a checked versioned Pro row verifies family without inventing effort", () => {
  const snapshot = '- menuitemradio "6 Pro" [checked=true, ref=e60]';
  const selection = { modelFamily: "pro", effort: "extended" };
  assert.equal(snapshotWeaklyMatchesRequestedModel(snapshot, selection), true);
  assert.equal(snapshotStronglyMatchesRequestedModel(snapshot, selection), false);
});

test("only a checked Latest row attests the current model selector", () => {
  assert.equal(snapshotHasSelectedLatestModel('- menuitemradio "Latest" [checked=true, ref=e24]'), true);
  assert.equal(snapshotHasSelectedLatestModel('- menuitemradio "Latest" [checked=false, ref=e24]'), false);
});

test("the current Pro Power menu attests extended effort only while open", () => {
  const snapshot = [
    '- button "Thinking effort" [expanded=true, ref=e49]',
    '- menu "Thinking effort" [ref=e50]',
    '- menuitem "Select model" [expanded=false, ref=e51]',
    '- menuitem "Power" [ref=e52]',
  ].join("\n");
  assert.equal(snapshotHasModelConfigurationUi(snapshot), true);
  assert.equal(effortSelectionVisible(snapshot, "Extended"), true);
  assert.equal(effortSelectionVisible(snapshot, "Standard"), false);
  assert.equal(snapshotStronglyMatchesRequestedModel(snapshot, { modelFamily: "pro", effort: "extended" }), false);
  assert.equal(snapshotStronglyMatchesRequestedModel(snapshot, { modelFamily: "pro", effort: "standard" }), false);
});

test("the slider-based Thinking effort menu is recognized only when open", () => {
  const open = [
    '- button "Thinking effort" [expanded=true, ref=e121]',
    '- menu "Thinking effort" [ref=e2]',
    '- menuitem "Select model" [expanded=false, ref=e15]',
    '- menuitem "Power" [ref=e5]',
  ].join("\n");
  assert.equal(snapshotHasPowerSliderMenu(open), true);
  assert.equal(snapshotHasPowerSliderMenu('- button "Extra High" [expanded=false, ref=e117]'), false);
});

test("the slider description yields the current stop, and anything else yields nothing", () => {
  assert.deepEqual(parsePowerSliderDescription("Extra High, 4 of 5. Use Left and Right arrow keys to adjust power."), { label: "Extra High", index: 4, count: 5 });
  assert.deepEqual(parsePowerSliderDescription("Instant, 1 of 5."), { label: "Instant", index: 1, count: 5 });
  assert.equal(parsePowerSliderDescription("Use Left and Right arrow keys to adjust power."), undefined);
  assert.equal(parsePowerSliderDescription("Pro, 6 of 5."), undefined);
  assert.equal(parsePowerSliderDescription(undefined), undefined);
});

test("presets map onto the five slider stops the way compact tiers already do", () => {
  assert.equal(powerSliderTargetLabel({ modelFamily: "instant" }), "Instant");
  assert.equal(powerSliderTargetLabel({ modelFamily: "thinking", effort: "light" }), "Medium");
  assert.equal(powerSliderTargetLabel({ modelFamily: "thinking", effort: "standard" }), "Medium");
  assert.equal(powerSliderTargetLabel({ modelFamily: "thinking", effort: "extended" }), "High");
  assert.equal(powerSliderTargetLabel({ modelFamily: "thinking", effort: "heavy" }), "Extra High");
  assert.equal(powerSliderTargetLabel({ modelFamily: "pro", effort: "standard" }), "Pro");
  assert.equal(powerSliderTargetLabel({ modelFamily: "pro", effort: "extended" }), "Pro");
});

test("slider steps move toward the target and stop at unknown or reached positions", () => {
  assert.equal(powerSliderStepKey("Extra High", "Instant"), "ArrowLeft");
  assert.equal(powerSliderStepKey("Medium", "Pro"), "ArrowRight");
  assert.equal(powerSliderStepKey("High", "High"), undefined);
  assert.equal(powerSliderStepKey("Ultra", "Pro"), undefined);
});

// Fixtures below are fragments of accessibility snapshots captured on 2026-09-20 from the live
// ChatGPT composer and a real Deep Research run (.artifacts/deep-research-spike-2026-09-20).

test("the Deep research entry in the tools menu is the role-less clickable whose label starts with the title", () => {
  const menu = [
    '- generic "Add photos & filesUpload from computerAdd from library" [ref=e112] clickable [onclick]',
    '  - generic "Web searchFind real-time news and info" [ref=e124] clickable [cursor:pointer, onclick, tabindex]',
    '  - generic "Deep researchGet a detailed report" [ref=e125] clickable [cursor:pointer, onclick, tabindex]',
    '  - generic "SketchDraw and attach an image" [ref=e126] clickable [cursor:pointer, onclick, tabindex]',
  ].join("\n");
  const entries = parseSnapshotEntries(menu);
  const matches = entries.filter(isDeepResearchMenuEntry);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].ref, "@e125");
});

test("the Deep research pill is recognized only inside the composer textbox", () => {
  const enabled = [
    '- generic "(function qCe(e,t){})" [ref=e114] clickable [onclick]',
    '  - button "Add files and more" [expanded=false, ref=e120]',
    '  - textbox "Chat with ChatGPT" [ref=e121]: \ufeff',
    "Deep research",
    " ",
    '    - generic "Deep research" [ref=e126] clickable [onclick]',
    '  - button "Extra High" [expanded=false, ref=e125]',
  ].join("\n");
  assert.equal(snapshotHasDeepResearchPill(enabled), true);
  const plain = [
    '  - button "Add files and more" [expanded=false, ref=e113]',
    '  - textbox "Chat with ChatGPT" [ref=e114]',
    '  - button "Extra High" [expanded=false, ref=e117]',
    '- generic "Deep research" [ref=e200] clickable [onclick]',
  ].join("\n");
  assert.equal(snapshotHasDeepResearchPill(plain), false);
});

test("the Deep Research placeholder turn is never a completed report", () => {
  // This is the turn that satisfies the generic completion predicate (no streaming, text present,
  // a Copy response control) the moment research starts. Classifying it as "started" is what keeps
  // the worker from writing it to response.md as a finished answer.
  const widget = [
    '- button "Worked for 4s" [expanded=false, ref=e113]',
    '- Iframe "internal://deep-research" [ref=e120]',
    '  - Iframe [ref=e126]',
    '- generic "Deep Research has started working on your query. It will first present a research plan" [ref=e109] focusable [tabindex]',
    '- button "Copy response" [ref=e114]',
  ].join("\n");
  assert.equal(classifyDeepResearchTurn({ snapshot: widget, text: "Worked for 4s\nDeep Research has started working on your query." }), "started");
  // The placeholder wording is model-written; the widget alone decides.
  assert.equal(classifyDeepResearchTurn({ snapshot: widget, text: "On it. Researching the omp-oracle package now." }), "started");
  assert.equal(classifyDeepResearchTurn({ snapshot: '- button "Copy response" [ref=e114]', text: "Worked for 6s\nDeep Research has started working on your omp-oracle / pi-oracle query. It will provide a report." }), "started");
  assert.equal(classifyDeepResearchTurn({ snapshot: '- button "Copy response" [ref=e114]', text: "Before I start, which npm registry scope should I focus on?" }), "reply");
  assert.equal(classifyDeepResearchTurn({ snapshot: "", text: "" }), "reply");
});

test("the finished widget text yields the report without the animated counter, keeping citation markers", () => {
  // Shapes captured from the report frame's innerText on 2026-09-20. Each count in the header
  // renders as one 0-9 digit per line per digit column followed by its label; a two-count header
  // ("N citations · M searches") therefore carries two runs with " citations · " between them.
  const digits = Array.from({ length: 10 }, (_, digit) => String(digit));
  const body = [
    "`omp-oracle` vs. `pi-oracle`: Package and Relationship Analysis",
    "Executive summary",
    "",
    "omp-oracle is a renamed, history-preserving fork.",
    "1",
    "",
    "Package profile",
  ];
  for (const header of [
    ["Research completed in 2m · ", ...digits, ...digits, ...digits, " citations ·  searches"],
    ["Research completed in 4m · ", ...digits, ...digits, " citations · ", ...digits, ...digits, ...digits, " searches"],
  ]) {
    const parsed = parseDeepResearchWidgetText([...header, ...body].join("\n"));
    assert.equal(parsed.completed, true);
    assert.equal(parsed.report.startsWith("`omp-oracle` vs. `pi-oracle`"), true, `body starts after the header: ${parsed.report.slice(0, 40)}`);
    assert.equal(parsed.report.includes("fork.\n1\n\nPackage profile"), true, "citation markers in the body survive");
    assert.equal(/\n0\n1\n2/.test(parsed.report), false, "the counter runs are stripped");
  }
  assert.deepEqual(parseDeepResearchWidgetText(""), { completed: false, report: "" });
  assert.deepEqual(parseDeepResearchWidgetText("Researching…\nReading sources"), { completed: false, report: "" });
});
