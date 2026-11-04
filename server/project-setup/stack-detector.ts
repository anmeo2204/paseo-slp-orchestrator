// Package-based stack detection: walk the repository, treat every directory that holds a recognized
// marker file as one package, and classify its stack. Folder layout is irrelevant, so this works for
// any monorepo convention (cms/backend, backend/cms, apps/*, ...). Heavy and vendored directories are
// skipped so a scan stays cheap and never descends into dependencies or build output.
import { readFile, readdir } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { DetectedPackage, DetectedStack, StackDetectionResult } from "../../shared/project-setup";

// Directories that never contain first-party source and would make the walk slow or noisy.
const SKIP_DIRECTORIES = new Set([
  ".git", "node_modules", "vendor", "dist", "build", "out", ".next", ".nuxt", ".svelte-kit",
  "target", "bin", "obj", ".gradle", "Pods", "DerivedData", ".dart_tool", "coverage",
  ".cache", ".turbo", ".venv", "venv", "__pycache__", ".idea", ".vscode", ".slp",
]);

// Cap traversal depth so a pathological tree cannot stall project selection in the UI.
const MAX_DEPTH = 8;

function toPosix(relativePath: string): string {
  return relativePath.split(sep).join("/");
}

// Classify a package.json by its dependencies: the same marker file backs several web stacks.
async function classifyPackageJson(packageJsonPath: string): Promise<{ stack: DetectedStack; detail: string }> {
  let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
  try {
    parsed = JSON.parse(await readFile(packageJsonPath, "utf8"));
  } catch {
    // An unreadable or malformed package.json is still a Node package; the validator surfaces the parse issue.
    return { stack: "node", detail: "package.json (unparsed)" };
  }
  const allDependencies = { ...parsed.dependencies, ...parsed.devDependencies };
  const has = (name: string) => Object.hasOwn(allDependencies, name);
  if (has("next")) return { stack: "nextjs", detail: "Next.js" };
  if (has("@angular/core")) return { stack: "angular", detail: "Angular" };
  if (has("react-native") || has("expo")) return { stack: "react", detail: "React Native/Expo" };
  if (has("react") || has("vue") || has("svelte")) return { stack: "react", detail: has("react") ? "React" : has("vue") ? "Vue" : "Svelte" };
  return { stack: "node", detail: "Node/TypeScript" };
}

// Detect a Gradle package and whether it applies the Android application/library plugin.
async function classifyGradle(gradleFilePath: string): Promise<{ stack: DetectedStack; detail: string }> {
  let contents = "";
  try { contents = await readFile(gradleFilePath, "utf8"); } catch { /* unreadable gradle still counts as JVM */ }
  if (/com\.android\.(application|library)/.test(contents)) return { stack: "android-native", detail: "Android (Gradle)" };
  return { stack: "generic", detail: "JVM/Gradle" };
}

// Markers checked by exact filename. The first match that classifies wins for that directory.
// package.json and gradle need their contents, so they are handled specially above.
const SIMPLE_MARKERS: Array<{ file: string; stack: DetectedStack; detail: string }> = [
  { file: "composer.json", stack: "php", detail: "PHP (Composer)" },
  { file: "go.mod", stack: "go", detail: "Go module" },
  { file: "pubspec.yaml", stack: "flutter", detail: "Flutter/Dart" },
  { file: "Package.swift", stack: "ios-native", detail: "Swift package" },
  { file: "requirements.txt", stack: "python", detail: "Python (pip)" },
  { file: "pyproject.toml", stack: "python", detail: "Python (pyproject)" },
];

// A directory can carry several markers (for example package.json beside composer.json). Classify each
// present marker so a mixed directory surfaces every stack it actually contains.
async function classifyDirectory(absoluteDir: string, entryNames: Set<string>): Promise<Array<{ stack: DetectedStack; markerFile: string; detail: string }>> {
  const found: Array<{ stack: DetectedStack; markerFile: string; detail: string }> = [];
  if (entryNames.has("package.json")) {
    const classification = await classifyPackageJson(join(absoluteDir, "package.json"));
    found.push({ ...classification, markerFile: "package.json" });
  }
  for (const marker of SIMPLE_MARKERS) {
    if (entryNames.has(marker.file)) found.push({ stack: marker.stack, markerFile: marker.file, detail: marker.detail });
  }
  // Xcode projects appear as a directory entry (*.xcodeproj), not a file.
  const xcodeProject = [...entryNames].find((name) => name.endsWith(".xcodeproj") || name.endsWith(".xcworkspace"));
  if (xcodeProject) found.push({ stack: "ios-native", markerFile: xcodeProject, detail: "Xcode project" });
  // Gradle build scripts: prefer the Kotlin-DSL file name when both exist.
  const gradleFile = entryNames.has("build.gradle.kts") ? "build.gradle.kts" : entryNames.has("build.gradle") ? "build.gradle" : null;
  if (gradleFile) {
    const classification = await classifyGradle(join(absoluteDir, gradleFile));
    found.push({ stack: classification.stack, markerFile: gradleFile, detail: classification.detail });
  }
  if (entryNames.has("ProjectSettings") && entryNames.has("Assets")) {
    // Unity is detected but has no web/mobile preset yet; it maps to generic so the catalog still forms.
    found.push({ stack: "generic", markerFile: "ProjectSettings/", detail: "Unity project" });
  }
  // A .csproj/.sln outside a Unity tree is .NET.
  const dotnetFile = [...entryNames].find((name) => name.endsWith(".csproj") || name.endsWith(".sln"));
  if (dotnetFile && !(entryNames.has("ProjectSettings") && entryNames.has("Assets"))) {
    found.push({ stack: "dotnet", markerFile: dotnetFile, detail: ".NET project" });
  }
  return found;
}

async function walk(repoRoot: string, absoluteDir: string, depth: number, collected: DetectedPackage[]): Promise<void> {
  let entries;
  try { entries = await readdir(absoluteDir, { withFileTypes: true }); }
  catch { return; }
  const entryNames = new Set(entries.map((entry) => entry.name));
  for (const classification of await classifyDirectory(absoluteDir, entryNames)) {
    collected.push({
      relativePath: toPosix(relative(repoRoot, absoluteDir)),
      stack: classification.stack,
      markerFile: classification.markerFile,
      detail: classification.detail,
    });
  }
  if (depth >= MAX_DEPTH) return;
  for (const entry of entries) {
    if (!entry.isDirectory() || SKIP_DIRECTORIES.has(entry.name) || entry.name.startsWith(".")) continue;
    await walk(repoRoot, join(absoluteDir, entry.name), depth + 1, collected);
  }
}

// Scan a repository and return every detected package. When nothing matches, report a single generic
// package at the root so presets and the validator always have something to reason about.
export async function detectStacks(repoPath: string): Promise<StackDetectionResult> {
  const packages: DetectedPackage[] = [];
  await walk(repoPath, repoPath, 0, packages);
  // Stable order: shallower paths first, then alphabetical, so UI and generated files are deterministic.
  packages.sort((a, b) => a.relativePath.split("/").length - b.relativePath.split("/").length || a.relativePath.localeCompare(b.relativePath) || a.stack.localeCompare(b.stack));
  if (packages.length === 0) {
    packages.push({ relativePath: "", stack: "generic", markerFile: "", detail: "No known stack markers found" });
  }
  const stacks = [...new Set(packages.map((pkg) => pkg.stack))];
  return {
    packages,
    stacks,
    requiresMacHost: stacks.includes("ios-native"),
  };
}
