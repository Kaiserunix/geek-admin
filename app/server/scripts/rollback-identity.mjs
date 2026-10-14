#!/usr/bin/env node
// #226「内部身份地基」的回滚脚本：把服务端的身份改造退回改造前的样子。
//
// 用法（对着明确的库文件跑；默认只报告，不加 --yes 不写任何东西）：
//   node app/server/scripts/rollback-identity.mjs --db /绝对路径/data.db
//   node app/server/scripts/rollback-identity.mjs --db /绝对路径/data.db --yes
//
// 回滚做什么：
//   1. 清空 sessions.openid / sessions.provider（两列保留——SQLite 不支持 DROP COLUMN 的版本上会失败）；
//   2. 删掉 console_seeds 里的 identity_openid 标记；
//   3. 丢掉 users / identities / identity_audit 三张表。
// 旧列（login / user_id / access_token_encrypted / created_at / expires_at）自始至终没有被改过，
// 回滚前先停使用新身份表的服务，回滚后启动改造前版本；再次启动本版本会重新建表并回填。
// 只碰上面这几样，不动任何其它表，不连网络，也不写库文件之外的任何路径。
import Database from "better-sqlite3";
import { existsSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

const TABLES = ["identity_audit", "identities", "users"];
const SEED = "identity_openid";

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const dbPath = option("--db");
const confirmed = args.includes("--yes");

if (!dbPath || !isAbsolute(dbPath)) {
  console.error("用法：node app/server/scripts/rollback-identity.mjs --db <绝对路径> [--yes]");
  process.exit(2);
}
if (!existsSync(dbPath)) {
  console.error(`库文件不存在：${resolve(dbPath)}`);
  process.exit(2);
}

const db = new Database(dbPath, { readonly: !confirmed, fileMustExist: true });
const hasTable = (name) => db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;
const present = TABLES.filter(hasTable);
const seeded = hasTable("console_seeds") && db.prepare("SELECT 1 FROM console_seeds WHERE name = ?").get(SEED) !== undefined;
const sessionColumns = hasTable("sessions") ? db.pragma("table_info(sessions)").map((column) => column.name) : [];
// 升级可能中断在两次 ADD COLUMN 之间；列名只取代码允许列表，不假定两列同时存在。
const shadowColumns = ["openid", "provider"].filter(column => sessionColumns.includes(column));
const shadowPredicate = shadowColumns.map(column => `${column} IS NOT NULL`).join(" OR ");
const shadowed = shadowColumns.length ? db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE ${shadowPredicate}`).get().n : 0;

console.log(`库文件：${realpathSync(dbPath)}`);
console.log(`存在的身份表：${present.length ? present.join("、") : "（无）"}`);
console.log(`console_seeds 标记 ${SEED}：${seeded ? "在" : "不在"}`);
console.log(`已写入身份影子列的会话：${shadowed} 行`);

if (!present.length && !seeded && !shadowed) {
  console.log("没有可回滚的内容；未做任何改动。");
  db.close();
  process.exit(0);
}
if (!confirmed) {
  console.log("以上是报告；未做任何改动。要真的回滚，加 --yes 再跑一次。");
  db.close();
  process.exit(0);
}

const result = db.transaction(() => {
  const sessionsCleared = shadowColumns.length
    ? db.prepare(`UPDATE sessions SET ${shadowColumns.map(column => `${column} = NULL`).join(", ")} WHERE ${shadowPredicate}`).run().changes
    : 0;
  if (hasTable("console_seeds")) db.prepare("DELETE FROM console_seeds WHERE name = ?").run(SEED);
  const dropped = [];
  for (const table of TABLES) if (hasTable(table)) { db.exec(`DROP TABLE IF EXISTS ${table}`); dropped.push(table); }
  return { sessionsCleared, dropped };
})();

console.log(`已回滚：清空会话影子列 ${result.sessionsCleared} 行；丢掉表 ${result.dropped.length ? result.dropped.join("、") : "（无）"}；标记已删除。`);
db.close();
