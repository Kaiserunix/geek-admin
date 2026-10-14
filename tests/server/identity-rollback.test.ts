import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createDatabase } from "../../app/server/src/lib/db";
import { createIdentityStore, IDENTITY_SEED } from "../../app/server/src/lib/identity-store";

const Database = createRequire(new URL("../../app/server/package.json", import.meta.url))("better-sqlite3") as typeof import("better-sqlite3");
const script = fileURLToPath(new URL("../../app/server/scripts/rollback-identity.mjs", import.meta.url));
const directories: string[] = [];
const legacyColumns = "id, login, user_id, avatar_url, access_token_encrypted, created_at, expires_at";

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "geek-identity-rollback-"));
  directories.push(dir);
  const path = join(dir, "data.db");
  const { db } = createDatabase(path);
  db.prepare(`INSERT INTO sessions(${legacyColumns}) VALUES(?, ?, ?, ?, ?, ?, ?)`)
    .run("legacy-session", "example-user", 4242, "", "synthetic-encrypted-token", 100, 200);
  db.prepare("INSERT INTO console_seeds(name, seeded_at) VALUES('departments', 100)").run();
  createIdentityStore(db).backfillSessions();
  const legacy = db.prepare(`SELECT ${legacyColumns} FROM sessions`).all();
  db.close();
  return { path, legacy };
}

const run = (path: string, ...args: string[]) => spawnSync(process.execPath, [script, "--db", path, ...args], { encoding: "utf8", timeout: 10_000 });

describe("独立身份回滚脚本", () => {
  it("dry run 不改库，确认后只清理身份层，重复回滚安全", () => {
    const { path, legacy } = fixture();
    const before = readFileSync(path);
    const report = run(path);
    expect(report.status, report.stderr).toBe(0);
    expect(report.stdout).toContain("未做任何改动");
    expect(readFileSync(path)).toEqual(before);

    const rollback = run(path, "--yes");
    expect(rollback.status, rollback.stderr).toBe(0);
    const db = new Database(path);
    try {
      expect(db.prepare(`SELECT ${legacyColumns} FROM sessions`).all()).toEqual(legacy);
      expect(db.prepare("SELECT openid, provider FROM sessions").get()).toEqual({ openid: null, provider: null });
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'identities', 'identity_audit')").all()).toEqual([]);
      expect(db.prepare("SELECT name FROM console_seeds").all()).toEqual([{ name: "departments" }]);
    } finally {
      db.close();
    }
    const repeated = run(path, "--yes");
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(repeated.stdout).toContain("没有可回滚的内容");
  });

  it.each(["openid", "provider"])("只有 %s 影子列时仍能回滚，旧会话不丢失", (remaining) => {
    const { path, legacy } = fixture();
    const db = new Database(path);
    db.exec(`ALTER TABLE sessions DROP COLUMN ${remaining === "openid" ? "provider" : "openid"}`);
    db.close();
    const result = run(path, "--yes");
    expect(result.status, result.stderr).toBe(0);
    const restored = new Database(path);
    try {
      expect(restored.prepare(`SELECT ${legacyColumns} FROM sessions`).all()).toEqual(legacy);
      expect(restored.prepare(`SELECT ${remaining} FROM sessions`).get()).toEqual({ [remaining]: null });
      expect(restored.prepare("SELECT name FROM console_seeds WHERE name = ?").get(IDENTITY_SEED)).toBeUndefined();
    } finally {
      restored.close();
    }
  });

  it("只有 provider 残值、没有身份表或标记时也清理影子列", () => {
    const { path } = fixture();
    const db = new Database(path);
    db.exec("DROP TABLE identity_audit; DROP TABLE identities; DROP TABLE users; UPDATE sessions SET openid = NULL");
    db.prepare("DELETE FROM console_seeds WHERE name = ?").run(IDENTITY_SEED);
    db.close();
    const result = run(path, "--yes");
    expect(result.status, result.stderr).toBe(0);
    const restored = new Database(path);
    try {
      expect(restored.prepare("SELECT openid, provider FROM sessions").get()).toEqual({ openid: null, provider: null });
    } finally {
      restored.close();
    }
  });

  it("不接受相对路径，不为不存在的路径新建数据库", () => {
    const { path } = fixture();
    expect(run("relative.db", "--yes").status).toBe(2);
    const missing = join(path, "..", "missing.db");
    expect(run(missing, "--yes").status).toBe(2);
    expect(existsSync(missing)).toBe(false);
  });
});
