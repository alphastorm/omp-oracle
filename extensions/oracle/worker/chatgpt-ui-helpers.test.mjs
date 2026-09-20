import assert from "node:assert/strict";
import test from "node:test";

import { effortSelectionVisible, parsePowerSliderDescription, powerSliderStepKey, powerSliderTargetLabel, snapshotCanSafelySkipModelConfiguration, snapshotHasModelConfigurationUi, snapshotHasModelOpener, snapshotHasPowerSliderMenu, snapshotHasSelectedLatestModel, snapshotStronglyMatchesRequestedModel, snapshotWeaklyMatchesRequestedModel } from "./chatgpt-ui-helpers.mjs";

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
