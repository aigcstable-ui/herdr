import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const hookPath = fileURLToPath(new URL("./herdr-agent-state.js", import.meta.url));
const BIN_PATH = "/opt/herdr/bin/herdr";

let workDir: string;
let preloadPath: string;
let reportCounter = 0;

beforeAll(() => {
  workDir = mkdtempSync(join(tmpdir(), "herdr-codely-hook-"));
  preloadPath = join(workDir, "capture-herdr.cjs");
  // The hook reports by spawning the Herdr binary. Replace spawnSync before the
  // hook is loaded so each report is recorded instead of executed.
  writeFileSync(
    preloadPath,
    `const fs = require("node:fs");
const childProcess = require("node:child_process");
childProcess.spawnSync = (command, args) => {
  fs.appendFileSync(process.env.HERDR_TEST_REPORT_LOG, JSON.stringify({ command, args }) + "\\n");
  return { pid: 0, output: [], stdout: null, stderr: null, status: 0, signal: null };
};
`,
  );
});

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

type Report = { command: string; args: string[] };

function runHook(payload: unknown, env: Record<string, string | undefined> = {}) {
  reportCounter += 1;
  const logPath = join(workDir, `reports-${reportCounter}.jsonl`);
  const hookEnv: Record<string, string | undefined> = {
    ...process.env,
    HERDR_ENV: "1",
    HERDR_PANE_ID: "test:p1",
    HERDR_BIN_PATH: BIN_PATH,
    HERDR_TEST_REPORT_LOG: logPath,
    ...env,
  };
  for (const [name, value] of Object.entries(hookEnv)) {
    if (value === undefined) {
      delete hookEnv[name];
    }
  }

  const result = spawnSync(process.execPath, ["--preload", preloadPath, hookPath], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf8",
    env: hookEnv,
    timeout: 10_000,
  });

  const reports: Report[] = existsSync(logPath)
    ? readFileSync(logPath, "utf8")
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Report)
    : [];
  return { result, reports };
}

function argsWithoutSeq(args: string[]): string[] {
  const index = args.indexOf("--seq");
  return index === -1 ? args : [...args.slice(0, index), ...args.slice(index + 2)];
}

function seqOf(args: string[]): number {
  const index = args.indexOf("--seq");
  expect(index).toBeGreaterThan(-1);
  return Number(args[index + 1]);
}

function stateOf(args: string[]): string | undefined {
  const index = args.indexOf("--state");
  return index === -1 ? undefined : args[index + 1];
}

function messageOf(args: string[]): string | undefined {
  const index = args.indexOf("--message");
  return index === -1 ? undefined : args[index + 1];
}

test("SessionStart reports the session and an idle state for startup sources", () => {
  const { result, reports } = runHook({
    hook_event_name: "SessionStart",
    session_id: "codely-session",
    transcript_path: "/tmp/codely-session.jsonl",
    source: "startup",
  });

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(reports).toHaveLength(2);

  const [session, idle] = reports;
  expect(session.command).toBe(BIN_PATH);
  expect(argsWithoutSeq(session.args)).toEqual([
    "pane",
    "report-agent-session",
    "test:p1",
    "--source",
    "herdr:codely",
    "--agent",
    "codely",
    "--agent-session-id",
    "codely-session",
    "--agent-session-path",
    "/tmp/codely-session.jsonl",
    "--session-start-source",
    "startup",
  ]);
  expect(argsWithoutSeq(idle.args)).toEqual([
    "pane",
    "report-agent",
    "test:p1",
    "--source",
    "herdr:codely",
    "--agent",
    "codely",
    "--state",
    "idle",
  ]);
  expect(seqOf(idle.args)).toBeGreaterThan(seqOf(session.args));
});

for (const source of ["startup", "resume", "clear"]) {
  test(`SessionStart from ${source} implies the agent is idle`, () => {
    const { reports } = runHook({
      hook_event_name: "SessionStart",
      session_id: "codely-session",
      source,
    });

    expect(reports).toHaveLength(2);
    expect(stateOf(reports[1].args)).toBe("idle");
  });
}

for (const source of ["compact", "other", undefined]) {
  test(`SessionStart from ${source ?? "an unknown source"} keeps only the session report`, () => {
    const { reports } = runHook({
      hook_event_name: "SessionStart",
      session_id: "codely-session",
      source,
    });

    expect(reports).toHaveLength(1);
    expect(argsWithoutSeq(reports[0].args)).toContain("report-agent-session");
  });
}

for (const [event, state] of [
  ["BeforeAgent", "working"],
  ["BeforeTool", "working"],
  ["AfterAgent", "idle"],
] as const) {
  test(`${event} reports ${state}`, () => {
    const { result, reports } = runHook({ hook_event_name: event });

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(reports).toHaveLength(1);
    expect(argsWithoutSeq(reports[0].args)).toEqual([
      "pane",
      "report-agent",
      "test:p1",
      "--source",
      "herdr:codely",
      "--agent",
      "codely",
      "--state",
      state,
    ]);
  });
}

test("Notification reports blocked with its notification type", () => {
  const { reports } = runHook({
    hook_event_name: "Notification",
    notification_type: "elicitation",
    message: "Pick a model",
  });

  expect(reports).toHaveLength(1);
  expect(stateOf(reports[0].args)).toBe("blocked");
  expect(messageOf(reports[0].args)).toBe("waiting for input: elicitation");
});

test("PermissionRequest prefers the tool name as the blocked detail", () => {
  const { reports } = runHook({
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    notification_type: "permission",
    message: "Run the test suite?",
  });

  expect(reports).toHaveLength(1);
  expect(stateOf(reports[0].args)).toBe("blocked");
  expect(messageOf(reports[0].args)).toBe("waiting for input: Bash");
});

test("blocked reports omit an empty detail", () => {
  const { reports } = runHook({
    hook_event_name: "PermissionRequest",
    message: " \n\t ",
  });

  expect(reports).toHaveLength(1);
  expect(stateOf(reports[0].args)).toBe("blocked");
  expect(messageOf(reports[0].args)).toBeUndefined();
});

test("blocked details are collapsed and truncated to the hook limit", () => {
  const { reports } = runHook({
    hook_event_name: "Notification",
    message: `line one\n\nline two ${"x".repeat(200)}`,
  });

  expect(reports).toHaveLength(1);
  const detail = messageOf(reports[0].args);
  expect(detail).toBeDefined();
  expect(detail?.startsWith("waiting for input: line one line two x")).toBe(true);
  expect(detail).toHaveLength("waiting for input: ".length + 160);
  expect(detail?.endsWith("…")).toBe(true);
});

test("events from subagents are ignored", () => {
  const { result, reports } = runHook({
    hook_event_name: "BeforeTool",
    agent_id: "subagent-1",
    session_id: "codely-session",
  });

  expect(result.status).toBe(0);
  expect(reports).toEqual([]);
});

test("the hook is a no-op outside a Herdr pane", () => {
  const noEnvironment = runHook({ hook_event_name: "BeforeAgent" }, { HERDR_ENV: undefined });
  expect(noEnvironment.result.status).toBe(0);
  expect(noEnvironment.result.stdout).toBe("");
  expect(noEnvironment.reports).toEqual([]);

  const noPane = runHook({ hook_event_name: "BeforeAgent" }, { HERDR_PANE_ID: undefined });
  expect(noPane.reports).toEqual([]);
});

test("the hook stays silent without HERDR_BIN_PATH", () => {
  const { reports } = runHook({ hook_event_name: "BeforeAgent" }, { HERDR_BIN_PATH: undefined });

  expect(reports).toEqual([]);
});

test("reports run through a custom HERDR_BIN_PATH", () => {
  const { reports } = runHook(
    { hook_event_name: "BeforeAgent" },
    { HERDR_BIN_PATH: "C:\\tools\\herdr.exe" },
  );

  expect(reports).toHaveLength(1);
  expect(reports[0].command).toBe("C:\\tools\\herdr.exe");
});

test("unknown or missing events report nothing", () => {
  expect(runHook({ hook_event_name: "SessionEnd", session_id: "codely-session" }).reports).toEqual(
    [],
  );
  expect(runHook({ session_id: "codely-session" }).reports).toEqual([]);
});

test("SessionStart without a session id reports nothing", () => {
  expect(runHook({ hook_event_name: "SessionStart", source: "startup" }).reports).toEqual([]);
  expect(
    runHook({ hook_event_name: "SessionStart", session_id: "   ", source: "startup" }).reports,
  ).toEqual([]);
});

test("invalid JSON is ignored without failing the agent", () => {
  const { result, reports } = runHook("{not json");

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("ignoring invalid hook payload");
  expect(reports).toEqual([]);
});

test("empty stdin is a no-op", () => {
  const { result, reports } = runHook("");

  expect(result.status).toBe(0);
  expect(result.stdout).toBe("");
  expect(reports).toEqual([]);
});

test("a UTF-8 BOM does not break the payload", () => {
  const { reports } = runHook(`\uFEFF${JSON.stringify({ hook_event_name: "BeforeAgent" })}`);

  expect(reports).toHaveLength(1);
  expect(stateOf(reports[0].args)).toBe("working");
});
