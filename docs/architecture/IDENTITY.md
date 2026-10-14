# 身份模型（内部 OpenID 与第三方凭据）

> 第三方渠道 id 只是**凭据**，`users.id`（内部 OpenID）才是**身份**；1 个用户可绑定 N 个渠道。本文是身份层的唯一说明，落地见 issue #226。

状态：`current` · 更新：2026-10-14 · 代码：`app/server/src/lib/identity-store.ts`、`app/server/src/lib/openid.ts` · 表结构：`app/server/src/lib/db.ts` · 上级：[ARCHITECTURE](ARCHITECTURE.md)、[SECURITY](SECURITY.md)

## 为什么要有这一层

改造前，登录身份就是第三方账号本身：`sessions` 直接存 GitHub 数字 id 与 GitHub token（`lib/auth.ts`）。这带来三件事——渠道 id 可被枚举、同一个人挂不上第二个渠道、改名或换邮箱就可能被当成另一个人。本层把「凭据」和「身份」拆开：**渠道怎么变都不影响身份**，渠道凭据只用来证明「你是你」。

## 数据模型

三张新表（只新增，不改已有表结构；DDL 在 `lib/db.ts`，建表全部 `IF NOT EXISTS`）：

| 表 | 用途 | 关键约束 |
|---|---|---|
| `users` | 内部身份。`id` 就是内部 OpenID | `status` ∈ `active`/`disabled`/`merged`；`merged_into` 指向合并后的目标身份；`canonical_email` 只在邮箱**已验证**时写 |
| `identities` | 第三方凭据，1 个用户 N 条 | `UNIQUE(provider, provider_uid)`；有 union id 时再 `UNIQUE(provider, provider_union_id)`；`INDEX(user_id)`；`user_id` 外键 `ON DELETE CASCADE` |
| `identity_audit` | 身份动作留痕 | `action` ∈ `link`/`unlink`/`login`/`merge`；只记 `user_id`、渠道、来源 IP 与 UA、结果，不记第三方返回的个人信息 |

`sessions` 增加两个**可空影子列**：`openid`、`provider`。它们与旧列（`login`、`user_id`、`avatar_url`、`access_token_encrypted`、`created_at`、`expires_at`）**双写**，但**读路径仍以旧列为准**——本阶段没有任何接口或中间件改成读影子列，所以行为与改造前一致。

## 不变量（改动时必须保持）

1. **内部 OpenID 随机生成**：ULID 布局（48 位毫秒时间戳 + 80 位随机，Crockford Base32，26 字符），`lib/openid.ts` 生成；按 [ULID 规范](https://github.com/ulid/spec#overflow-errors-when-parsing-base32-strings) 拒绝大于 `2^48-1` 的时间戳。**绝不用自增、绝不用渠道 id**，避免被枚举。
2. **`provider_uid` 只能用不可变 id**：GitHub 用 `id`（数字），**不用 `login`，也不用邮箱**——用户名可以改、邮箱可以换。改名不应换身份。
3. **同一凭据不能挂两次**：由 `UNIQUE(provider, provider_uid)` 在库里强制，冲突时报错而不是静默覆盖。
4. **禁止只凭邮箱字符串自动合并**：`/user` 的公开邮箱不构成证明，当前一律按**未验证**处理（不写 `canonical_email`）；将来要自动合并，只允许 `email_verified = true` 且该邮箱在全库唯一一致时进行。
5. **不能把账号锁死**：解绑前必须确认该用户还剩 **≥1** 个可登录身份（`identity-store.countLoginableIdentities`）；`unlink` 由 P1 的接口把关。
6. **登录成功后轮换 session id**：作废浏览器上原有的那个会话，避免会话固定。身份创建/更新时间、两种登录审计和会话轮换在同一个数据库事务中提交；任一步失败全部撤销，保留旧会话，且不下发新 sid。GitHub 请求在事务之前完成。

## 登录流程（本阶段：只有 GitHub）

```text
浏览器            server（routes/admin/auth.ts）              GitHub            data.db
  │  GET /auth/github                                         │                  │
  ├──────────────► 写签名 state cookie（middleware/oauth-state）                  │
  │                     │  302                 │                                 │
  │◄────────────────────┘                      │                                 │
  │  授权 → GET /auth/callback?code&state      │                                 │
  ├──────────────► 校验 state 签名与有效期     │                                 │
  │                     ├─ 换 token ──────────►│                                 │
  │                     ├─ 取 /user（id/login）►│                                 │
  │                     ├─ 查组织成员状态 ─────►│                                 │
  │                     │                      │                                 │
  │                     ├─ 不是 active 成员：不建会话、撤授权、?signin=…            │
  │                     └─ 是 active 成员：                                       │
  │                          resolveGithubIdentity(id, login)  ──────────────────►│ 命中/新建 users + identities
  │                          identity_audit(action=login)      ──────────────────►│
  │                          作废旧 sid + 建新 sid（双写 openid/provider）─────────►│
  │◄────────────  302 回发起页 + Set-Cookie: sid                                │
```

**关键顺序**：先过组织成员门槛，**再**落内部身份与建会话。不是成员的人既没有会话，也不留内部身份（`tests/server/identity.test.ts` 有一条用例专门盯这个）。

## 存量回填与回滚

- **回填**（`identity-store.backfillSessions()`，服务启动时跑一次）：老库里能定位到的身份只有会话行——`user_id` 是 GitHub 数字 id。为每个不同的 `user_id` 补一份 `users` + `identities`，把已有会话的影子列补上，并各记一条 `identity_audit(action=link, result=backfill)`。过程在一个事务里，最后写 `console_seeds` 标记（`identity_openid`），**重复启动不再执行**。`user_id` 为空的旧会话无法关联身份，只统计不猜（返回值里的 `unlinked`）。
- **回滚**：`node app/server/scripts/rollback-identity.mjs --db <绝对路径> [--yes]`（默认只报告、不写）。它清空 `sessions.openid/provider`、删掉 `identity_openid` 标记、丢掉三张新表；**不删两个影子列**（SQLite 老版本不支持 `DROP COLUMN`），默认以只读连接检查，确认执行时仅清理实际存在的影子列，支持升级中断在两次加列之间的库；旧列与其它播种标记保持原样。操作时先停止使用新身份表的服务，在数据库副本上验证后执行脚本，再启动改造前版本；若再次启动本版本，会重新建表并回填，不会保持回滚状态。

## 本阶段做了 / 没做

**做了**：三张表与影子列、内部 OpenID、GitHub 登录接入内部身份、双写、sid 轮换、存量回填、审计、回滚脚本、单测。

**没做**（都在 issue #226 的「不做什么」里，另有安排）：

- 第二个渠道（Google/微信等）与渠道开关 env —— 渠道只是凭据，加渠道不改本层结构。
- **登录准入门槛不变**：仍是「只有 `CONSOLE_ORG` 的 active 成员能登录」。是否允许非组织成员建内部身份属于安全模型变更，需所有者明确授权后另开。
- **绑定 / 解绑 / 合并接口**（P1）。规划中的时序：

```text
绑定  已登录用户 → step-up 重认证 → OAuth 授权 → 取 provider_uid
      ├─ 该凭据没被占用 → 写 identities(link) + identity_audit(link)
      └─ 已被他人绑定 → 409，引导走合并；不得静默覆盖
解绑  已登录用户 → step-up 重认证 → 校验剩余可登录身份 ≥1
      ├─ ≥1 → 删 identities + identity_audit(unlink)
      └─ =0 → 拒绝（防锁死）
合并  merge(sourceUser, targetUser)：迁移 identities → 源用户 status=merged + merged_into
      → 旧会话重定向到目标 → identity_audit(merge)
```

- PKCE、redirect_uri 白名单的收紧（现状是签名 state cookie + `lib/safe-return.ts`）。

## 相关

- [SECURITY](SECURITY.md)「身份与渠道」；[ARCHITECTURE](ARCHITECTURE.md) 登录与数据一节。
- [server 数据模型](../services/server/data-model.md) 的表清单；[server 服务合同](../services/server/README.md)。
- 落地与验收：[issue #226](https://github.com/Yangtze-University-Geek-Class/admin/issues/226)。
