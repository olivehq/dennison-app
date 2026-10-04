import { describe, expect, it } from "vitest";
import { findUnknownFields, MERGE_FIELDS, renderTemplate, renderText, SAMPLE_MERGE_VALUES, type MergeValues } from "./merge";

const values: MergeValues = {
  ...SAMPLE_MERGE_VALUES,
  first_name: "Ana",
  organization: "Smith & <Sons>",
  schedule_link: "https://aw.example.com/s/abc?x=1&y=2",
};

describe("merge fields", () => {
  it("lists the eight scope fields with labels and descriptions", () => {
    expect(MERGE_FIELDS.map((f) => f.key)).toEqual([
      "first_name",
      "last_name",
      "organization",
      "supplier_name",
      "desk",
      "schedule_link",
      "event_name",
      "event_date",
    ]);
    expect(MERGE_FIELDS.every((f) => f.label.length > 0 && f.description.length > 0)).toBe(true);
  });

  it("escapes values in HTML and tolerates spaces inside braces", () => {
    expect(renderTemplate("<p>Hi {{ first_name }}, from {{organization}}</p>", values)).toBe(
      "<p>Hi Ana, from Smith &amp; &lt;Sons&gt;</p>",
    );
  });

  it("turns a bare schedule link into a link, and fills an href without nesting", () => {
    expect(renderTemplate("<p>Open {{schedule_link}}</p>", values)).toBe(
      '<p>Open <a href="https://aw.example.com/s/abc?x=1&amp;y=2">https://aw.example.com/s/abc?x=1&amp;y=2</a></p>',
    );
    expect(renderTemplate('<p><a href="{{schedule_link}}">your schedule</a></p>', values)).toBe(
      '<p><a href="https://aw.example.com/s/abc?x=1&amp;y=2">your schedule</a></p>',
    );
    expect(renderTemplate('<a href="{{schedule_link}}">{{schedule_link}}</a>', values)).toBe(
      '<a href="https://aw.example.com/s/abc?x=1&amp;y=2">https://aw.example.com/s/abc?x=1&amp;y=2</a>',
    );
  });

  it("leaves unknown fields as typed and reports each once", () => {
    const html = "<p>{{first_name}} {{firstname}} {{ desk_no }} {{firstname}}</p>";
    expect(renderTemplate(html, values)).toBe("<p>Ana {{firstname}} {{ desk_no }} {{firstname}}</p>");
    expect(findUnknownFields(html)).toEqual(["{{firstname}}", "{{ desk_no }}"]);
    expect(findUnknownFields("<p>{{event_name}}</p>")).toEqual([]);
  });

  it("renders subjects as plain text without escaping", () => {
    expect(renderText("{{organization}}: your {{event_name}} schedule", values)).toBe(
      "Smith & <Sons>: your AW Appointment Show schedule",
    );
  });
});
