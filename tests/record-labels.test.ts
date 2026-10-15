import { expect, it } from "vitest";
import { categoryGroup, categoryLabel, RECORD_TYPES, RECORD_GROUPS, relationLabel } from "../src/lib/record-labels";
import { RELATION_TYPES } from "../src/lib/types";

it("groups supported records while retaining custom labels", () => {
  expect(RECORD_GROUPS).toHaveLength(7);
  for (const type of RECORD_TYPES.filter(type => type !== "Generic")) expect(categoryGroup(type)).not.toBe("其他");
  expect(categoryGroup("My equipment")).toBe("其他");
  expect(categoryLabel("My equipment")).toBe("My equipment");
  for (const type of RELATION_TYPES) expect(relationLabel(type)).not.toBe(type);
});
