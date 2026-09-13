// Facts about JavaScript and TypeScript source, read by the TypeScript parser
// instead of by patterns: a comment, a string or a nested bracket cannot hide an
// import, a call or its arguments from it. Read by scripts/production-scope.mjs,
// scripts/production-scope-commands.mjs and scripts/dev-signing-key.mjs.

import { createRequire } from "node:module";

// The parser loads on first use, so a module that imports this one for an
// unrelated check (the build scanner, through dev-signing-key.mjs) runs without
// the typescript package installed.
const requireModule = createRequire(import.meta.url);
let ts;
const typescript = () => (ts ??= requireModule("typescript"));

const scriptKind = (path) =>
  /\.tsx$/i.test(path)
    ? ts.ScriptKind.TSX
    : /\.jsx$/i.test(path)
      ? ts.ScriptKind.JSX
      : /\.[cm]?js$/i.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;

/** Parses one file. It never throws: a syntax error still yields a tree. */
export function parseSource(path, content) {
  typescript();
  return ts.createSourceFile(
    path,
    content,
    ts.ScriptTarget.Latest,
    false,
    scriptKind(path),
  );
}

const lineOf = (source, node) =>
  source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;

const isStringLike = (node) =>
  Boolean(node) &&
  (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

/** Strips wrappers that change a value's type, never the value. */
const unwrap = (node) => {
  let current = node;
  while (
    current &&
    (ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isTypeAssertionExpression(current))
  ) {
    current = current.expression;
  }
  return current;
};

/** The member a node names: `a.name` or `a["name"]`. */
const memberNameOf = (node) => {
  if (!node) return null;
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (
    ts.isElementAccessExpression(node) &&
    isStringLike(node.argumentExpression)
  ) {
    return node.argumentExpression.text;
  }
  return null;
};

const walk = (source, visit) => {
  const next = (node) => {
    visit(node);
    ts.forEachChild(node, next);
  };
  next(source);
};

const JSX_IMPORT_SOURCE = /@jsxImportSource\s+([^\s*]+)/g;

/**
 * Every module a file loads: static imports, re-exports, `import x =
 * require()`, type imports, dynamic `import()` and `require()`, and the JSX
 * runtime an `@jsxImportSource` pragma names. `computed` holds the lines of
 * loads whose module name is not a literal, and of every `createRequire` call,
 * which makes a loader no review can follow.
 */
export function moduleLoads(source) {
  typescript();
  const imports = [];
  const computed = [];
  const load = (node, specifier) => {
    const target = unwrap(specifier);
    if (isStringLike(target)) {
      imports.push({ specifier: target.text, line: lineOf(source, node) });
    } else {
      computed.push(lineOf(source, node));
    }
  };
  walk(source, (node) => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier
    ) {
      load(node, node.moduleSpecifier);
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      ts.isExternalModuleReference(node.moduleReference)
    ) {
      load(node, node.moduleReference.expression);
    } else if (
      ts.isImportTypeNode(node) &&
      ts.isLiteralTypeNode(node.argument)
    ) {
      load(node, node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const callee = unwrap(node.expression);
      if (ts.isIdentifier(callee) && callee.text === "createRequire") {
        computed.push(lineOf(source, node));
      } else if (
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === "require")
      ) {
        load(node, node.arguments[0]);
      }
    }
  });
  for (const m of source.text.matchAll(JSX_IMPORT_SOURCE)) {
    imports.push({
      specifier: `${m[1]}/jsx-runtime`,
      line: source.getLineAndCharacterOfPosition(m.index).line + 1,
    });
  }
  return { imports, computed };
}

const classify = (source, node) => {
  const value = unwrap(node);
  if (!value) return { kind: "none" };
  if (isStringLike(value)) return { kind: "literal", text: value.text };
  const text = value.getText(source);
  if (ts.isTemplateExpression(value)) return { kind: "template", text };
  if (ts.isCallExpression(value)) {
    const callee = unwrap(value.expression);
    return {
      kind: "call",
      text,
      callee: callee.getText(source),
      calleeMember: memberNameOf(callee),
    };
  }
  if (ts.isObjectLiteralExpression(value)) {
    const properties = new Map();
    for (const property of value.properties) {
      if (ts.isPropertyAssignment(property) && property.name) {
        const name = property.name.getText(source).replace(/^["']|["']$/g, "");
        properties.set(name, unwrap(property.initializer).getText(source));
      } else if (ts.isShorthandPropertyAssignment(property)) {
        properties.set(property.name.text, property.name.text);
      } else {
        properties.set("...", property.getText(source));
      }
    }
    return { kind: "object", text, properties };
  }
  return { kind: "other", text };
};

/**
 * Calls of a method named in `names`, however the call is spelled: `a.m(x)`,
 * `a["m"](x)`, `a?.m(x)`, `(a.m)(x)`, `a.m!(x)`, `a.m.call(t, x)` and
 * `a.m.apply(t, [x])`. The first argument is classified: none, literal (a
 * string with nothing interpolated), template (by source text), call (with its
 * callee), object (with its properties), or other. A member named in
 * `references` that is used without being called (`a.m.bind(a)`,
 * `const { m } = a`) is reported with the argument kind "reference".
 */
export function methodCalls(source, names, { references = new Set() } = {}) {
  typescript();
  const calls = [];
  const called = new Set();
  const members = [];
  const record = (method, node, argument) =>
    calls.push({ method, line: lineOf(source, node), argument });
  walk(source, (node) => {
    const member = memberNameOf(node);
    if (member && references.has(member)) members.push(node);
    if (ts.isBindingElement(node)) {
      const key = node.propertyName ?? node.name;
      const name =
        ts.isIdentifier(key) || ts.isStringLiteral(key) ? key.text : null;
      if (name && references.has(name)) {
        record(name, node, { kind: "reference" });
      }
    }
    if (!ts.isCallExpression(node)) return;
    const callee = unwrap(node.expression);
    const via = memberNameOf(callee);
    if (via === "call" || via === "apply") {
      const target = unwrap(callee.expression);
      const method = memberNameOf(target);
      if (method && names.has(method)) {
        called.add(target);
        const spread = unwrap(node.arguments[1]);
        const argument =
          via === "call"
            ? classify(source, node.arguments[1])
            : spread && ts.isArrayLiteralExpression(spread)
              ? classify(source, spread.elements[0])
              : { kind: "other", text: spread?.getText(source) ?? "" };
        record(method, target, argument);
        return;
      }
    }
    if (via && names.has(via)) {
      called.add(callee);
      record(via, callee, classify(source, node.arguments[0]));
    }
  });
  for (const node of members) {
    if (!called.has(node)) {
      record(memberNameOf(node), node, { kind: "reference" });
    }
  }
  return calls;
}

/**
 * Argument vectors a file spells with literals: each call's arguments, each
 * array outside a call, and each string or template outside both (a command
 * held in a variable, or a tagged template such as zx's $`...`), flattened in
 * order. A string splits on whitespace, a computed value reads "$EXPR", and an
 * options object contributes only its `args` or `argv`. So
 * `run("npx", ["tool", "verb", ...more])` reads as `npx tool verb $EXPR`.
 */
export function literalVectors(source) {
  typescript();
  const vectors = [];
  const consumed = new Set();
  const flatten = (node, out) => {
    const value = unwrap(node);
    if (!value || ts.isOmittedExpression(value)) return;
    if (isStringLike(value)) {
      consumed.add(value);
      const words = value.text.trim().split(/\s+/).filter(Boolean);
      out.push(...(words.length > 0 ? words : ['""']));
    } else if (ts.isTemplateExpression(value)) {
      consumed.add(value);
      const text = value.templateSpans.reduce(
        (acc, span) => `${acc} $EXPR ${span.literal.text}`,
        value.head.text,
      );
      out.push(...text.trim().split(/\s+/).filter(Boolean));
    } else if (ts.isArrayLiteralExpression(value)) {
      consumed.add(value);
      value.elements.forEach((element) => flatten(element, out));
    } else if (ts.isSpreadElement(value)) {
      flatten(value.expression, out);
    } else if (ts.isObjectLiteralExpression(value)) {
      for (const property of value.properties) {
        if (
          ts.isPropertyAssignment(property) &&
          /^["']?(?:args|argv)["']?$/.test(property.name.getText(source))
        ) {
          flatten(property.initializer, out);
        }
      }
    } else {
      out.push("$EXPR");
    }
  };
  const vector = (node, parts) => {
    const tokens = [];
    parts.forEach((part) => flatten(part, tokens));
    vectors.push({ line: lineOf(source, node), tokens });
  };
  walk(source, (node) => {
    if (
      (ts.isCallExpression(node) || ts.isNewExpression(node)) &&
      node.arguments?.length
    ) {
      vector(node, node.arguments);
    } else if (
      (ts.isArrayLiteralExpression(node) ||
        isStringLike(node) ||
        ts.isTemplateExpression(node)) &&
      !consumed.has(node)
    ) {
      vector(node, [node]);
    }
  });
  return vectors;
}
