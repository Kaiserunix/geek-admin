import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../app/server/src/app";
import { createDatabase } from "../../app/server/src/lib/db";
import { GITHUB_PROVIDER, IDENTITY_SEED } from "../../app/server/src/lib/identity-store";
import { OPENID_LENGTH, newOpenId } from "../../app/server/src/lib/openid";
import { testApp, testConfig } from "./helpers";
import type { ServiceOverrides } from "../../app/server/src/services";

/** 与 testApp 同一组必填 env；本文件里要自己指定 DB_PATH 的用例用它。 */
const baseEnv = {
  NODE_ENV: "test", PUBLIC_ORIGIN: "https://example.test",
  FORUM_DB_PATH: "/nonexistent/never-open-legacy-forum.db",
  SESSION_SECRET: "isolated-identity-test-secret-at-least-32",
  ENCRYPTION_KEY: Buffer.alloc(32, 2).toString("base64"),
  OAUTH_CLIENT_ID: "test-client", OAUTH_CLIENT_SECRET: "test-only-placeholder", POW_DIFFICULTY: "0",
};
const deny = (() => { throw new Error("Unexpected external network request in identity test"); }) as unknown as ServiceOverrides["httpRequest"];

/** 假的 GitHub：换 token、取 /user、撤销授权（204）。 */
const githubUser = { id: 4242, login: "zhang-san", avatar_url: "" };
const providerStub = (user: { id: number; login: string } = githubUser) => (async (url: string) => {
  if (String(url).includes("/grant")) return { statusCode: 204, body: { dump: async () => undefined } };
  return { statusCode: 200, body: { json: async () => String(url).includes("/access_token") ? { access_token: "provider-token" } : user } };
}) as unknown as ServiceOverrides["httpRequest"];
/** 成员门槛：active = 组织正式成员；null = 404，不是成员。 */
const membership = (state: "active" | "pending" | null) => (() => ({
  request: async () => {
    if (state === null) throw Object.assign(new Error("Not Found"), { status: 404 });
    return { data: { state, role: "member" } };
  },
})) as unknown as ServiceOverrides["octokitFactory"];

const cookiesOf = (response: { headers: Record<string, unknown> }) =>
  ([] as string[]).concat((response.headers["set-cookie"] as string | string[] | undefined) ?? []);
const sidFrom = (response: { headers: Record<string, unknown> }) =>
  cookiesOf(response).map(cookie => cookie.split(";")[0]).find(cookie => cookie.startsWith("sid="))?.slice("sid=".length) ?? null;

async function startSignIn(app: Awaited<ReturnType<typeof testApp>>["app"]) {
  const start = await app.inject("/auth/github");
  return {
    state: new URL(String(start.headers.location)).searchParams.get("state"),
    cookie: String(start.headers["set-cookie"]).split(";")[0],
  };
}

describe("内部 OpenID（ULID，随机生成）", () => {
  it("26 个字符的 Crockford Base32，不含容易看错的 I/L/O/U", () => {
    const id = newOpenId(1_700_000_000_000, () => Buffer.alloc(10, 7));
    expect(id).toHaveLength(OPENID_LENGTH);
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("随机部分不同就是不同的 id；时间戳大的字典序也在后", () => {
    expect(new Set(Array.from({ length: 200 }, () => newOpenId(1_700_000_000_000))).size).toBe(200);
    const fixed = () => Buffer.alloc(10, 0);
    expect(newOpenId(1_700_000_000_000, fixed) < newOpenId(1_700_000_001_000, fixed)).toBe(true);
  });

  it("时间戳或随机源不合法时直接拒绝，不静默生成", () => {
    expect(() => newOpenId(-1)).toThrow();
    expect(() => newOpenId(1.5)).toThrow();
    expect(() => newOpenId(2 ** 50)).toThrow();
    expect(() => newOpenId(0, () => Buffer.alloc(8))).toThrow();
  });

  it("遵守 ULID 的 48 位时间戳上限，不生成超过 128 位的值", () => {
    expect(newOpenId(2 ** 48 - 1, () => Buffer.alloc(10, 255))).toBe("7ZZZZZZZZZZZZZZZZZZZZZZZZZ");
    expect(() => newOpenId(2 ** 48)).toThrow();
  });
});

describe("身份表结构", () => {
  it("三张表与 sessions 的影子列都在", async () => {
    const { app, close } = await testApp();
    const db = app.services.storage.db;
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(row => row.name);
    expect(tables).toEqual(expect.arrayContaining(["users", "identities", "identity_audit"]));
    expect((db.pragma("table_info(sessions)") as { name: string }[]).map(column => column.name)).toEqual(expect.arrayContaining(["openid", "provider"]));
    await close();
  });

  it("UNIQUE(provider, provider_uid)：同一渠道的同一 id 不能挂两次", async () => {
    const { app, close } = await testApp();
    const first = app.services.identity.resolveGithubIdentity({ login: "zhang-san", userId: 4242 });
    expect(first.created).toBe(true);
    expect(() => app.services.storage.db
      .prepare("INSERT INTO identities(id, user_id, provider, provider_uid, created_at) VALUES('dup', ?, 'github', '4242', 0)")
      .run(first.openid)).toThrow(/UNIQUE/i);
    await close();
  });
});

describe("GitHub 身份落库", () => {
  it("第一次建身份，第二次只更新 last_login_at", async () => {
    let now = 1_700_000_000_000;
    const { app, close } = await testApp({ clock: () => now });
    const { identity } = app.services;
    const first = identity.resolveGithubIdentity({ login: "zhang-san", userId: 4242 });
    expect(first.created).toBe(true);
    expect(identity.findIdentity(GITHUB_PROVIDER, "4242")?.last_login_at).toBe(now);
    now += 60_000;
    const second = identity.resolveGithubIdentity({ login: "zhang-san", userId: 4242 });
    expect(second.created).toBe(false);
    expect(second.openid).toBe(first.openid);
    const counts = app.services.storage.db.prepare("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM identities) AS identities").get();
    expect(counts).toEqual({ users: 1, identities: 1 });
    expect(identity.listIdentities(first.openid)).toHaveLength(1);
    expect(identity.findIdentity(GITHUB_PROVIDER, "4242")?.last_login_at).toBe(now);
    await close();
  });

  it("provider_uid 用 GitHub 数字 id：改名还是同一个人，换个 id 就是另一个身份", async () => {
    const { app, close } = await testApp();
    const { identity } = app.services;
    const before = identity.resolveGithubIdentity({ login: "zhang-san", userId: 4242 });
    const renamed = identity.resolveGithubIdentity({ login: "zhang-san-renamed", userId: 4242 });
    expect(renamed.openid).toBe(before.openid);
    const other = identity.resolveGithubIdentity({ login: "zhang-san", userId: 9999 });
    expect(other.openid).not.toBe(before.openid);
    expect(identity.countLoginableIdentities(before.openid)).toBe(1);
    await close();
  });
});

describe("存量回填（老库升级）", () => {
  it("只有旧列的会话库启动后补出 users + identities 与影子列，重复启动不重复做", async () => {
    const dir = mkdtempSync(join(tmpdir(), "geek-identity-"));
    const path = join(dir, "data.db");
    try {
      // 造一个「改造前」的库：sessions 只有旧列，身份表还不存在（模拟没有任何迁移框架的老库）
      const legacy = createDatabase(path);
      legacy.db.exec("DROP TABLE IF EXISTS sessions; DROP TABLE IF EXISTS identity_audit; DROP TABLE IF EXISTS identities; DROP TABLE IF EXISTS users");
      legacy.db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, login TEXT NOT NULL, user_id INTEGER, avatar_url TEXT, access_token_encrypted TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
      const ts = Date.now();
      const insert = legacy.db.prepare("INSERT INTO sessions(id, login, user_id, avatar_url, access_token_encrypted, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?)");
      insert.run("legacy-sid-1", "zhang-san", 4242, null, "x", ts, ts + 60_000);
      insert.run("legacy-sid-2", "li-si", 4243, null, "y", ts, ts + 60_000);
      insert.run("legacy-sid-3", "no-user-id", null, null, "z", ts, ts + 60_000);
      insert.run("legacy-sid-4", "zhang-san-renamed", 4242, null, "renamed", ts, ts + 60_000);
      const oldColumns = "id, login, user_id, avatar_url, access_token_encrypted, created_at, expires_at";
      const oldSessions = legacy.db.prepare(`SELECT ${oldColumns} FROM sessions ORDER BY id`).all();
      expect(legacy.db.prepare("SELECT COUNT(*) AS n FROM console_seeds WHERE name = ?").get(IDENTITY_SEED)).toEqual({ n: 0 });
      legacy.db.close();

      const first = await buildApp({ config: testConfig({ ...baseEnv, DB_PATH: path }), staticRoot: false, overrides: { httpRequest: deny, octokitFactory: deny, mailFetch: deny as unknown as ServiceOverrides["mailFetch"] } });
      await first.ready();
      const db = first.services.storage.db;
      expect(db.prepare("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM identities) AS identities").get()).toEqual({ users: 2, identities: 2 });
      const linked = db.prepare("SELECT id, openid, provider FROM sessions ORDER BY id").all() as { id: string; openid: string | null; provider: string | null }[];
      expect(linked.map(row => [row.id, Boolean(row.openid), row.provider])).toEqual([["legacy-sid-1", true, "github"], ["legacy-sid-2", true, "github"], ["legacy-sid-3", false, null], ["legacy-sid-4", true, "github"]]);
      expect(linked[3].openid).toBe(linked[0].openid);
      expect(db.prepare(`SELECT ${oldColumns} FROM sessions ORDER BY id`).all()).toEqual(oldSessions);
      // 回填的身份是随机内部 OpenID，且用 GitHub 数字 id 作为 provider_uid
      const identity = first.services.identity.findIdentity(GITHUB_PROVIDER, "4242");
      expect(identity?.user_id).toHaveLength(OPENID_LENGTH);
      expect(db.prepare("SELECT COUNT(*) AS n FROM identity_audit WHERE action = 'link' AND result = 'backfill'").get()).toEqual({ n: 2 });
      expect(db.prepare("SELECT COUNT(*) AS n FROM console_seeds WHERE name = ?").get(IDENTITY_SEED)).toEqual({ n: 1 });
      await first.close();

      // 第二次启动：标记已在，什么都不再做
      const second = await buildApp({ config: testConfig({ ...baseEnv, DB_PATH: path }), staticRoot: false, overrides: { httpRequest: deny, octokitFactory: deny, mailFetch: deny as unknown as ServiceOverrides["mailFetch"] } });
      await second.ready();
      expect(second.services.identity.backfillSessions()).toEqual({ skipped: true, users: 0, identities: 0, sessions: 0, unlinked: 0 });
      expect(second.services.storage.db.prepare("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM identities) AS identities, (SELECT COUNT(*) FROM identity_audit) AS audit").get()).toEqual({ users: 2, identities: 2, audit: 2 });
      await second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("登录流程接入内部身份", () => {
  it.each(["sessions", "audit_logs"])("%s 写入失败时保留旧会话，并撤销本次身份与成功审计", async (table) => {
    const { app, close } = await testApp({ httpRequest: providerStub(), octokitFactory: membership("active") });
    try {
      const db = app.services.storage.db;
      const oldSid = app.services.auth.createSession("previous-user", 123, "", "previous-token");
      const oldSession = db.prepare("SELECT * FROM sessions WHERE id = ?").get(oldSid);
      db.exec(`CREATE TRIGGER fail_login BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected login failure'); END`);
      const { state, cookie } = await startSignIn(app);
      const response = await app.inject({ url: `/auth/callback?code=ok&state=${state}`, headers: { cookie: `${cookie}; sid=${oldSid}` } });
      expect(response.statusCode).toBe(500);
      expect(sidFrom(response)).toBeNull();
      expect(db.prepare("SELECT * FROM sessions").all()).toEqual([oldSession]);
      expect(app.services.auth.getSession(oldSid)?.login).toBe("previous-user");
      expect(db.prepare("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM identities) AS identities, (SELECT COUNT(*) FROM identity_audit) AS audit").get())
        .toEqual({ users: 0, identities: 0, audit: 0 });
    } finally {
      await close();
    }
  });

  it("重复登录失败不更新 last_login_at，也不留下成功审计", async () => {
    let now = 1_700_000_000_000;
    const { app, close } = await testApp({ clock: () => now, httpRequest: providerStub(), octokitFactory: membership("active") });
    try {
      const first = await startSignIn(app);
      const firstResponse = await app.inject({ url: `/auth/callback?code=ok&state=${first.state}`, headers: { cookie: first.cookie } });
      const oldSid = sidFrom(firstResponse)!;
      const identity = app.services.identity.findIdentity(GITHUB_PROVIDER, String(githubUser.id));
      const db = app.services.storage.db;
      now += 60_000;
      db.exec("CREATE TRIGGER fail_login BEFORE INSERT ON sessions BEGIN SELECT RAISE(ABORT, 'injected login failure'); END");
      const second = await startSignIn(app);
      const response = await app.inject({ url: `/auth/callback?code=ok&state=${second.state}`, headers: { cookie: `${second.cookie}; sid=${oldSid}` } });
      expect(response.statusCode).toBe(500);
      expect(app.services.identity.findIdentity(GITHUB_PROVIDER, String(githubUser.id))).toEqual(identity);
      expect(app.services.identity.listAudit(identity!.user_id)).toHaveLength(1);
      expect(app.services.auth.getSession(oldSid)).not.toBeNull();
      expect(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()).toEqual({ n: 1 });
    } finally {
      await close();
    }
  });

  it("登录成功后写入身份并双写会话影子列，旧列语义不变", async () => {
    const { app, close } = await testApp({ httpRequest: providerStub(), octokitFactory: membership("active") });
    const { state, cookie } = await startSignIn(app);
    const response = await app.inject({ url: `/auth/callback?code=ok&state=${state}`, headers: { cookie } });
    expect(response.statusCode).toBe(302);
    const db = app.services.storage.db;
    const identity = app.services.identity.findIdentity(GITHUB_PROVIDER, String(githubUser.id));
    expect(identity).not.toBeNull();
    expect(identity!.user_id).toHaveLength(OPENID_LENGTH);
    expect(db.prepare("SELECT login, user_id, avatar_url, openid, provider FROM sessions").get()).toEqual({
      login: githubUser.login, user_id: githubUser.id, avatar_url: "", openid: identity!.user_id, provider: "github",
    });
    expect(app.services.identity.listAudit(identity!.user_id)).toEqual([
      expect.objectContaining({ action: "login", provider: "github", provider_uid: String(githubUser.id), result: "created" }),
    ]);
    const sid = sidFrom(response)!;
    const session = app.services.auth.getSession(sid);
    expect(session).toEqual({
      id: sid, login: githubUser.login, user_id: githubUser.id, avatar_url: "",
      accessToken: "provider-token", expires_at: expect.any(Number),
    });
    // 影子列只写不读：即使其值与 GitHub 不一致，也不能影响现有会话或公开接口。
    db.prepare("UPDATE sessions SET openid = 'shadow-only', provider = 'shadow-only' WHERE id = ?").run(sid);
    expect(app.services.auth.getSession(sid)).toEqual(session);
    const me = await app.inject({ url: "/auth/me", headers: { cookie: `sid=${sid}` } });
    expect(me.json()).toEqual({ signed_in: true, login: githubUser.login, user_id: githubUser.id, avatar_url: "", console_link: false });
    await close();
  });

  it("重复登录不产生第二个身份，并作废登录前已有的那个会话（sid 轮换）", async () => {
    const { app, close } = await testApp({ httpRequest: providerStub(), octokitFactory: membership("active") });
    const db = app.services.storage.db;
    const firstSignIn = await startSignIn(app);
    const firstResponse = await app.inject({ url: `/auth/callback?code=ok&state=${firstSignIn.state}`, headers: { cookie: firstSignIn.cookie } });
    const firstSid = sidFrom(firstResponse);
    expect(firstSid).not.toBeNull();

    // 第二次登录带上第一次的 sid：它必须立刻失效
    const secondSignIn = await startSignIn(app);
    const secondResponse = await app.inject({ url: `/auth/callback?code=ok&state=${secondSignIn.state}`, headers: { cookie: `${secondSignIn.cookie}; sid=${firstSid}` } });
    const secondSid = sidFrom(secondResponse);
    expect(secondSid).not.toBeNull();
    expect(secondSid).not.toBe(firstSid);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(firstSid)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE id = ?").get(secondSid)).toEqual({ n: 1 });
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM identities) AS identities").get()).toEqual({ users: 1, identities: 1 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM identity_audit WHERE action = 'login'").get()).toEqual({ n: 2 });
    await close();
  });

  it("不是组织成员的人照旧不建会话，也不留内部身份", async () => {
    const { app, close } = await testApp({ httpRequest: providerStub(), octokitFactory: membership(null) });
    const { state, cookie } = await startSignIn(app);
    const response = await app.inject({ url: `/auth/callback?code=ok&state=${state}`, headers: { cookie } });
    expect(response.headers.location).toBe("https://example.test/console?signin=not_member");
    expect(cookiesOf(response).some(value => value.startsWith("sid="))).toBe(false);
    const db = app.services.storage.db;
    expect(db.prepare("SELECT (SELECT COUNT(*) FROM users) AS users, (SELECT COUNT(*) FROM identities) AS identities, (SELECT COUNT(*) FROM sessions) AS sessions").get()).toEqual({ users: 0, identities: 0, sessions: 0 });
    await close();
  });
});
