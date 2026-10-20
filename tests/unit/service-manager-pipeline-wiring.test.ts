// The inbound pipeline is one large private function, so its service-manager wiring is pinned by source (the locked dev
// e2e scenario `service-dispatch` drives it for real): the verified manager phone is recognised BEFORE the generic
// identity fork, never talks to the line owner's Team chat, answers dispatch approvals across every service workspace,
// asks "Is this about A or B?" instead of guessing, and the manager notice spine texts the service manager.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pipeline = readFileSync("src/lib/sms/inbound-pipeline.server.ts", "utf8");
const notify = readFileSync("src/lib/agent-notify.server.ts", "utf8");

describe("service manager wiring", () => {
  it("recognises the service manager before the generic manager consent and fork", () => {
    const recognise = pipeline.indexOf("recognizeServiceManagerInbound(db, { managerId, fromPhone, toPhone })");
    const generic = pipeline.indexOf("resolveManagerSmsInboundIdentity(db, {");
    const consent = pipeline.indexOf("ensureManagerInboundReplyConsent(db, managerInbound, messageSid)");
    expect(generic).toBeGreaterThan(-1);
    expect(recognise).toBeGreaterThan(generic);
    expect(recognise).toBeLessThan(consent);
    expect(pipeline).toMatch(/if \(serviceManager\) managerInbound = serviceManager;/);
  });

  it("answers dispatch replies across all service workspaces, skips the Team chat and picks the workspace", () => {
    expect(pipeline).toMatch(/\.\.\.\(serviceScopes \? \{ scopes: serviceScopes \} : \{\}\)/);
    expect(pipeline).toMatch(/teamRoute = serviceManager \? \{ kind: "agent", text: body \}/);
    expect(pipeline).toMatch(/pickServiceWorkspace\(db, \{ fromPhone, body: agentBody, workspaces \}\)/);
    expect(pipeline).toMatch(/buildServiceManagerAgentContext\(db, \{ serviceOwnerId: managerInbound\.actorUserId, workspace: picked\.workspace \}\)/);
  });

  it("the manager notice spine texts the service manager for the notice's workspace", () => {
    expect(notify).toMatch(/alertServiceManagerFromNotice\(db, \{\s*workspaceId: sendWorkspaceId,/);
    expect(notify).toMatch(/await serviceAlert;/);
  });

  it("a new inquiry on the PropLane line alerts the service manager, inside after() so it is never dropped", () => {
    expect(pipeline).toMatch(/alertServiceManagerOfInquiry\(db, \{ phone: fromPhone, body \}\)/);
    const alert = pipeline.indexOf("alertServiceManagerOfInquiry");
    const guard = pipeline.lastIndexOf("after(async () => {", alert);
    expect(guard).toBeGreaterThan(-1);
    // The fire-and-forget import used to run with nothing keeping the invocation alive.
    expect(pipeline.slice(guard, alert)).not.toContain("void import(");
  });

  it("a write from a manager phone on the PropLane line needs the code from its own preview", () => {
    expect(pipeline).toMatch(/const onPropLaneLine = managerInbound/);
    expect(pipeline).toMatch(/Boolean\(serviceManager\) \|\| \(await isPropLaneServiceLine\(db, \{ ownerUserId: managerId, workNumber: toPhone \}\)/);
    expect(pipeline).toMatch(/requireConfirmationCode: onPropLaneLine,/);
  });

  it("the dispatch money answers carry the same code gate as the Assistant's writes", () => {
    const engine = readFileSync("src/lib/vendor-dispatch/engine.server.ts", "utf8");
    const responses = readFileSync("src/lib/vendor-dispatch/responses.server.ts", "utf8");
    const completion = readFileSync("src/lib/vendor-dispatch/completion.server.ts", "utf8");
    const inbound = readFileSync("src/lib/vendor-dispatch/inbound.server.ts", "utf8");
    // Every ask that spends money shows the code...
    expect(engine).toMatch(/withDispatchApprovalCode\(\s*db,\s*run,\s*"dispatch_approval"/);
    expect(responses).toMatch(/withDispatchApprovalCode\(\s*db,\s*run,\s*"dispatch_quote"/);
    expect(completion).toMatch(/withDispatchApprovalCode\(\s*db,\s*run,\s*"dispatch_invoice"/);
    // ...including R / B, which re-text vendors...
    expect(engine).toMatch(/withDispatchApprovalCode\(\s*db,\s*run,\s*"dispatch_retry"/);
    expect(inbound).toMatch(/exhausted: "dispatch_retry"/);
    // ...and so does every RE-ask of a proposal still open, or the manager is told to reply Y to something their
    // Y cannot answer.
    const sweep = readFileSync("src/lib/vendor-dispatch/sweep.server.ts", "utf8");
    expect(sweep).toMatch(/withDispatchApprovalCode\(\s*db,\s*run,\s*"dispatch_approval"/);
    expect(sweep).toMatch(/withDispatchApprovalCode\(\s*db,\s*run,\s*"dispatch_quote"/);
    // ...and the reply is checked against it before approve / decline / invoice runs.
    expect(inbound).toMatch(/checkDispatchApprovalCode\(db, run, codedKind, presentedCode\)/);
    const gate = inbound.indexOf("checkDispatchApprovalCode");
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(inbound.indexOf("const result = await approveDispatchRun"));
  });

  it("a live dispatch answer is read before the line's member/status handler", () => {
    const dispatchGuard = pipeline.indexOf("hasLiveVendorDispatchAnswer(db, {");
    const lineAnswer = pipeline.indexOf("answerPropLaneLineText(db, {");
    expect(dispatchGuard).toBeGreaterThan(-1);
    expect(dispatchGuard).toBeLessThan(lineAnswer);
    expect(pipeline).toMatch(/&& !dispatchAnswerPending\) \{/);
  });
});
