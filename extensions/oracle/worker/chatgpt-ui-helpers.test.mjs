import assert from "node:assert/strict";
import test from "node:test";

import { effortSelectionVisible, snapshotCanSafelySkipModelConfiguration, snapshotHasModelConfigurationUi, snapshotHasModelOpener, snapshotHasSelectedLatestModel, snapshotStronglyMatchesRequestedModel, snapshotWeaklyMatchesRequestedModel } from "./chatgpt-ui-helpers.mjs";

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
