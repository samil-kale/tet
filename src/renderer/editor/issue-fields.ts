import type { IssueField } from "../../shared/types/providers";

/** A field changed by a question of its own, rather than picked from a list. */
export type AskedField = Extract<IssueField, { kind: "number" | "date" | "duration" | "timelog" }>;

export function isAsked(field: IssueField): field is AskedField {
  return field.kind === "number" || field.kind === "date" || field.kind === "duration" || field.kind === "timelog";
}

/** The side column's sections: a field alone, or the fields of one group together at the place of
 *  the group's first. */
export type Section = { field: IssueField } | { group: string; fields: AskedField[] };

export function sectionsOf(fields: IssueField[]): Section[] {
  const sections: Section[] = [];
  for (const field of fields) {
    const { group } = field;
    if (group === undefined || !isAsked(field)) {
      sections.push({ field });
      continue;
    }
    const existing = sections.find(
      (section): section is Extract<Section, { group: string }> => "group" in section && section.group === group,
    );
    if (existing) {
      existing.fields.push(field);
    } else {
      sections.push({ group, fields: [field] });
    }
  }
  return sections;
}
