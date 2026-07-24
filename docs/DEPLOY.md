# 部署清单

## 1. Web（Vercel）

必需环境变量：

```
DATABASE_URL=postgresql://...        # Neon 连接串
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-2.5-flash
ADMIN_API_KEY=...                    # 管理后台与运维面板
```

推送代码后 Vercel 自动部署。**每次有新迁移时**在本地执行：

```bash
DATABASE_URL='你的连接串' npm run db:init
```

## 2. Worker（常驻进程，必需）

Web 只负责入队，**任务由 Worker 执行**。未部署 Worker 时任务会一直排队。

在能连到同一个数据库的机器上：

```bash
cd nuedc-agent && npm ci
DATABASE_URL='同一个连接串' \
GEMINI_API_KEY='...' \
pm2 start npm --name nuedc-worker -- run worker
pm2 logs nuedc-worker
```

看到 `启动：重型槽位 2 · 轻型槽位 6` 即正常。

可调参数：

```
WORKER_HEAVY_SLOTS=2      # 重型任务并发（方案/代码/报告）
WORKER_LIGHT_SLOTS=6      # 轻型任务并发
WORKER_POLL_MS=1500       # 空闲轮询间隔
```

**降级方案**：Worker 未就绪时可设 `ALLOW_INLINE_EXECUTE=1`，
退回前端点火的同步执行模式（不推荐用于比赛当天）。

## 3. 健康检查

| 端点 | 用途 | 鉴权 |
|---|---|---|
| `/api/health` | 存活探针，只答进程是否在跑 | 公开 |
| `/api/ready` | 就绪探针，检查数据库/迁移/模型链路 | 公开（详情需 admin） |
| `/api/routing-preview` | 当前选路与 mock 状态，零 token 消耗 | 公开 |

## 4. 压测

**先确认服务端处于 mock 模式**，否则会产生真实费用：

```bash
curl https://你的域名/api/routing-preview   # 确认 mock_enabled: true
BASE_URL=https://你的域名 ALLOW_MOCK_ASSUMED=1 npm run load-test -- --users 100 --ramp 20
```

只验队列链路（不调模型、几分钟完成）：

```bash
LOAD_MODE=queue-only LOAD_USERS=15 BASE_URL=... npm run load-test
```

## 5. 上线前必测

1. **并发隔离**：两个浏览器同时生成方案，在 `/admin/model-operations` 确认用量分别记到各自项目
2. **Worker 崩溃自愈**：`pm2 stop nuedc-worker` 杀掉正在跑的任务，90 秒后重启，任务应自动重新入队
3. **降级不白屏**：临时把 `SYSTEM_MODE=RULES_ONLY` 部署一次，确认页面提示清晰且项目编辑仍可用
