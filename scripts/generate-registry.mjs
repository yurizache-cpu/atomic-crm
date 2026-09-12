#!/usr/bin/env node

import { globSync } from "glob";
import fs from "node:fs";
import path from "node:path";

const registryPath = "registry.json";
const basePath = "src";
// glob treats "\" as an escape character, so patterns must always use "/" —
// path.join would emit backslashes on Windows and silently match nothing,
// which regenerates an empty registry instead of failing.
const atomicCrmComponentsPath = path.posix.join(
  basePath,
  "components",
  "atomic-crm",
);
const supabaseComponentsPath = path.posix.join(
  basePath,
  "components",
  "supabase",
);
const hooksPath = path.posix.join(basePath, "hooks");
const libPath = path.posix.join(basePath, "lib");

const excludedHooks = [
  "filter-context.tsx",
  "saved-queries.tsx",
  "use-mobile.ts",
  "useSupportCreateSuggestion.tsx",
];

const excludedLibFiles = [
  "field.type.ts",
  "genericMemo.ts",
  "i18nProvider.ts",
  "sanitizeInputRestProps.ts",
  "utils.ts",
];

/**
 * globSync RETURNS platform separators, so on Windows every emitted `path`
 * became "src\components\atomic-crm\types.ts". registry.json is PUBLISHED
 * content consumed by `shadcn add`, where a backslash path resolves nowhere —
 * so a commit from a Windows machine would silently ship a broken registry.
 * (The posix.join calls above fix the INPUT patterns; this fixes the output.)
 */
const toPosixPath = (p) => p.split(path.sep).join(path.posix.sep);

const testFilePattern = "**/*.{test,spec}.*";
const storyFilePattern = "**/*.stories.*";

const atomicCrmComponents = globSync(
  path.posix.join(atomicCrmComponentsPath, "**", "*.ts*"),
  { ignore: [testFilePattern, storyFilePattern] },
).map(toPosixPath);
const supabaseComponents = globSync(
  path.posix.join(supabaseComponentsPath, "**", "*.ts*"),
  { ignore: [testFilePattern, storyFilePattern] },
).map(toPosixPath);
const hooks = globSync(path.posix.join(hooksPath, "**", "*.ts*"))
  .map(toPosixPath)
  .filter((hook) => {
    return !excludedHooks.includes(path.basename(hook));
  });
const libFiles = globSync(path.posix.join(libPath, "**", "*.ts*"))
  .map(toPosixPath)
  .filter((file) => {
    return !excludedLibFiles.includes(path.basename(file));
  });
const changelogPath = "CHANGELOG.md";

const registryContent = JSON.parse(fs.readFileSync(registryPath, "utf-8"));

const files = [
  ...atomicCrmComponents.map((path) => {
    return {
      path,
      type: "registry:component",
    };
  }),
  ...supabaseComponents.map((path) => {
    return {
      path,
      type: "registry:component",
    };
  }),
  ...hooks.map((path) => {
    return {
      path,
      type: "registry:hook",
    };
  }),
  ...libFiles.map((path) => {
    return {
      path,
      type: "registry:lib",
    };
  }),
  {
    path: changelogPath,
    type: "registry:file",
    target: "~/CHANGELOG.md",
  },
];

const newRegistryContent = {
  ...registryContent,
  items: registryContent.items.map((item) => {
    if (item.name === "atomic-crm") {
      return {
        ...item,
        files,
      };
    }

    return item;
  }),
};

fs.writeFileSync(
  registryPath,
  JSON.stringify(newRegistryContent, null, 2),
  "utf-8",
);
