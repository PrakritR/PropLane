import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "src/components/portal/resident-wizard/index.tsx",
  "utf8",
);

describe("resident wizard finish wiring", () => {
  it("rebuilds final-step completion when the selected assignee changes", () => {
    const finishSection = source.slice(
      source.indexOf("const finish = useCallback"),
      source.indexOf("const railHeader"),
    );

    expect(finishSection).toMatch(/const finish = useCallback\(async[\s\S]*?\}, \[assignee, busy, executedLeaseKeys, form,/);
    expect(finishSection).toMatch(/const onFinish = useCallback\([\s\S]*?\}, \[todo, buildRow, form\.message, draftMessage, finish,/);
    expect(finishSection).not.toContain("react-hooks/exhaustive-deps");
    expect(finishSection).not.toContain("formRef.current");
  });
});
