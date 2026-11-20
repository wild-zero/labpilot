# LabPilot · 实验自动化平台

面向高校实验教学平台（EduCoder）的作业自动化流水线：登录账号 → 同步课堂 → 安排未完成的必做实验 → 后端逐关求解、保存、评测、修复 → 用户只看进度，搞不定的转人工。

零运行时依赖（只用 Node 内置模块），单进程，SQLite 存储。

**本仓库的 `.env` 已经切到真实头歌（`UPSTREAM=educoder`），直接 `node server/main.mjs` 后登录页填真账号即可。** 想回到离线演示就把 `.env` 里那行改成 `UPSTREAM=mock`——mock 平台接受任意 ≥4 位密码，任务全在本地夹具上跑。

```
node server/main.mjs          # http://127.0.0.1:8080
```

管理员账号 `admin / admin12345`（来自 `.env`，务必改）。`data/` 目录放数据库和日志，删掉就重置。

---

## 1. 目录结构

```
server/
  main.mjs             HTTP 入口：路由表 + 静态资源 + 安全头 + worker 启动
  config.mjs           env / .env 配置（限额、上游、求解器都在这里）
  db.mjs               node:sqlite 建表与访问函数（users/sessions/cards/jobs/audit/bank/failures/tickets）
  crypto.mjs           scrypt 口令、AES-256-GCM 上游凭据、HMAC 会话 Cookie、卡密
  http.mjs             JSON 信封、ApiError、限流、Cookie 解析
  auth.mjs             登录、会话、卡密校验、管理员引导
  routes/
    auth.mjs           /api/auth/*
    courses.mjs        /api/courses/*
    jobs.mjs           /api/jobs/*（含 recover / retry）
    admin.mjs          /api/admin/*（含工单与任务恢复）
    meta.mjs           题库概况 / 今日完成
    tickets.mjs        /api/tickets/*（用户侧反馈工单）
  upstream/
    index.mjs          适配器工厂（mock | educoder）
    mock.mjs           内置夹具平台（带「进度滞后 / 首判不过」这类真实坑）
    educoder.mjs       真实头歌 API：签名头、登录、课程、实训、提交
  engine/
    queue.mjs          抢任务、执行、状态落库、取消、重启恢复
    pipeline.mjs       阶段流水线：preflight → ... → verifying → repairing
    env-level.mjs      环境题分支：挑配方 → 容器内执行 setup → 自检 → 触发测评
    recipes/index.mjs  配方挑选（题干/描述/文件名加权打分，代码题不会被抢走）
    solver/
      index.mjs        题库优先 + 模型兜底 + 答案整形
      mock.mjs         确定性答案（无需模型）
      openai.mjs       任意 OpenAI 兼容 /chat/completions
recipes/
  hive-install.json        装 Hive 3.1.0 + MySQL metastore + 起 Hadoop
  hive-create-table.json   在 Hive 里建表并自检
  hadoop-hdfs-basic.json   起 Hadoop + 建 /usr/output 与 hello.txt
  hadoop-start.json        代码题的前置：先把 HDFS 拉起来
web/
  index.html
  styles.css           界面样式（设计令牌集中定义在 :root，组件按功能分区）
  dist/{app,api,jobs,admin,ui,support}.js   手写 ESM 前端，无框架无打包
scripts/
  smoke.mjs            端到端冒烟：登录→课程→建任务→轮询→后台→鉴权
  tickets-test.mjs     工单 + 任务恢复/重跑的契约测试（17 条断言）
  shot-support.mjs     CDP 截图：后台反馈工单、工单详情、用户端问题反馈
  recipes.mjs          配方体检：列出配方 + 打印某份作业每关会命中哪个
  inspect-ui.mjs       用 Edge/Chrome CDP 真跑一遍 UI 并逐页截图
  extract-aksk.mjs     从平台 bundle 里提取签名常量并自检
  probe-upstream.mjs   真实账号链路诊断（只读：登录/课程/作业/考试/关卡）
  reset-users.mjs      清掉 mock 时期留下的用户与任务，只保留管理员
```

## 2. 后端接口（统一信封与路径约定）

全部返回 `{ data, error: { code, message }, requestId }`，未登录一律 401。

```
POST /api/auth/login      { login, password, access_code? }
GET  /api/auth/config     -> { access_card_required, upstream, solver }
GET  /api/auth/me
POST /api/auth/logout
GET  /api/avatar

GET  /api/courses
GET  /api/courses/{cid}/homeworks
GET  /api/courses/{cid}/exercises
POST /api/courses/{cid}/homeworks/{hwid}/enter

GET  /api/jobs
POST /api/jobs            { mode, scope, course?, homework_id?, game?, exercise_id?, idempotency_key }
GET  /api/jobs/{id}
POST /api/jobs/{id}/cancel
POST /api/jobs/{id}/recover     # 中断/失败/已停止 → 原样重新排队
POST /api/jobs/{id}/retry       # 按原 request 新建一个任务

GET  /api/tickets?limit&cursor&status        # 我的反馈工单（游标分页）
POST /api/tickets        { subject, category, body, idempotency_key }
GET  /api/tickets/{id}
POST /api/tickets/{id}/messages  { body, idempotency_key }
POST /api/tickets/{id}/status    { status: closed|open }

GET  /api/admin/overview
GET  /api/admin/users
GET  /api/admin/jobs
GET  /api/admin/audit
GET  /api/admin/cards
GET  /api/admin/tickets?limit&cursor&status
GET  /api/admin/tickets/{id}
POST /api/admin/tickets/{id}/messages   { body }
POST /api/admin/tickets/{id}/status     { status: open|processing|resolved|closed }
POST /api/admin/jobs/{id}/cancel
POST /api/admin/jobs/{id}/recover
POST /api/admin/jobs/{id}/retry
POST /api/admin/users/{id}/status   { status: active|disabled }
POST /api/admin/cards               { label, reusable }
POST /api/admin/cards/{id}/revoke
```

## 3. 任务模型

```jsonc
// job.request
{
  "mode":  "submit" | "selftest" | "generate_only" | "collect_verified",
  "scope": "all" | "course" | "homework" | "current" | "exercise",
  "course": "课堂 identifier",      // scope != all 时必填
  "homework_id": 101,               // scope = homework | current
  "game": "关卡 id",                 // scope = current
  "exercise_id": 9001               // scope = exercise
}
```

- `submit`：真正去做题并提交。
- `collect_verified`：只读题库采集，把已验证的答案写进 `bank` 表，后续题目命中就直接复用（省模型调用）。
- 同目标只保留一个当前安排：`targetOf(request)` 相同且仍在排队的请求直接返回既有 job；带 `idempotency_key` 的重复请求返回同一个 job。

## 4. 流水线

```
queued
 └─ running
     starting → preflight → loading → collecting
       └─ 每关：bank_lookup（题库）→ generating（模型）→ saving → selftesting
                → submitting → evaluating → polling → verifying
                （判负则 repairing，重来，最多 LIMIT_ATTEMPTS 次）
     → completed
```

### 4.1 题库优先

每关的顺序是**先查库、再问模型、做对才入库**：

1. 进入关卡后先读一次题目（这一步拿到的文件就是「原始模板」），用 `sha256(kind + 题干 + 描述 + 选项 + 模板文件内容)` 算出题库键。
2. `bank_lookup`：命中就直接用那条答案去提交，**不调用模型**（零 token）。
3. 没命中才 `generating`：把题干、模板文件、判分测试集的期望/实际输出一起给模型。
4. 评测通过后 `remember(key, 模板, 答案)` 写回题库；题库命中的不重复写。
5. 没通过就带着「期望输出 vs 实际输出」进 `repairing`，下一轮重新问模型，最多 `LIMIT_ATTEMPTS` 次。

键用的是**原始模板**而不是改过之后的文件，否则每修一次内容就变、永远命中不了。反过来也一样：只要同一道题再次以同样的模板出现（重置关卡、换账号、同一份作业重跑），就会命中。

- 「已完成」判定只认平台侧 `game.status === 2`；`finished_challenge_count` 会滞后，不信它。
- 判不出来（评测没结果、回读对不上、题卷变了）**绝不标成功**：抛 `Support(code)`，job 落成 `succeeded + result.service_status = 'support'`，进后台「需要跟进」队列。这是整个系统的设计核心。
- 取消：`cancel_requested` 每个阶段边界检查一次，抛 `Canceled` → `canceled`。
- 时间上限：`LIMIT_JOB_MINUTES`（采集用 `LIMIT_COLLECT_MINUTES`）→ `failed / time_limit`。
- 进程重启：启动时把 `running/waiting/processing` 的任务标成 `interrupted / service_restarted`，不假装成功。

## 5. 接入真实的 EduCoder 账号

`.env` 里已经是 `UPSTREAM=educoder`，正常情况下只需要跑服务。换机器或换账号时按这个顺序来：

```bash
# 1) 确认签名常量还有效（平台换版本会轮换；顺带自检请求会被接受）
node scripts/extract-aksk.mjs

# 2) 用真账号体检整条链路（只读，不保存不提交）
node scripts/probe-upstream.mjs 你的手机号或邮箱 你的密码

# 3) 开服务，登录页直接填头歌账号密码
node server/main.mjs
```

`probe-upstream.mjs` 会依次打印：签名自检结果、登录会话（uid / zzud / cookie 长度）、课程列表、第一门课的作业与考试、进入实训的 entry、第一个关卡的题目结构。哪一步红了就修哪一步，不用靠猜。

然后开服务，登录页直接用头歌账号密码登录即可：

```bash
node server/main.mjs     # 或 PORT=8080 UPSTREAM=educoder node server/main.mjs
```

已实测的两点：签名头被平台接受（错误账号返回 `status:-3` 而不是 `-102`），以及我们服务端的登录接口把 `-3` 正确映射成 `AUTH_FAILED`。课程 / 作业 / 考试 / 关卡读取按平台实测契约实现，但需要你的真实账号才能验证到最后一步——所以才有 `probe-upstream.mjs`。

平台契约（已实测）在 `server/upstream/educoder.mjs` 顶部的注释里，要点：

| 项 | 值 |
| --- | --- |
| Base | `https://data.educoder.net/api` |
| 签名 | `md5(base64("method=<大写>&ak=<AK>&sk=<SK>&time=<ms>"))` |
| 头 | `X-EDU-Type: pc`、`X-EDU-Timestamp`、`X-EDU-Signature`、`Pc-Authorization: <_educoder_session>` |
| 登录 | `POST /accounts/login.json`，额外要 `Origin` / `Referer`，`Pc-Authorization: null` |
| 课程 | `GET /courses.json?page=1&limit=100&order=mine&search=&zzud=` |
| 作业 | `GET /courses/{identifier}/homework_commons/list.json?limit=200&zzud=` |
| 考试 | `GET /v2/courses/{identifier}/exercises.json?limit=100&zzud=` |
| 进入实训 | `GET /shixuns/{shixun_identifier}/shixun_exec.json?homework_common_id={hw}&zzud=` → 只回 `game_identifier` |
| 关卡 | `GET /tasks/{game_identifier}.json?homework_common_id={hw}&zzud=` |
| 读文件 | `GET /tasks/{game_identifier}/rep_content.json?path={path}&homework_common_id={hw}` → `content.content` 是 **base64** |
| 写文件 | `POST /myshixuns/{myshixun_identifier}/update_file.json`，`content` 要 **明文**，返回 `content.commitID` |
| 触发评测 | `POST /tasks/{game_identifier}/game_build.json`，body 带 `shixun_environment_id` 与 `extras.commitID` |
| 状态码 | `-102` 签名被拒、`-3` 账号密码错、`-4` 未绑定手机/邮箱、HTTP 429 限流 |

字段名和文档不一样的地方（踩过的坑，适配器里已处理）：

- 作业主键是 `homework_id`，不是 `id`；`homework_commons.json` 的 `status` 是数组，`list.json` 是字符串。
- 关卡 id 在 `shixun_exec.json` 里叫 `game_identifier`，没有 `entry_game_id`。
- 题干在 `challenge.task_pass`；`challenge.path` 可能是多个文件用全角 `；` 连接。
- 是否代码题看 `challenge.with_code_file`；环境 id 在 `code_editor.shixun_environment_id`。
- `game.status === 2` 才算完成；`test_sets[].result` 在评测进行中是 `null`。
- 读文件回 **base64**、写文件吃 **明文**——写反了会把 base64 串存进用户的代码文件。
- 保存代码的 URL 里是 `myshixun_identifier`，body 里的 `game_id` 是游戏的**数字** id；传字符串会得到 `{"status":-1,"message":"game_id为空"}`。

AK/SK 是平台 web bundle 里公开的客户端常量（模块 `527951`，双 base64 编码）；`scripts/extract-aksk.mjs` 会流式扫描 bundle 取出并验签（拿到 `status:-3` 即说明签名有效）。

会话存的是加密后的 `{ cookie, trustie, zzud, uid }`：`zzud` 是平台课程接口要的账号维度参数，登录响应或 cookie 里带就直接用，不带就用 `current_user` 系列接口兜底取。

### 5.1 配置模型 Key

只改 `.env` 里两行：`SOLVER=openai` 和 `OPENAI_API_KEY=你的key`。换平台只动 `OPENAI_BASE_URL` 和 `OPENAI_MODEL`。

| 平台 | OPENAI_BASE_URL | OPENAI_MODEL |
| --- | --- | --- |
| DeepSeek（默认，国内直连） | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 阿里百炼 | `https://dashscope.aliyuncs.com/compatible-mode/v1` | `qwen-plus` |
| 月之暗面 | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| 本地 Ollama | `http://127.0.0.1:11434/v1` | `qwen2.5-coder:7b` |
| OpenAI | `https://api.openai.com/v1` | `gpt-4o-mini`（国内需代理） |

改完先验一遍，不用开网页：

```bash
node scripts/check-model.mjs            # 验密钥 + 拿一道真题目试解（只读）
node scripts/check-model.mjs 操作系统    # 指定课程
```

它会依次报：配置回显（key 打码）→ 鉴权结果（401/404/429 都有针对性提示）→ 真实关卡的生成结果。全绿再往下走。代码题答案要模型出时再配 `SOLVER=openai` + `OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL`（任何 OpenAI 兼容端点都行）。

## 6. 验证

```bash
node scripts/smoke.mjs        # 全链路冒烟（含幂等、鉴权、题库、考试、管理后台）
node scripts/tickets-test.mjs  # 工单 + 任务恢复/重跑的契约测试（17 条断言）
node scripts/shot-support.mjs  # CDP 截图：后台反馈工单、工单详情、用户端问题反馈
node scripts/recipes.mjs 5m9itqyf 4293815   # 配方体检：某份作业每关会命中哪个环境配方
node scripts/inspect-ui.mjs   # 真浏览器跑界面并输出 shots/*.png
node scripts/probe-session.mjs 账号  # 用已登录的会话只读探测真实接口并打印原话
node scripts/try-one.mjs 课程名      # 单关卡干跑：读题 → 求解 → 展示将要提交的内容
node scripts/try-one.mjs 课程名 --yes  # 真交这一关（会写你的账号）
```

`smoke.mjs` 的期望输出要点：3 份作业 / 7 个关卡全部 `completed`，题库新增选择题答案，重复建任务返回同一个 job，未登录访问 401。

## 7. 配置项

见 `.env.example`，常用：

| 变量 | 作用 |
| --- | --- |
| `UPSTREAM` | `mock` / `educoder` |
| `SOLVER` | `mock` / `openai` |
| `ACCESS_CARD_REQUIRED` | 登录是否强制卡密 |
| `SESSION_SECRET` / `ENCRYPTION_KEY` | 生产必须显式设置，否则重启掉线 |
| `WORKER_CONCURRENCY` | 并发任务数 |
| `LIMIT_ATTEMPTS` | 单关修复次数上限 |
| `LIMIT_JOB_MINUTES` | 单批任务时间上限 |
| `RATE_LOGIN_MAX` | 同 IP 同账号登录频率 |

## 8. 安全与边界

- 上游 Cookie 用 AES-256-GCM 加密落库；头歌密码不落库，只在登录瞬间用于换会话。
- 卡密只存 `sha256`，明文仅在创建响应里出现一次，一次性使用。
- 会话是 HMAC 签名 Cookie（HttpOnly / SameSite=Lax）；生产加 `PUBLIC_ORIGIN=https://...` 会自动上 `Secure`。
- 响应头：`X-Frame-Options: DENY`、`CSP frame-ancestors 'none'`、`nosniff`、`no-referrer`、HSTS。
- 前端所有插值走 `escapeHtml`；考试外链做 hostname + path 白名单防开放跳转。

## 9. 已知取舍

- 单进程 worker + SQLite：够单机；要横向扩就把 `jobs.claimNext()` 换成 `SELECT ... FOR UPDATE SKIP LOCKED` 或外部队列。
- 没实现多文件作业（`unsupported_multifile`）、也没实现选做题；这两块在真实的 token/成本模型下需要单独设计。
- `scope: current`（单关重跑）接口与校验已就绪，pipeline 里走的是批量路径，单关重跑可按同样结构补一个分支。
- 单进程 + SQLite 只适合单机；界面无构建链（手写 ESM），改完刷新即生效，换来的是没有类型检查与打包优化。
