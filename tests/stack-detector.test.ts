// Verifies the package-based stack detector: it classifies marker files regardless of folder layout,
// skips vendored/build directories, distinguishes web stacks by package.json dependencies, and flags iOS.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { detectStacks } from "../server/project-setup/stack-detector";
import { useTemporaryDirectories } from "./helpers/temp-directory";

const createDirectory = useTemporaryDirectories();

async function writeFileTree(root: string, files: Record<string, string>): Promise<void> {
  for (const [relativePath, contents] of Object.entries(files)) {
    const absolutePath = join(root, relativePath);
    await mkdir(join(absolutePath, ".."), { recursive: true });
    await writeFile(absolutePath, contents, "utf8");
  }
}

describe("detectStacks", () => {
  it("detects multiple stacks across arbitrary folder layouts", async () => {
    const repo = await createDirectory("detect-monorepo");
    await writeFileTree(repo, {
      "cms/backend/composer.json": "{}",
      "crm/api/go.mod": "module crm/api\n",
      "crm/web/package.json": JSON.stringify({ dependencies: { "@angular/core": "17" } }),
      "website/package.json": JSON.stringify({ dependencies: { next: "14" } }),
      "shop/frontend/package.json": JSON.stringify({ dependencies: { react: "18" } }),
    });
    const result = await detectStacks(repo);
    const byPath = Object.fromEntries(result.packages.map((pkg) => [pkg.relativePath, pkg.stack]));
    expect(byPath["cms/backend"]).toBe("php");
    expect(byPath["crm/api"]).toBe("go");
    expect(byPath["crm/web"]).toBe("angular");
    expect(byPath["website"]).toBe("nextjs");
    expect(byPath["shop/frontend"]).toBe("react");
    expect(result.requiresMacHost).toBe(false);
  });

  it("skips node_modules, vendor and build output", async () => {
    const repo = await createDirectory("detect-skip");
    await writeFileTree(repo, {
      "package.json": JSON.stringify({ dependencies: { next: "14" } }),
      "node_modules/some-dep/package.json": JSON.stringify({ dependencies: { react: "18" } }),
      "vendor/lib/composer.json": "{}",
      "dist/go.mod": "module dist\n",
    });
    const result = await detectStacks(repo);
    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]).toMatchObject({ relativePath: "", stack: "nextjs" });
  });

  it("flags iOS packages and requiresMacHost", async () => {
    const repo = await createDirectory("detect-ios");
    await writeFileTree(repo, { "ios/App.xcodeproj/project.pbxproj": "// xcode" });
    const result = await detectStacks(repo);
    expect(result.packages[0].stack).toBe("ios-native");
    expect(result.requiresMacHost).toBe(true);
  });

  it("detects Android via the Gradle Android plugin", async () => {
    const repo = await createDirectory("detect-android");
    await writeFileTree(repo, {
      "app/build.gradle": "plugins { id 'com.android.application' }\n",
    });
    const result = await detectStacks(repo);
    expect(result.packages[0].stack).toBe("android-native");
  });

  it("falls back to a single generic package when nothing matches", async () => {
    const repo = await createDirectory("detect-empty");
    await writeFileTree(repo, { "README.md": "# empty" });
    const result = await detectStacks(repo);
    expect(result.packages).toEqual([
      expect.objectContaining({ relativePath: "", stack: "generic" }),
    ]);
  });
});
