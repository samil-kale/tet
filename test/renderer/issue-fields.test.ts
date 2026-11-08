import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sectionsOf } from "../../src/renderer/editor/issue-fields";
import type { IssueField } from "../../src/shared/types/providers";

const pick = (id: string): IssueField => ({ id, name: id, editable: true, kind: "pick", value: [], several: false, shown: "text" });
const typed = (id: string, group?: string): IssueField => ({ id, name: id, group, editable: true, kind: "date", value: undefined });
const timelog = (id: string, group?: string): IssueField => ({ id, name: id, group, editable: true, kind: "timelog", entries: [] });

describe("an issue's fields as sections", () => {
  it("makes a section of each field alone and of each group's fields together, at the first one's place", () => {
    assert.deepEqual(
      sectionsOf([pick("labels"), typed("start", "Dates"), pick("milestone"), typed("due", "Dates"), typed("weight")]).map((section) =>
        "group" in section ? [section.group, section.fields.map((field) => field.id)] : section.field.id,
      ),
      ["labels", ["Dates", ["start", "due"]], "milestone", "weight"],
    );
  });

  it("groups typed fields of different kinds", () => {
    const [section] = sectionsOf([typed("estimate", "Time tracking"), timelog("spent", "Time tracking")]);
    assert.deepEqual("group" in section && section.fields.map((field) => field.kind), ["date", "timelog"]);
  });

  it("leaves a grouped field alone that no question changes, as a pick", () => {
    const grouped: IssueField = { ...pick("status"), group: "Plan" };
    assert.deepEqual(sectionsOf([grouped]), [{ field: grouped }]);
  });
});
