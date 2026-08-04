import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const workspaceRoot = resolve(import.meta.dirname, "../..");
const application = join(
  workspaceRoot,
  "src-tauri/target/release/blog-editor-e2e",
);
const inheritedTestProject = process.env.BLOG_EDITOR_E2E_PROJECT;
if (
  inheritedTestProject &&
  process.env.BLOG_EDITOR_E2E_PROJECT_CREATED !== "1"
) {
  throw new Error(
    "BLOG_EDITOR_E2E_PROJECT 只能由测试 launcher 创建，拒绝写入外部项目",
  );
}
const ownsTestProject = inheritedTestProject === undefined;
const testProject =
  inheritedTestProject ?? mkdtempSync(join(tmpdir(), "blog-editor-e2e-"));

function copyFixture(relativePath) {
  const destination = join(testProject, relativePath);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(workspaceRoot, "fixtures/test-blog", relativePath), destination);
}

// 只复制 smoke 用例需要的受控文件，不把 node_modules、缓存或用户的 Photo_test
// 手测内容带入。测试产生的保存写入也只会发生在这个临时项目中。
if (ownsTestProject) {
  copyFixture(".blog-editor.json");
  copyFixture("src/content/blog/hello-astro.md");
  process.env.BLOG_EDITOR_E2E_PROJECT = testProject;
  process.env.BLOG_EDITOR_E2E_PROJECT_CREATED = "1";
}

export const config = {
  runner: "local",
  specs: ["./specs/**/*.e2e.mjs"],
  maxInstances: 1,
  maxInstancesPerCapability: 1,
  services: [
    [
      "@wdio/tauri-service",
      {
        appBinaryPath: application,
        driverProvider: "embedded",
        env: {
          BLOG_EDITOR_E2E_PROJECT: testProject,
          BLOG_EDITOR_E2E_PROJECT_CREATED: "1",
        },
        startTimeout: 30_000,
        captureBackendLogs: false,
        captureFrontendLogs: false,
      },
    ],
  ],
  capabilities: [
    {
      browserName: "tauri",
      "tauri:options": { application },
    },
  ],
  // 1.3.0 的通用诊断仍假定 Linux 需要 DISPLAY/外部 tauri-driver，会对纯
  // Wayland + embedded provider 输出错误建议；spec reporter 和失败快照保留即可。
  logLevel: "silent",
  bail: 0,
  waitforTimeout: 10_000,
  connectionRetryTimeout: 30_000,
  connectionRetryCount: 1,
  framework: "mocha",
  reporters: ["spec"],
  mochaOpts: {
    ui: "bdd",
    timeout: 30_000,
  },
  onComplete() {
    if (ownsTestProject) {
      rmSync(testProject, { recursive: true, force: true });
    }
  },
};
