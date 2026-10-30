import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

/** Identify each call independently, including renamed and namespace imports. */
function unsafeCalls(source: string, name = "fixture.ts"): number[] {
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
  const unsafe: number[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const matches = (ts.isIdentifier(callee) && aliases.has(callee.text)) ||
        (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && namespaces.has(callee.expression.text) && callee.name.text === "normalizePortalRoles");
      if (matches && node.arguments[1]?.kind !== ts.SyntaxKind.NullKeyword) unsafe.push(file.getLineAndCharacterOfPosition(node.getStart()).line + 1);
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
  expect(unsafeCalls(source)).toEqual([3, 7]);
  expect(unsafeCalls("import { normalizePortalRoles as roles } from './portal-roles'; roles(rows);")).toEqual([1]);
});

it("keeps legacy role fallback confined to reviewed display and navigation", () => {
  const root = join(process.cwd(), "src");
  const exceptions = new Set([
    // Client contact autofill and post-auth navigation do not grant API capabilities.
    "hooks/use-prospect-contact-autofill.ts",
    "lib/auth/resolve-post-auth-destination.ts",
  ]);
  function scan(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) scan(path);
      else if (/\.[tj]sx?$/.test(entry.name)) {
        const name = relative(root, path);
        if (!exceptions.has(name)) expect(unsafeCalls(readFileSync(path, "utf8"), name), name).toEqual([]);
      }
    }
  }
  scan(root);
});
