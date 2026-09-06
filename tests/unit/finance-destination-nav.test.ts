import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("finance list chrome", () => {
  it("uses Properties/Tours-style command tabs instead of a left rail", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-finances-panel.tsx"),
      "utf8",
    );
    expect(source).toContain('variant="command"');
    expect(source).toContain("destinations={financeTabItems.map");
    expect(source).toContain("financesCommandActions");
    expect(source).not.toContain("FinanceDestinationNav");
    expect(source).not.toContain("lg:flex-row lg:items-start");
  });

  it("reloads after an assistant expense or income confirm", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-finances-panel.tsx"),
      "utf8",
    );
    expect(source).toContain("FINANCES_ASSISTANT_UPDATED_EVENT");
    // The shared transport refreshes the store once; the page only reloads its report.
    const transport = readFileSync(join(process.cwd(), "src/lib/axis-assistant/use-assistant-conversation.ts"), "utf8");
    expect(transport).toContain("syncManagerOutgoingExpensesFromServer(true)");
    expect(source).not.toContain("syncManagerOutgoingExpensesFromServer(true)");
    expect(source).toContain("void loadTable()");
  });

  it("orders transaction tabs before reports", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/pro-finances-panel.tsx"),
      "utf8",
    );
    const incomeIdx = source.indexOf('{ id: "income", label: "Income" }');
    const trialBalanceIdx = source.indexOf('{ id: "trial-balance", label: "Trial balance" }');
    expect(incomeIdx).toBeGreaterThan(-1);
    expect(trialBalanceIdx).toBeGreaterThan(incomeIdx);
  });
});
