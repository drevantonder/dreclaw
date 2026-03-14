import { describe, expect, it } from "vite-plus/test";
import { getBuiltinSkillByName, listBuiltinSkills, parseSkillDocument } from "../../src/app/skills";

describe("skills", () => {
  it("lists builtin skills", () => {
    const skills = listBuiltinSkills();
    expect(skills.map((skill) => skill.name)).toEqual([
      "quickjs",
      "google",
      "vfs",
      "memory",
      "skill-authoring",
    ]);
    expect(getBuiltinSkillByName("google")?.path).toBe("/skills/system/google/SKILL.md");
  });

  it("parses valid skill documents", () => {
    const parsed = parseSkillDocument(`---
name: inbox-summary
description: Summarize inbox messages when asked for email summaries.
---

# Inbox Summary

1. Load the google skill.
2. Fetch messages.
`);
    expect(parsed.name).toBe("inbox-summary");
    expect(parsed.description).toContain("email summaries");
    expect(parsed.body).toContain("Load the google skill");
  });
});
