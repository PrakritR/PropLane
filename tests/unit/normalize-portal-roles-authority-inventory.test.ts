import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

/** Identify each call independently, including renamed and namespace imports. */
function unsafeCalls(source: string, name = "fixture.ts"): Array<{ line: number; call: string; owner: string | null }> {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, name.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const aliases = new Set<string>();
  const namespaces = new Set<string>();
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !statement.moduleSpecifier.text.endsWith("portal-roles")) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
    if (bindings && ts.isNamedImports(bindings)) {
      for (const item of bindings.elements) {
        if ((item.propertyName ?? item.name).text === "normalizePortalRoles") aliases.add(item.name.text);
      }
    }
  }
  const unsafe: Array<{ line: number; call: string; owner: string | null }> = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const matches = (ts.isIdentifier(callee) && aliases.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text) && callee.name.text === "normalizePortalRoles");
      if (matches && node.arguments[1]?.kind !== ts.SyntaxKind.NullKeyword) {
        let parent: ts.Node | undefined = node.parent;
        while (parent && !ts.isFunctionDeclaration(parent)) parent = parent.parent;
        unsafe.push({
          line: file.getLineAndCharacterOfPosition(node.getStart()).line + 1,
          call: node.getText(file),
          owner: parent && ts.isFunctionDeclaration(parent) ? parent.name?.text ?? null : null,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return unsafe;
}

it("detects aliases and mixed calls while accepting multiline null", () => {
  const source = `import { normalizePortalRoles as roles } from '@/lib/auth/portal-roles';
import * as portal from '@/lib/auth/portal-roles';
roles(rows, null); roles(rows, profile.role);
roles(\n rows,\n null\n); portal.normalizePortalRoles(rows, user.role);`;
  expect(unsafeCalls(source).map((item) => item.line)).toEqual([3, 7]);
  expect(unsafeCalls("import { normalizePortalRoles as roles } from './portal-roles'; roles(rows);").map((item) => item.line)).toEqual([1]);
});

it("keeps legacy role fallback confined to reviewed display and navigation", () => {
  const root = join(process.cwd(), "src");
  const exceptions: Record<string, Array<{ owner: string; call: string }>> = {
    // These exact calls support contact autofill and client post-auth navigation only.
    "hooks/use-prospect-contact-autofill.ts": [
      { owner: "sync", call: "normalizePortalRoles(roleRows, profile?.role ?? user.user_metadata?.role)" },
      { owner: "sync", call: "normalizePortalRoles(null, meta?.role)" },
    ],
    "lib/auth/resolve-post-auth-destination.ts": [
      { owner: "resolveClientPostAuthDestination", call: "normalizePortalRoles(roleRows, profile?.role)" },
    ],
  };
  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.[tj]sx?$/.test(entry.name)) {
        const name = relative(root, path);
        const source = readFileSync(path, "utf8");
        const expected = exceptions[name] ?? [];
        expect(unsafeCalls(source, name).map(({ owner, call }) => ({ owner, call })), name).toEqual(expected);
        if (name === "hooks/use-prospect-contact-autofill.ts") expect(source).toMatch(/^"use client";/);
        if (name === "lib/auth/resolve-post-auth-destination.ts") expect(source).toContain("resolveClientPostAuthDestination");
      }
    }
  }
  scan(root);
});
