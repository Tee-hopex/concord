import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CLI_OPTIONS, closestFlag, describeArgsError } from "../src/cli-usage.js";
import { openRuntime } from "../src/main.js";
import { loadConfig, type Config } from "../src/config.js";

const tsx = fileURLToPath(import.meta.resolve("tsx/cli"));
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

/** What the CLI prints for a command line parseArgs refuses. */
function refusal(args: string[]): string | undefined {
  try {
    parseArgs({ args, allowPositionals: true, options: CLI_OPTIONS });
  } catch (err) {
    return describeArgsError(err, args);
  }
  throw new Error(`parseArgs accepted ${args.join(" ")}`);
}

describe("closestFlag", () => {
  it("suggests the flag a typo most likely meant", () => {
    expect(closestFlag("netwrk")).toBe("network");
    expect(closestFlag("asof")).toBe("as-of");
    expect(closestFlag("jsno")).toBe("json");
    expect(closestFlag("NETWORK")).toBe("network");
    expect(closestFlag("no-basline")).toBe("no-baseline");
  });

  it("suggests the only flag that starts with what was typed", () => {
    expect(closestFlag("dec")).toBe("decimals");
    expect(closestFlag("pay-")).toBe("pay-asset");
  });

  it("picks the nearest of several candidates", () => {
    expect(closestFlag("rato", ["rate", "ratio", "register"])).toBe("rate");
    expect(closestFlag("ratioo", ["rate", "ratio", "register"])).toBe("ratio");
  });

  it("suggests nothing when no flag is close", () => {
    expect(closestFlag("bogus")).toBeUndefined();
    expect(closestFlag("x")).toBeUndefined();
    expect(closestFlag("frobnicate")).toBeUndefined();
    // Shared by more than one flag, so no prefix suggestion either.
    expect(closestFlag("pa")).toBeUndefined();
  });
});

describe("describeArgsError", () => {
  const hint = "Run 'concord --help' for usage.";

  it("names an unknown flag, with a suggestion when one is close", () => {
    expect(refusal(["holdings", "X", "--bogus", "1"])).toBe(`unknown option '--bogus'. ${hint}`);
    expect(refusal(["holdings", "X", "--asof", "2026-10-01"])).toBe(
      `unknown option '--asof'. Did you mean '--as-of'? ${hint}`,
    );
    expect(refusal(["holdings", "X", "--netwrk=testnet"])).toBe(
      `unknown option '--netwrk'. Did you mean '--network'? ${hint}`,
    );
    expect(refusal(["assets", "-z"])).toBe(`unknown option '-z'. ${hint}`);
  });

  it("says when a flag is missing its value or has one it does not take", () => {
    expect(refusal(["holdings", "X", "--as-of"])).toBe(`option '--as-of' needs a value. ${hint}`);
    expect(refusal(["holdings", "X", "--org", "--json"])).toBe(
      `option '--org' needs a value, not '--json' (write --org=--json if that is the value). ${hint}`,
    );
    expect(refusal(["assets", "--json=yes"])).toBe(`option '--json' does not take a value. ${hint}`);
  });

  it("is one line and never Node's own wording", () => {
    for (const args of [
      ["x", "--bogus"],
      ["x", "--org"],
      ["x", "--org", "-y"],
      ["x", "--yes=1"],
    ]) {
      const message = refusal(args)!;
      expect(message).not.toContain("\n");
      expect(message).not.toMatch(/To specify|ambiguous|argument missing/);
      expect(message.endsWith(hint)).toBe(true);
    }
  });

  it("leaves errors that are not parseArgs refusals to the caller", () => {
    expect(describeArgsError(new Error("database is locked"), ["assets"])).toBeUndefined();
    expect(describeArgsError(Object.assign(new Error("x"), { code: "ENOENT" }), ["assets"])).toBeUndefined();
    expect(describeArgsError(undefined, ["assets"])).toBeUndefined();
  });
});

describe("CLI usage errors", { timeout: 30_000 }, () => {
  it("prints one line to stderr and exits 1 for an unknown flag", () => {
    const res = spawnSync(process.execPath, [tsx, cliPath, "holdings", "X", "--netwrk", "testnet"], {
      encoding: "utf8",
    });
    expect(res.status).toBe(1);
    expect(res.stdout).toBe("");
    const lines = res.stderr
      .split(/\r?\n/)
      .filter((line) => line && !/ExperimentalWarning|--trace-warnings/.test(line));
    expect(lines).toEqual(["unknown option '--netwrk'. Did you mean '--network'? Run 'concord --help' for usage."]);
  });

  it("still prints the usage text for --help", () => {
    const res = spawnSync(process.execPath, [tsx, cliPath, "--help"], { encoding: "utf8" });
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("concord — reconcile tokenized securities");
  });
});

describe("CLI registers and register-delete", { timeout: 30_000 }, () => {
  let dataDir: string;
  let orgId: string;
  let config: Config;
  const assetCode = "TEST";

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "concord-cli-test-"));
    config = loadConfig({ CONCORD_DATA_DIR: dataDir });
    const runtime = openRuntime(config);
    const { orgId: newOrgId } = await runtime.auth.signUp({
      email: "user@example.test",
      name: "Test User",
      password: "Password123!",
      orgName: "Test Org",
    });
    orgId = newOrgId;

    const concord = runtime.tenants.forOrg(orgId);
    concord.db.insert(
      `INSERT INTO assets (id, network, code, issuer, name, decimals, start_mode, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      assetCode,
      "testnet",
      assetCode,
      "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
      "Test Asset",
      7,
      "ledger",
      "ready",
      "2026-10-01T00:00:00Z",
    );
    runtime.close();
  });

  beforeEach(async () => {
    const runtime = openRuntime(config);
    const concord = runtime.tenants.forOrg(orgId);
    concord.db.raw.exec("DELETE FROM runs; DELETE FROM registers; DELETE FROM register_positions;");

    const csv1 = "holder_id,account,units,status\nH1,GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,100,active\n";
    const reg1 = concord.importRegister(
      assetCode,
      { csv: csv1, asOf: "2026-10-01T00:00:00.000Z", source: "reg1.csv" },
      { id: "u1", label: "admin <admin@example.test>" },
    );
    await concord.reconcile(assetCode, reg1.registerId);

    const csv2 = "holder_id,account,units,status\nH1,GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5,90,active\n";
    const reg2 = concord.importRegister(assetCode, { csv: csv2, asOf: "2026-10-02T00:00:00.000Z", source: "reg2.csv" });
    await concord.reconcile(assetCode, reg2.registerId);

    runtime.close();
  });

  afterAll(() => {
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        // Ignore file lock release delay on Windows
      }
    }
  });

  function run(args: string[], stdin?: string): { stdout: string; status: number } {
    try {
      const stdout = execFileSync(process.execPath, [tsx, cliPath, ...args], {
        env: {
          ...process.env,
          CONCORD_DATA_DIR: dataDir,
          CONCORD_ORG: orgId,
        },
        input: stdin,
        encoding: "utf8",
      });
      return { stdout, status: 0 };
    } catch (err: unknown) {
      const e = err as { stdout?: string; status?: number; message?: string };
      return { stdout: e.stdout ?? "", status: e.status ?? 1 };
    }
  }

  it("lists imported registers in table format and json format", () => {
    // 1. Table format
    const resTable = run(["registers", assetCode]);
    expect(resTable.status).toBe(0);
    expect(resTable.stdout).toContain("as-of");
    expect(resTable.stdout).toContain("rejected rows");
    expect(resTable.stdout).toContain("reg1.csv");
    expect(resTable.stdout).toContain("reg2.csv");
    expect(resTable.stdout).toContain("admin <admin@example.test>");

    // 2. JSON format
    const resJson = run(["registers", assetCode, "--json"]);
    expect(resJson.status).toBe(0);
    const parsed = JSON.parse(resJson.stdout);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toMatchObject({
      source: "reg2.csv",
      positions: 1,
    });
    expect(parsed[1]).toMatchObject({
      source: "reg1.csv",
      importedBy: "admin <admin@example.test>",
    });
  });

  it("supports aborting register deletion without --yes", () => {
    const listBefore = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listBefore).toHaveLength(2);
    const regId = listBefore[0].id;

    // Run without --yes and input 'n'
    const resAbort = run(["register-delete", assetCode, String(regId)], "n\n");
    expect(resAbort.stdout).toContain("aborted");

    // Verify it was NOT deleted
    const listAfter = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listAfter).toHaveLength(2);
  });

  it("confirms and deletes when 'y' is answered to prompt", () => {
    const listBefore = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listBefore).toHaveLength(2);
    const regId = listBefore[0].id;

    // Run without --yes and input 'y'
    const resConfirm = run(["register-delete", assetCode, String(regId)], "y\n");
    expect(resConfirm.status).toBe(0);
    expect(resConfirm.stdout).toContain(`deleted register ${regId}`);

    // Verify it is deleted
    const listAfter = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listAfter).toHaveLength(1);
    expect(listAfter[0].id).not.toBe(regId);
  });

  it("deletes a register with --yes and reports how many runs went with it", () => {
    const listBefore = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listBefore).toHaveLength(2);
    const regId = listBefore[0].id;

    // Delete with --yes
    const resDel = run(["register-delete", assetCode, String(regId), "--yes"]);
    expect(resDel.status).toBe(0);
    expect(resDel.stdout).toContain(`deleted register ${regId} (1 reconciliation run removed)`);

    // Verify it is gone from the list
    const listAfter = JSON.parse(run(["registers", assetCode, "--json"]).stdout);
    expect(listAfter).toHaveLength(1);
    expect(listAfter[0].id).not.toBe(regId);
  });

  it("fails cleanly when deleting a nonexistent register", () => {
    const res = run(["register-delete", assetCode, "99999", "--yes"]);
    expect(res.status).not.toBe(0);
  });
});
