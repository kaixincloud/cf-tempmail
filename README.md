# cf-tempmail

基于 Cloudflare 的自建临时邮箱 / 验证码接收服务：**Email Routing 收信 → Worker 解析 → D1 存储**，单个 Worker 同时提供网页与 API，部署简单、运行成本为零（免费额度内）。

- **取码页（首页）**：输入邮箱地址，自动轮询并大字显示最新 6 位验证码，点击复制（类似 OTP Viewer 的极简体验）
- **收件箱页**：按地址查询完整邮件列表与正文，默认由开关关闭，防止被当成公共邮箱薅羊毛
- **鉴权 API**：给程序用的最新邮件接口，Bearer 密钥鉴权，可按时间戳只取新邮件

## 访问模型（安全设计）

这个服务的页面**不暴露任何域名和地址**，也没有注册/建箱流程：

- 邮件到达时邮箱自动出现，不需要预先创建
- 查件必须输入一个**完整且已知**的邮箱地址，且域名必须在服务端 `DOMAINS` 白名单内，否则直接拒绝
- 取码页带**时间门**：只显示你点「开始获取」之后到达的邮件，之前的历史邮件不会返回给前端
- 不输入邮箱绝不返回任何邮件；无邮箱参数的接口调用直接 400

## 功能一览

- Cloudflare Email Routing Catch-all 收信，PostalMime 解析邮件
- 取码页：粘贴邮箱（或整行 `邮箱|密码|...` 账号行，只取邮箱部分）→ 4 秒轮询 → 提取最新 6 位码（关键词上下文优先，其次 `123-456` 分组，最后独立 6 位；主题优先于正文）
- `?email=<地址>` 链接打开页面：自动填入并开始查（取码页仍受时间门约束，只出打开之后的新信）
- 收件箱页（可选开启）：按地址查列表/正文、删除单封、HTML 邮件沙箱渲染
- 存储上限：`MAX_MAILS` 控制总存信量，超量自动删最旧；邮箱 7 天过期连带删信
- 鉴权接口 `GET /api/latest`：返回指定地址最新一封邮件全文，支持 `since` 只取某时刻之后的新信
- 全中文 UI（含错误提示），网站图标内置

## 架构

```
发件方 ──► Cloudflare Email Routing (Catch-all)
                │  email() 触发
                ▼
        ┌───────────────┐      ┌────────┐
        │ Worker        │─────►│ D1     │  mailboxes / mails
        │ ├ 网页 / /inbox │      └────────┘
        │ ├ 公开查件 API  │
        │ └ 鉴权 latest   │
        └───────────────┘
```

## 快速部署

前提：一个域名，DNS 已托管在 Cloudflare。

```bash
npm install
cp wrangler.toml.template wrangler.toml   # 填入你的信息，见下文变量说明

# 1. 建 D1 并初始化表结构
npx wrangler d1 create cf-tempmail        # 把得到的 database_id 填进 wrangler.toml
npx wrangler d1 execute DB --remote --file=db/schema.sql

# 2. 设置鉴权接口的密钥（二选一，自己生成一个随机串）
npx wrangler secret put API_KEY

# 3. 部署
npx wrangler deploy
```

然后在 Cloudflare 控制台为你的域名开启收信（关键一步）：

4. 进入该域名 → **Email → Email Routing** → 启用（Cloudflare 会自动添加 MX 记录）
5. **Routing rules → Catch-all** → 动作选 **Send to a Worker** → 选择 `cf-tempmail` 并启用

完成后，任意 `任意名@你的域名` 的地址即可收信，在首页输入地址即可取码。

> 注意：启用 Email Routing 会接管该域名的全部收信。若域名已有在用的邮箱服务，请改用闲置域名。

## 环境变量

在 `wrangler.toml` 的 `[vars]` 中配置（也可在控制台 Worker → Settings → Variables 修改，立即生效）：

| 变量 | 说明 | 默认 |
|---|---|---|
| `DOMAINS` | 可收信的域名白名单，逗号分隔，如 `"example.com,example.org"`。每个域名都要单独完成上面第 4、5 步 | 必填 |
| `MAX_MAILS` | 邮件总存储上限，超量时清理会删除最旧的邮件 | `1000` |
| `INBOX_ENABLED` | 完整收件箱页 `/inbox` 开关：`1` 开放，其他值（含不设置）关闭（返回 404，取码页同时隐藏入口） | 关闭 |
| `ALLOW_TEST_INJECT` | `1` 时开启本地测试注入接口 `POST /api/test-inject`，**生产环境务必保持 `0`** | `0` |
| `API_KEY`（Secret） | `/api/latest` 的鉴权密钥，用 `wrangler secret put API_KEY` 设置；未设置时该接口一律 503（fail-closed） | 无 |

## API

### 公开查件（无鉴权，靠“知道地址”访问）

```
GET /api/mails?email=<地址>&epin=<可选PIN>          邮件列表（仅元数据）
GET /api/mails/:id?email=<地址>&epin=<可选PIN>      单封全文
DELETE /api/mails/:id?email=<地址>&epin=<可选PIN>   删除单封
GET /api/health                                     {"ok":true}
```

- 地址域名不在 `DOMAINS` 白名单内 → `403 domain_not_allowed`
- 邮箱格式不对或缺失 → `400 invalid_email`

### 鉴权接口（给程序用）

```
GET /api/latest?email=<地址>[&since=<毫秒时间戳>]
Authorization: Bearer <API_KEY>        或        X-API-Key: <API_KEY>
```

返回该地址**最新一封**邮件的全文（发件人、主题、正文文本/HTML、接收时间）。
`since` 可选：只返回该时刻之后到达的邮件，没有则 `404 no_mail`——适合“发起验证 → 轮询取新码”的场景，不会误取历史邮件。

```bash
curl -H "Authorization: Bearer $API_KEY" \
  "https://<你的Worker>/api/latest?email=me@example.com&since=1764000000000"
```

## 本地开发

```bash
npm run dev            # wrangler dev，本地 D1
npm run db:local       # 初始化本地库表
npm run typecheck      # 类型检查
```

本地调试收信可用 wrangler 的邮件模拟端点，或临时把 `ALLOW_TEST_INJECT` 设为 `1` 后用 `POST /api/test-inject` 注入测试信（字段：`to / from / subject / text / html`）。

## 注意事项

- **Cron 上限**：Cloudflare 免费版每账号最多 5 个 Cron 触发器。若额度已满导致本服务的清理 Cron 加不上，清理会自动降级为“机会式”——每次收信、每次列表查询时顺带执行，效果等同。
- **清理时机**：过期清理（7 天）与存储上限清理都在上述机会式清理与 Cron（若可用）中执行。
- **正文截断**：单封邮件文本正文最多存 200KB、HTML 最多 400KB。

## License

MIT
