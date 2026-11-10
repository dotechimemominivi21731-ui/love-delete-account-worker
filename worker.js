// 我们的爱情 - 真注销后端 (Cloudflare Worker) v10
// 作用:
//   POST /delete-account  app 点"注销账号"时, 先由 Worker 删掉环信服务器上的账号, 再由 app 清本地数据。
//   POST /stats           管理员工具查用户统计: 已注册多少用户 / 还剩多少名额 (环信免费测试版上限 100)。
//   POST /admin-delete    管理员帮别人删号: 管理员不需要被删账号的密码, 凭管理员密钥删号。
//   POST /level/*         情侣等级/经验/签到/邮件改由服务器说了算 (v10.0)，
//                         等级记录存在 Durable Object 里（每用户单写者，v7）：
//     /level/checkin          每日签到 +4 XP (服务器日期说了算, 改手机时间刷不了)
//     /level/add-xp           发消息 +2 XP (每天最多 4 条, 1:1 和大厅共用计数, 须双向绑定)
//     /level/claim-mail       领邮件 (服务器判重, 同一封只能领一次)
//     /level/send-mail        管理员发邮件 (服务器验管理员身份, 再调环信发消息)
//     /level/send-announcement 管理员发公告 (服务器验管理员身份 + 60 秒去重)
//     /level/get-couple       查情侣状态 (双向绑定校验, 未绑定/单向绑定自动自愈)
//     /level/get-other        查别人的等级 (只读, 供好友行徽章用, v6 新增)
//     /level/migrate          首次把手机 EXT 里的等级快照迁到服务器 (v10: 服务端封顶+白名单+验 bound, 不再信任快照)
//     /level/bind             绑定 (v10: 验对方存在、不覆盖已有绑定、换绑先清旧伴侣回指)
//     /level/unbind           解绑 (等级清零, 特殊称号保留; 未绑定时直接报 ok:false, 不动经验)
//   level 接口一律 POST JSON { username, password, ... }，密码用环信登录校验；
//   路径可带 /level 前缀也可不带（代理会去掉前缀再转发，两种都认）。
// Client Secret 只存在 Worker 的 Secrets 里, 绝不放进 app。
//
// ⚠️ 环信 REST 域名按数据中心区分: 我们的应用在国内 2 区, REST 地址是
// ngi-a1.easemob.com, 不是默认的 a1.easemob.com(国内 1 区)。
// 2026-11-07 实测: a1 对这个 AppKey 报 organization_application_not_found,
// ngi-a1 注册和 password 登录都正常。写错域名会导致所有校验都 403。
// 官方文档: https://doc.easemob.com/product/data_center.html
//
// ⚠️ 部署安全红线: 这个 Worker 绝不能用 API 上传脚本的方式部署——
// API 上传的 metadata 里声明 secret 绑定必须带 secret 的值 (error 10021),
// 而 Client Secret 的值只存在 Worker secret 里、谁也不知道, 写不上;
// 不声明 bindings 又会把已有的 4 个 secret 全删掉。2026-11-08 已用一次
// 性测试 Worker 实测确认: 带 bindings 声明重部署报 10021, 行不通。
// 部署走 GitHub 自动部署: 仓库 love-delete-account-worker (main 分支)，
// Cloudflare 上已接好 Git 连接，推 main 就自动部署；Git 部署会保留
// Secrets（2026-11-10 实测），KV 绑定以 wrangler.toml 为准——
// 想加绑定必须写进 wrangler.toml，Dashboard 上单独绑的会被下次部署删掉。
// 新加的 ADMIN_KEY 也要在 Dashboard > Settings > Variables 里新建一个
// Secret (值就是邀请码 Worker 的那个管理密钥), 不要写进代码。
// ADMIN_KEY 轮换 (v10, 2026-11-10): 邀请码 Worker 的 ADMIN_KEY 明文曾写在
// deploy_invite.py 里, 已改走环境变量并轮换；删除 Worker 的 ADMIN_KEY 须与
// 邀请码 Worker 保持同一个值, 轮换时两边一起换 (单个 secret PUT 接口)。
//
// v10 (2026-11-10) 审计 v10.4-full 的 Worker 27 条全修 (早于 v10 的历史见 git):
//   W-C1: 请求体为 null/数组/非对象时返回 JSON 400 (原来读属性抛错 → 非 JSON 500);
//         主 fetch 外层加 try/catch, 未捕获异常也返回 JSON 500。
//   W-C2: handleLevelRequest 包一层 try/catch, DO 调用失败返回 JSON 500。
//   W-B1: /level/migrate 不再信任客户端快照——经验上限 = 12×(服务器今天-2025-10-17
//         的天数)+已登记的邮件经验总和+10000 (一次性补登旧版无登记邮件的宽限),
//         超上限直接拒绝本次迁移；称号只接受等级称号 (封顶后经验对应的等级及以下
//         的 LV.1–18 称号) 或邮件登记表里的称号, 其余丢弃；bound 只有对方经 Easemob
//         查确实存在、且对方服务器记录里 bound 等于我或对方尚无服务器记录时才接受,
//         否则丢弃快照的 bound；客户端传的 updatedAt 不再参与任何排序/取大, 用服务器时间。
//   W-B2: /level/send-mail 只认服务端自己定的公告群——用 app token 按名字
//         “我们的爱情-系统公告”查群, 调用者必须是那个群的群主才算管理员；
//         邮件发到服务端查到的那个群 id (客户端传的 group_id 忽略)；scope 为 one
//         时收件人必须存在且不能是自己；公告群找不到时返回明确错误, 不在服务端建群。
//         建群权限结论: Easemob 文档未写明普通用户能否建群, 但本应用的“用户大厅”与
//         公告群本身就是普通用户账号经 SDK 建的, 故普通用户能建群是事实——只认群主
//         不限定群就是真漏洞, 按上面修掉。
//   W-B3: /level/unbind 未绑定时直接返回 ok:false, 不清零经验。
//   W-B4: /delete-account token 路径加二次核对: GET 成功后比对返回体里的用户名
//         必须等于要删的用户名, 不等就拒绝；同时传 token+密码时 token 失败回退到
//         密码校验, 不再直接 403。文档结论: Easemob 官方文档未明确写明“用户 token
//         GET 他人资料是否 403”(只写了 RBAC 模型与 app token/用户 token 的区分),
//         未证实为 403, 按最坏假设修 (二次核对)。
//   W-B5: send-mail 幂等与公告去重的查+写放进 MailGate Durable Object 原子完成
//         (reserve/confirm/release)；公告改成先发环信消息、成功后再记去重键,
//         发送失败释放预留, 60 秒内可重试。
//   W-B6: /level/bind 验对方存在 (Easemob 查)；调用者已绑定别人时先解掉旧绑定
//         (清旧伴侣回指)；对方已绑定别人时拒绝；不静默覆盖。
//   W-B7/W-M11/W-M12: 见邀请码 Worker (set-status/delete、generate/create-custom
//         走 InviteClaim DO 串行化；认领成功后清理 claim 记录；consume 拒绝空 username)。
//   W-M1: 双向绑定校验放进 LevelStore DO 内 (加分前一刻再验一次对方回指),
//         且 add-xp 返回前重读伴侣最新记录算 totalXp。
//   W-M2: 解绑做成尽力原子 (对方回指清理失败靠 get-couple 自愈兜底)；
//         设计: 解绑只清发起方经验、对方保留全部经验 (见 unbind 处理里的注释)。
//   W-M3: 真正的日期校验 (月份天数、闰年), 不再只靠 Date.parse 归一化。
//   W-M4: 忽略 body.today, 用服务器日期, 不再 400。
//   W-M5: get-other/bind 用户名正则与 Easemob 真实规则对齐
//         (^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$, 不再拒数字开头的合法名)。
//   W-M6: send-mail 验收件人存在；claim-mail 里 mail.to 缺失时拒绝领取；note 限长 200 字。
//   W-M7: 基础限流 (/stats 猜 key、level 密码校验、删号密码校验做每 key/IP 计数限流，
//         进程内 Map 简易实现)。
//   W-M8: 不再原样回显上游错误体, 返回通用文案 (细节只记日志)；CORS 收紧到已知来源。
//   W-M9: /stats 分页拉全量用户再计总数。
//   W-P1/W-P2: 邀请码 /list 注释改成 POST；删掉形如真实 org/app 的注释示例值。
//   W-P3: 统一错误语义：凭证错才 403, 上游不可用返回 JSON 500 并保留日志细节。
//   W-P4: send-mail 与公告统一成“先发后记键”并补失败回滚 (见 W-B5)。
//   补充项 S1/S2 (v10.5 配套, 只加字段不改行为): checkin “今天已经签到过了”
//     失败回包加服务器日期 date；claim-mail “已经领过了”失败回包加
//     code:"already_claimed"。
//
// 需要在 Worker 里配置的 Secrets (Dashboard > Settings > Variables):
//   EASEMOB_ORG           环信控制台里的 org 编号
//   EASEMOB_APP           应用名
//   EASEMOB_CLIENT_ID     环信控制台 > 应用详情 > Client ID
//   EASEMOB_CLIENT_SECRET 环信控制台 > 应用详情 > Client Secret
//   ADMIN_KEY             管理员密钥 (和邀请码 Worker 的 ADMIN_KEY 同一个值)
//
// 还要在 Dashboard > Settings > Variables 里加一个 KV Namespace Binding:
//   变量名 IDEM_KV，命名空间 love-delete-idem (id bbca085bcb564bf3a57375b373f7c524)。
//   没绑 IDEM_KV 也能跑（删号逻辑不变），只是幂等缓存不生效。
// 再加一个 KV Namespace Binding（v4 等级数据用）：
//   变量名 LEVEL_KV，命名空间 love-level (id 2d8f6cb816814df89742dd407b8ca074)。
//   没绑 LEVEL_KV 时 /level/* 一律报 500，删号/统计/管理员删号不受影响。
// 再加两个 Durable Object 绑定（见 wrangler.toml）：
//   LEVEL_STORE (LevelStore, 每用户单写者, v7)；MAIL_GATE (MailGate, 全局单实例,
//   发邮件幂等 + 公告去重, v10)。
//
// 接口: POST /delete-account (幂等：删成功后 10 分钟内重试直接返回成功)
//   Body JSON: { "username": "zhaorui", "userToken": "<登录后拿到的用户 token>" }
//   或:        { "username": "zhaorui", "password": "<账号密码>" } (没有 token 时用密码校验)
//   返回: { "ok": true } 或 { "ok": false, "error": "原因" }
// 接口: POST /stats
//   Body JSON: { "admin_key": "<管理员密钥>" }
//   返回: { "ok": true, "total": 2, "limit": 100, "remaining": 98 }
// 接口: POST /admin-delete (幂等，同上)
//   Body JSON: { "admin_key": "<管理员密钥>", "username": "<要删的用户名>" }
//   返回: { "ok": true, "deleted": "<用户名>" } 或 { "ok": false, "error": "原因" }
// 接口: POST /level/* (v5，见文件头；一律带 { username, password }，路径可带 /level 前缀也可不带)

const BASE = (env) => `https://ngi-a1.easemob.com/${env.EASEMOB_ORG}/${env.EASEMOB_APP}`;
// 环信免费测试版上限 100 个注册账号 (2026-11-07 控制台查到已注册 2 个, 剩 98 个)。
const USER_LIMIT = 100;
// v10 W-M8: CORS 只放行已知来源 (app 是原生应用、代理是服务端, 本来就不带 Origin;
// 带 Origin 的浏览器调用只认下面这两个)。不在表里的 Origin 不发 CORS 头 (浏览器会拦)。
const ALLOWED_ORIGINS = [
  "https://womendeaiqing.cc.cd",
  "https://3000-agq3t3mh6jzq2rqwlfbjtgx3iq.instabox.tech",
];
const ANNOUNCE_GROUP_NAME = "我们的爱情-系统公告";

// 上游 (环信) 不可用时抛这个错, 调用方统一转 JSON 500 (W-P3: 凭证错才 403)。
class UpstreamError extends Error {
  constructor(message) {
    super(message);
    this.upstream = true;
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------- v10 W-M7: 基础限流 (进程内计数, 简易实现, 够挡在线试探) ----------
// key → { count, resetAt }；窗口内超限返回 false。Worker 隔离重启后计数清零，
// 属尽力而为的限流，不做跨实例强一致。
const RATE_BUCKETS = new Map();
function rateLimitOk(key, limit, windowMs) {
  const now = Date.now();
  const b = RATE_BUCKETS.get(key);
  if (!b || now >= b.resetAt) {
    RATE_BUCKETS.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (b.count >= limit) return false;
  b.count += 1;
  return true;
}
// 偶尔清理过期桶，避免 Map 无限长。
function rateLimitPrune() {
  if (RATE_BUCKETS.size < 1000) return;
  const now = Date.now();
  for (const [k, b] of RATE_BUCKETS) {
    if (now >= b.resetAt) RATE_BUCKETS.delete(k);
  }
}

function clientIp(request) {
  const cf = request.headers.get("CF-Connecting-IP");
  if (cf) return cf.trim();
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return "unknown";
}

function corsHeadersFor(request) {
  const origin = request.headers.get("Origin") || "";
  if (ALLOWED_ORIGINS.indexOf(origin) !== -1) {
    return { "Access-Control-Allow-Origin": origin, "Vary": "Origin" };
  }
  return {};
}

// 在出口处补 CORS 头 (json() 本身不再带 Access-Control-Allow-Origin: *)。
function withCors(res, request) {
  const h = corsHeadersFor(request);
  if (Object.keys(h).length === 0) return res;
  const nh = new Headers(res.headers);
  for (const [k, v] of Object.entries(h)) nh.set(k, v);
  return new Response(res.body, { status: res.status, headers: nh });
}

// v10 W-C1: 请求体必须是 JSON 对象 (null/数组/字符串/数字都算坏请求)。
async function parseJsonBody(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return body;
}

// 拿应用级 token (client_credentials, 用 Client ID + Client Secret)
// v10 W-M8/W-P3: 上游错误体只记日志，不回显给调用方。
async function getAppToken(env) {
  let r;
  try {
    r = await fetch(`${BASE(env)}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: env.EASEMOB_CLIENT_ID,
        client_secret: env.EASEMOB_CLIENT_SECRET,
      }),
    });
  } catch (e) {
    console.error("拿应用 token 失败: 网络异常", e);
    throw new UpstreamError("环信服务暂时不可用");
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("拿应用 token 失败: HTTP " + r.status + " " + t.slice(0, 200));
    if (r.status >= 500) throw new UpstreamError("环信服务暂时不可用");
    throw new Error("拿应用 token 失败");
  }
  const j = await r.json();
  return j.access_token;
}

// 从 GET /users/{username} 的返回体里取用户名。环信返回形状不固定：
// {entities:[{username}]} 或 {data:{username}} / {data:[{username}]} / {username}。
function extractUsernameFromProfile(j) {
  if (!j || typeof j !== "object") return "";
  if (Array.isArray(j.entities) && j.entities[0] && typeof j.entities[0].username === "string") {
    return j.entities[0].username;
  }
  if (j.data && typeof j.data === "object") {
    if (Array.isArray(j.data) && j.data[0] && typeof j.data[0].username === "string") return j.data[0].username;
    if (typeof j.data.username === "string") return j.data.username;
  }
  if (typeof j.username === "string") return j.username;
  return "";
}

// v10 W-B4: 用用户 token 调 GET /users/{username}，再二次核对返回体里的用户名
// 必须等于要校验的用户名。返回 { ok } / { ok:false, reason:"invalid"|"mismatch" }。
// 上游 5xx/网络异常抛 UpstreamError (不按“身份不对”处理)。
// 文档结论：Easemob 官方文档只写了 RBAC 模型与 app token/用户 token 的区分，
// 未明确写明“用户 token GET 他人资料是否 403”，所以不依赖该假设，必须二次核对。
async function verifyUserTokenOwner(env, username, userToken) {
  let r;
  try {
    r = await fetch(`${BASE(env)}/users/${encodeURIComponent(username)}`, {
      headers: { Authorization: "Bearer " + userToken },
    });
  } catch (e) {
    console.error("用户 token 校验失败: 网络异常", e);
    throw new UpstreamError("环信校验服务暂时不可用");
  }
  if (!r.ok) {
    if (r.status >= 500) throw new UpstreamError("环信校验服务暂时不可用");
    return { ok: false, reason: "invalid" };
  }
  let j = null;
  try {
    j = await r.json();
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const name = extractUsernameFromProfile(j);
  if (!name) return { ok: false, reason: "invalid" }; // 认不出归属就按不是本人处理 (fail closed)
  if (name !== username) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

// 密码校验：密码登录一次。错密码返回 false；上游 5xx/网络异常抛 UpstreamError。
async function verifyPassword(env, username, password) {
  let r;
  try {
    r = await fetch(`${BASE(env)}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "password", username, password }),
    });
  } catch (e) {
    console.error("密码校验失败: 网络异常", e);
    throw new UpstreamError("环信校验服务暂时不可用");
  }
  if (!r.ok) {
    if (r.status >= 500) throw new UpstreamError("环信校验服务暂时不可用");
    return false;
  }
  return true;
}

// 校验"请求的人就是这个账号本人" (删号用)。
// v10 W-B4: token 路径先二次核对归属；token 无效/不属于该用户/过期时，
// 若同时给了密码，回退到密码校验——只有两者都失败才拒绝。
async function verifyOwner(env, username, userToken, password) {
  if (userToken) {
    const t = await verifyUserTokenOwner(env, username, userToken);
    if (t.ok) return true;
    // token 失败 (invalid/mismatch)：往下试密码；上游异常时上面已抛错，不会走到这里。
  }
  if (password) return await verifyPassword(env, username, password);
  return false;
}

// 管理员密钥校验: 没配 ADMIN_KEY 就一律拒绝 (fail closed), 对不上也拒绝。
function verifyAdminKey(env, body) {
  if (!env.ADMIN_KEY) return false;
  const key = (body.admin_key || "").trim();
  return key !== "" && key === env.ADMIN_KEY;
}

function requireEasemobSecrets(env) {
  return env.EASEMOB_ORG && env.EASEMOB_APP && env.EASEMOB_CLIENT_ID && env.EASEMOB_CLIENT_SECRET;
}

// M10 删号幂等：KV 结果缓存（IDEM_KV，命名空间 love-delete-idem）。
// 场景：app 发起删号，服务器删成功了，但网络断了，app 不知道成功没、
// 重试一次。没有幂等的话第二次删会报“用户不存在”，app 以为删号失败。
// 做法：删成功后把结果写进 KV（key 是用户名，10 分钟过期）；
// 重试时先查缓存——缓存命中且环信那边查不到这个用户了（确实删掉了），
// 就直接返回上次的成功结果；如果用户还在（比如同名新账号），
// 就走正常流程重新删。失败的结果不缓存，重试会重新走流程。
const IDEM_TTL_SECONDS = 600;

async function idemGet(env, kind, username) {
  if (!env.IDEM_KV) return null;
  try {
    const raw = await env.IDEM_KV.get(kind + ":" + username);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch { return null; }
}

async function idemPut(env, kind, username, result) {
  if (!env.IDEM_KV) return;
  try {
    await env.IDEM_KV.put(kind + ":" + username, JSON.stringify(result), { expirationTtl: IDEM_TTL_SECONDS });
  } catch { /* 缓存写失败不影响删号本身 */ }
}

// 查环信上这个用户还在不在（app token 调 GET /users/{username}）。
async function userExists(env, appToken, username) {
  let r;
  try {
    r = await fetch(`${BASE(env)}/users/${encodeURIComponent(username)}`, {
      headers: { Authorization: "Bearer " + appToken },
    });
  } catch (e) {
    console.error("查用户存在性失败: 网络异常", e);
    throw new UpstreamError("环信服务暂时不可用");
  }
  if (r.status >= 500) throw new UpstreamError("环信服务暂时不可用");
  return r.ok;
}

// 幂等复核：缓存命中且用户已不在环信上，返回上次的成功结果；
// 用户还在或查不到缓存时返回 null，调用方走正常流程。
async function idemReplay(env, kind, username) {
  const cached = await idemGet(env, kind, username);
  if (!cached || !cached.ok) return null;
  try {
    const appToken = await getAppToken(env);
    if (!(await userExists(env, appToken, username))) {
      return { ok: true, deleted: username, replayed: true };
    }
  } catch { /* 查存在性失败时走正常流程，不直接报错 */ }
  return null;
}

// ================= v4: 情侣等级/经验/签到/邮件（服务器说了算） =================
// KV 模型（love-level，变量名 LEVEL_KV）——v7 起等级记录 u: 不再是账本：
//   u:<username> → DO（LevelStore）的写回镜像 + 首次访问的懒迁移来源；
//     账本在 DO 存储里（SQLite），每用户一个 DO 实例单写者。
//   mail:<mail_id> → { kind, amount|title, scope, to, from, createdAt }（v5：发邮件登记，领邮件时验真；不设过期，管理员发的邮件量很小）
//   idem-mail:/ann: 键 v10 起不再用 KV：幂等与去重改走 MailGate DO（见下），
//     旧 KV 键自然过期，无需迁移。
// 等级记录的字段（DO 里的形状，和原来 KV 里的一样）：
//   { bound, xp, ck, msgd, msgc, stitles[], cmail[]（最近 1000 个）, dtitle, updatedAt }
// 等级曲线和称号表和 app 里 CoupleLevel 一模一样：
//   LV.n 升 LV.n+1 要 100+(n-1)*20 XP；升到 LV.L 总共要 10*(L-1)*(L+8) XP；最高 18 级。
const LEVEL_TITLES = [
  "萌新情侣", "小鹿乱撞", "甜甜蜜蜜", "如胶似漆", "难舍难分",
  "心心相印", "海誓山盟", "白头偕老", "钻石情侣", "神仙眷侣",
  "天生一对", "佳偶天成", "琴瑟和鸣", "鸾凤和鸣", "相濡以沫",
  "举案齐眉", "地久天长", "永结同心",
];
const LEVEL_MAX = 18;
const LEVEL_CHECKIN_XP = 4;
const LEVEL_MESSAGE_XP = 2;
const LEVEL_MESSAGE_DAILY_MAX = 4;
const LEVEL_MAX_MAIL_XP = 10000;
const LEVEL_MAX_TITLE_LEN = 20;
const LEVEL_MAX_CLAIMED_MAIL_IDS = 1000;
const LEVEL_MAX_STITLES = 50; // v10 W-M13: 特殊称号最多 50 个，防止 DO 记录无限膨胀
const MIGRATE_BASE_DATE = "2025-10-17"; // v10 W-B1: 经验上限的起算日（两人真正在一起的日子）
const MIGRATE_LEGACY_XP_ALLOWANCE = 10000; // v10 W-B1: 一次性补登旧版无登记邮件的宽限
const NOTE_MAX_LEN = 200; // v10 W-M6: 邮件备注最多 200 字

function levelCumXp(level) {
  if (level <= 1) return 0;
  return 10 * (level - 1) * (level + 8);
}

function levelForXp(xp) {
  if (xp <= 0) return 1;
  let level = 1;
  while (level < LEVEL_MAX && xp >= levelCumXp(level + 1)) level++;
  return level;
}

function levelTitleFor(level) {
  if (level < 1 || level > LEVEL_TITLES.length) return "";
  return LEVEL_TITLES[level - 1];
}

// 服务器今天的日期（v5：固定按 Asia/Shanghai 算，不再信任客户端传的 tz。
// M-15：改过客户端轮换 tz（如 UTC+14 与 UTC-12）可在同一自然日拿到两个
// 服务器日期，多签一次到；用户在中国，app 的 tz 本来就是上海，固定上海无影响）。
function serverDateInTz() {
  try {
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    return fmt.format(new Date());
  } catch {
    return null;
  }
}

// v10 W-M3: 真正的日历日期校验——月份天数 + 闰年。
// 旧版只验正则 + Date.parse，"2026-02-30"、"2026-02-29"（2026 非闰年）
// 都会被 Date.parse 归一化进 3 月而放行。
function isValidDateStr(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const y = Number(s.slice(0, 4));
  const m = Number(s.slice(5, 7));
  const d = Number(s.slice(8, 10));
  if (m < 1 || m > 12 || d < 1) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= daysInMonth;
}

// "YYYY-MM-DD" 之间的天数 (b - a)，v10 W-B1 迁移上限用。
function daysBetween(a, b) {
  const pa = a.split("-").map(Number);
  const pb = b.split("-").map(Number);
  return Math.floor(
    (Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000
  );
}

// v10 W-M5: 用户名正则与 Easemob 真实规则对齐——首字符可以是数字，
// 大小写字母/数字/下划线/横线，1–64 位。旧的 ^[a-z][a-z0-9_-]{0,63}$
// 会拒绝数字开头的合法环信用户名。
function isValidEasemobUsername(s) {
  return typeof s === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(s);
}

// 把一条 KV 原始 JSON 解析成等级记录；没有/坏了就给一份空的。
// updatedAt：服务器时间戳（v10 起不再信任客户端传的 updatedAt）。
function parseLevelRecord(raw) {
  const rec = { bound: "", xp: 0, ck: "", msgd: "", msgc: 0, stitles: [], cmail: [], dtitle: "", updatedAt: 0 };
  if (!raw) return rec;
  try {
    const j = JSON.parse(raw);
    if (typeof j.bound === "string") rec.bound = j.bound;
    if (typeof j.xp === "number" && j.xp >= 0) rec.xp = Math.floor(j.xp);
    if (isValidDateStr(j.ck)) rec.ck = j.ck;
    if (isValidDateStr(j.msgd)) rec.msgd = j.msgd;
    if (typeof j.msgc === "number" && j.msgc >= 0) rec.msgc = Math.floor(j.msgc);
    if (Array.isArray(j.stitles)) {
      rec.stitles = j.stitles
        .filter((t) => typeof t === "string" && t.length >= 1 && t.length <= LEVEL_MAX_TITLE_LEN)
        .slice(0, LEVEL_MAX_STITLES);
    }
    if (Array.isArray(j.cmail)) rec.cmail = j.cmail.filter((t) => typeof t === "string");
    if (typeof j.dtitle === "string") rec.dtitle = j.dtitle;
    if (typeof j.updatedAt === "number" && j.updatedAt >= 0) rec.updatedAt = Math.floor(j.updatedAt);
  } catch { /* 读坏了就按空记录走，不崩 */ }
  return rec;
}

// v7 M-16：等级记录的读写全部走每用户 DO（LevelStore），不再直接读改 KV。
// DO 未绑定时直接抛错（handleLevelRequest 开头已先拦一道，正常情况下
// 到不了这里）；DO 调用返回的业务错误（{ok:false}，HTTP 200）原样返回，
// 只有 HTTP 非 2xx 或读不懂的回包才抛错。
function levelStoreStub(env, username) {
  if (!env.LEVEL_STORE) throw new Error("LEVEL_STORE 未绑定");
  const id = env.LEVEL_STORE.idFromName("level:" + username);
  return env.LEVEL_STORE.get(id);
}

async function levelDoCall(env, username, path, body) {
  const stub = levelStoreStub(env, username);
  const res = await stub.fetch("https://do" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("等级存储调用失败: HTTP " + res.status + " " + t.slice(0, 200));
    throw new Error("等级存储调用失败");
  }
  return await res.json();
}

// 读一条等级记录（走 DO；DO 里没有时会从 LEVEL_KV 懒迁移）。
async function levelLoad(env, username) {
  const f = await levelLoadFull(env, username);
  return f.rec;
}

// 读一条等级记录 + 是否已有服务器记录（migrate/bind 的 bound 校验用）。
async function levelLoadFull(env, username) {
  const j = await levelDoCall(env, username, "/load", { username });
  return { rec: parseLevelRecord(JSON.stringify(j.record || null)), existed: !!j.existed };
}

// 在 DO 里对一条记录做一次改动；返回 DO 的回包 { ok, rec, ... }
// （rec 已归一化；业务不成立时 ok:false + error，不抛错）。
async function levelApply(env, username, op, payload) {
  const j = await levelDoCall(env, username, "/apply", { username, op, ...(payload || {}) });
  if (j.rec) j.rec = parseLevelRecord(JSON.stringify(j.rec));
  return j;
}

// 情侣总分 = 我 + 对方（对方记录也指回我才算，否则只算我自己的）。
async function levelCoupleTotal(env, rec, me) {
  let total = rec.xp;
  if (rec.bound) {
    const partner = await levelLoad(env, rec.bound);
    if (partner.bound === me) total += partner.xp;
  }
  return total;
}

// level 接口的身份校验：每次都要带密码，用环信密码登录验一次。
// （和删号接口的密码路径同一个做法；不验 userToken，app 调 level 接口只带密码。）
// v10 W-P3: 上游不可用时 verifyPassword 抛 UpstreamError，外层统一转 JSON 500；
// 只有密码不对才返回 null → 403。
async function levelVerify(env, body) {
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || !password) return null;
  if (!requireEasemobSecrets(env)) return null;
  const ok = await verifyPassword(env, username, password);
  return ok ? username : null;
}

// 管理员校验：用 app token 调环信 GET /chatgroups/{group_id}，owner 必须是本人。
// 返回 { isOwner, groupname }：groupname 供 /level/send-announcement 校验
// “只能发到系统公告群”（v8）。环信返回的 data 可能是对象也可能是数组，
// owner 和 groupname 都按两种形状取。
// v9 修正：环信群详情接口的群名字段不固定（有的返回 groupname，有的返回
// name），两个都试；取不到群名时返回 ""，调用方不得仅凭 "" 就拦截
// （v8 的教训：只认 groupname 时，取不到就把正确群也 403 了）。
async function levelVerifyGroupOwner(env, appToken, groupId, username) {
  let r;
  try {
    r = await fetch(`${BASE(env)}/chatgroups/${encodeURIComponent(groupId)}`, {
      headers: { Authorization: "Bearer " + appToken },
    });
  } catch (e) {
    console.error("验群主失败: 网络异常", e);
    throw new UpstreamError("环信服务暂时不可用");
  }
  if (!r.ok) {
    if (r.status >= 500) throw new UpstreamError("环信服务暂时不可用");
    return { isOwner: false, groupname: "" };
  }
  try {
    const j = await r.json();
    const data = j.data;
    const info = data && typeof data === "object" && !Array.isArray(data)
      ? data
      : (Array.isArray(data) && data[0] ? data[0] : j);
    const gn = typeof info.groupname === "string" && info.groupname
      ? info.groupname
      : (typeof info.name === "string" ? info.name : "");
    return {
      isOwner: info.owner === username,
      groupname: gn,
    };
  } catch {
    return { isOwner: false, groupname: "" };
  }
}

// v10 W-B2: 服务端自己定公告群——用 app token 翻页拉群列表，按名字找
// “我们的爱情-系统公告”。找到返回 { id, owner, groupname }，找不到返回 null。
// 找不到时调用方返回明确错误，不在服务端建群。
async function findAnnouncementGroup(env, appToken) {
  let cursor = "";
  for (let page = 0; page < 10; page++) {
    const u = `${BASE(env)}/chatgroups?limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
    let r;
    try {
      r = await fetch(u, { headers: { Authorization: "Bearer " + appToken } });
    } catch (e) {
      console.error("找公告群失败: 网络异常", e);
      throw new UpstreamError("环信服务暂时不可用");
    }
    if (!r.ok) {
      if (r.status >= 500) throw new UpstreamError("环信服务暂时不可用");
      return null;
    }
    const j = await r.json().catch(() => null);
    const list = Array.isArray(j && j.data)
      ? j.data
      : (Array.isArray(j && j.entities) ? j.entities : []);
    for (const g of list) {
      if (!g || typeof g !== "object") continue;
      const name = typeof g.groupname === "string" && g.groupname
        ? g.groupname
        : (typeof g.name === "string" ? g.name : "");
      if (name === ANNOUNCE_GROUP_NAME) {
        return {
          id: String(g.groupid || g.id || ""),
          owner: typeof g.owner === "string" ? g.owner : "",
          groupname: name,
        };
      }
    }
    cursor = j && typeof j.cursor === "string" ? j.cursor : "";
    if (!cursor) break;
  }
  return null;
}

// 用 app token 调环信发消息（1:1 或群聊），ext 原样带过去。
// v10 W-M8/W-P3: 上游错误体只记日志，抛通用错。
async function levelSendEasemobMessage(env, appToken, targetType, target, body, from, ext) {
  let r;
  try {
    const payload = {
      target_type: targetType,
      target: [target],
      msg: { type: "txt", msg: body },
      from: from,
    };
    if (ext && Object.keys(ext).length > 0) payload.ext = ext;
    r = await fetch(`${BASE(env)}/messages`, {
      method: "POST",
      headers: { Authorization: "Bearer " + appToken, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error("环信发消息失败: 网络异常", e);
    throw new UpstreamError("环信服务暂时不可用");
  }
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    console.error("环信发消息失败: HTTP " + r.status + " " + t.slice(0, 200));
    if (r.status >= 500) throw new UpstreamError("环信服务暂时不可用");
    throw new Error("环信发消息失败");
  }
  return r.json();
}

async function levelSha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 列出全部邮件登记记录（v10 W-B1：迁移上限与称号白名单的来源）。邮件量很小，
// 全量拉一次没问题；读失败返回空数组（调用方按“无登记邮件”算，不直接炸）。
async function listMailRecords(env) {
  const out = [];
  if (!env.LEVEL_KV) return out;
  try {
    let cursor = undefined;
    for (let page = 0; page < 100; page++) {
      const res = await env.LEVEL_KV.list({ prefix: "mail:", cursor, limit: 100 });
      for (const k of res.keys) {
        try {
          const raw = await env.LEVEL_KV.get(k.name);
          if (raw) out.push(JSON.parse(raw));
        } catch { /* 单条坏记录跳过 */ }
      }
      if (res.list_complete) break;
      cursor = res.cursor;
      if (!cursor) break;
    }
  } catch (e) {
    console.error("列邮件登记失败", e);
  }
  return out;
}

// v6 M-28 + v10 W-B1：双设备迁移合并。服务器已有记录时按字段合并后迁的快照：
//   xp 取两边较大值（两边都已过服务端上限校验，合并后仍在上限内）；
//   ck 取较晚的日期；msgd/msgc 取 msgd 较晚的那份（相等取 msgc 较大值）；
//   stitles 取并集去重（再按 allowedTitles 白名单过滤、截到 50 个）；
//   cmail 取并集去重、留最近 1000 个；
//   dtitle 用快照的（如果它在合并后的 stitles 里），否则保留服务器的；
//   bound 用快照的（如果非空），否则保留服务器的（解绑走 /level/unbind
//     直接清服务器，快照里 bound 为空只是旧缓存，不是解绑意图）；
//   updatedAt 用服务器时间（v10 起不再信任客户端传的 updatedAt）。
// 合并是幂等的：同一份快照迁两次，结果不变。
function levelMergeMigrateRecords(server, snap, allowedTitles) {
  const merged = {
    bound: snap.bound ? snap.bound : server.bound,
    xp: Math.max(server.xp, snap.xp),
    ck: snap.ck > server.ck ? snap.ck : server.ck,
    msgd: "",
    msgc: 0,
    stitles: [],
    cmail: [],
    dtitle: "",
    updatedAt: Date.now(),
  };
  if (snap.msgd > server.msgd) {
    merged.msgd = snap.msgd;
    merged.msgc = snap.msgc;
  } else if (snap.msgd < server.msgd) {
    merged.msgd = server.msgd;
    merged.msgc = server.msgc;
  } else {
    merged.msgd = server.msgd;
    merged.msgc = Math.max(server.msgc, snap.msgc);
  }
  merged.stitles = [...server.stitles];
  for (const t of snap.stitles) {
    if (merged.stitles.indexOf(t) === -1) merged.stitles.push(t);
  }
  if (Array.isArray(allowedTitles)) {
    merged.stitles = merged.stitles.filter((t) => allowedTitles.indexOf(t) !== -1);
  }
  merged.stitles = merged.stitles.slice(0, LEVEL_MAX_STITLES);
  const seenMail = new Set();
  const cmail = [];
  for (const m of [...server.cmail, ...snap.cmail]) {
    if (!seenMail.has(m)) { seenMail.add(m); cmail.push(m); }
  }
  merged.cmail = cmail.length > LEVEL_MAX_CLAIMED_MAIL_IDS
    ? cmail.slice(cmail.length - LEVEL_MAX_CLAIMED_MAIL_IDS)
    : cmail;
  merged.dtitle = (snap.dtitle && merged.stitles.indexOf(snap.dtitle) !== -1)
    ? snap.dtitle
    : (merged.stitles.indexOf(server.dtitle) !== -1 ? server.dtitle : "");
  return merged;
}

// v10 W-B5: 发邮件幂等 + 公告去重的单写者（Durable Object，全局单实例）。
// KV 先查后写有竞态（两路并发同 key 可同时查无、同时发两封），改走 DO 原子完成：
//   POST /reserve { key, nonce, ttlMs } —— key 不存在/已过期则占位 pending，
//     已确认且在有效期内返回 { ok:true, replayed:true, value }（幂等重放），
//     还在 pending（另一路正在发）返回 { ok:false, pending:true }。
//   POST /confirm { key, nonce, value } —— 发成功后把 pending 置为 done，记下 value。
//   POST /release { key, nonce } —— 发送失败时删掉 pending，不留去重键，
//     60 秒内可重试（公告）/ 立即重试（邮件幂等）。
// pending 占位最多挡 60 秒（占位方崩了也不至于一直锁死）；done 的有效期由 ttlMs 定
// （邮件幂等 10 分钟，公告去重 60 秒）。
export class MailGate {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    try { body = await request.json(); } catch { /* ignore */ }
    if (request.method === "POST" && url.pathname === "/reserve") {
      const key = typeof body.key === "string" ? body.key : "";
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      const ttlMs = typeof body.ttlMs === "number" && Number.isFinite(body.ttlMs) && body.ttlMs > 0
        ? Math.min(Math.floor(body.ttlMs), 3600000) : 600000;
      if (!key || !nonce) return json({ ok: false, error: "缺少 key 或 nonce" }, 400);
      const now = Date.now();
      let existing = null;
      try { existing = await this.state.storage.get(key); } catch { /* ignore */ }
      if (existing) {
        if (existing.state === "done" && now - (existing.at || 0) < (existing.ttlMs || 0)) {
          return json({ ok: true, replayed: true, value: existing.value ?? null });
        }
        if (existing.state === "pending" && now - (existing.at || 0) < 60000) {
          return json({ ok: false, pending: true, error: "正在处理中，请稍后再试" });
        }
        // 已过期：往下接管。
      }
      try {
        await this.state.storage.put(key, { nonce, state: "pending", at: now, ttlMs });
      } catch (e) {
        return json({ ok: false, error: "幂等存储写失败" }, 500);
      }
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/confirm") {
      const key = typeof body.key === "string" ? body.key : "";
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      if (!key || !nonce) return json({ ok: false, error: "缺少 key 或 nonce" }, 400);
      try {
        const existing = await this.state.storage.get(key);
        if (existing && existing.nonce === nonce) {
          await this.state.storage.put(key, {
            nonce, state: "done", value: body.value ?? null,
            at: Date.now(), ttlMs: existing.ttlMs || 600000,
          });
        }
      } catch { /* 确认写失败不炸掉本次成功，只记日志（调用方已记） */ }
      return json({ ok: true });
    }
    if (request.method === "POST" && url.pathname === "/release") {
      const key = typeof body.key === "string" ? body.key : "";
      const nonce = typeof body.nonce === "string" ? body.nonce : "";
      if (!key || !nonce) return json({ ok: false, error: "缺少 key 或 nonce" }, 400);
      try {
        const existing = await this.state.storage.get(key);
        if (existing && existing.nonce === nonce) {
          await this.state.storage.delete(key);
        }
      } catch { /* ignore */ }
      return json({ ok: true });
    }
    return json({ ok: false, error: "not found" }, 404);
  }
}

function mailGateStub(env) {
  if (!env.MAIL_GATE) throw new Error("MAIL_GATE 未绑定");
  const id = env.MAIL_GATE.idFromName("mail-gate");
  return env.MAIL_GATE.get(id);
}

async function mailGateCall(env, path, body) {
  const stub = mailGateStub(env);
  const res = await stub.fetch("https://do" + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    console.error("邮件幂等存储调用失败: HTTP " + res.status + " " + t.slice(0, 200));
    throw new Error("邮件幂等存储调用失败");
  }
  return await res.json();
}

// 占位：返回 { ok, replayed, value, pending, error, nonce }。
async function mailGateReserve(env, key, ttlMs) {
  const nonce = crypto.randomUUID();
  const r = await mailGateCall(env, "/reserve", { key, nonce, ttlMs });
  return { ...r, nonce };
}

async function mailGateConfirm(env, key, nonce, value) {
  try {
    await mailGateCall(env, "/confirm", { key, nonce, value: value ?? null });
  } catch (e) {
    console.error("mail-gate confirm 失败", key, e);
  }
}

async function mailGateRelease(env, key, nonce) {
  try {
    await mailGateCall(env, "/release", { key, nonce });
  } catch (e) {
    console.error("mail-gate release 失败", key, e);
  }
}

// v7 M-16：每用户等级记录的单写者（Durable Object，强一致）。
// 每个用户一个 DO 实例（idFromName("level:" + username)），记录存在
// DO 存储里（SQLite，new_sqlite_classes）。DO 在 Cloudflare 侧是单线程
// 串行处理请求的，所以同一用户的并发改动不会互相覆盖——KV 读-改-写
// 竞态彻底消失，不再需要 v5 的 levelMutate 乐观重试（已删）。
// LEVEL_KV 里的 u: 记录只作两件事：① 首次访问时懒迁移进 DO（老数据
// 不丢）；② 每次写回时同步一份镜像（方便排障/回滚，DO 存储才是账本）。
// mail: 键仍在 KV 里（登记表，单次写入、无读改写竞态，不动）；
// idem-mail:/ann: 键 v10 起改走 MailGate DO（见上）。
export class LevelStore {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    let body = {};
    try { body = await request.json(); } catch { /* ignore */ }
    if (request.method === "POST" && url.pathname === "/load") {
      const username = typeof body.username === "string" ? body.username : "";
      const r = await this.loadRecord(username);
      return json({ ok: true, record: r.rec, existed: r.existed });
    }
    if (request.method === "POST" && url.pathname === "/apply") {
      return await this.applyOp(body);
    }
    return json({ ok: false, error: "not found" }, 404);
  }

  // 读记录；DO 里没有时从 LEVEL_KV 懒迁移（老数据不丢）。
  // 返回 { rec, existed }：existed 表示迁移前就已有记录
  // （DO 里有，或 KV 里有）。
  async loadRecord(username) {
    try {
      const raw = await this.state.storage.get("rec");
      if (raw) return { rec: parseLevelRecord(raw), existed: true };
    } catch { /* 存储读失败时往下走 KV */ }
    if (username && this.env.LEVEL_KV) {
      try {
        const kvRaw = await this.env.LEVEL_KV.get("u:" + username);
        if (kvRaw) {
          const rec = parseLevelRecord(kvRaw);
          try { await this.state.storage.put("rec", JSON.stringify(rec)); } catch { /* ignore */ }
          return { rec, existed: true };
        }
      } catch { /* KV 读失败就按空记录走 */ }
    }
    return { rec: parseLevelRecord(null), existed: false };
  }

  // 写回：DO 存储是账本；再同步一份到 LEVEL_KV 当镜像
  // （镜像写失败不影响本次改动——账本已落盘）。
  async saveRecord(username, rec) {
    await this.state.storage.put("rec", JSON.stringify(rec));
    if (username && this.env.LEVEL_KV) {
      try { await this.env.LEVEL_KV.put("u:" + username, JSON.stringify(rec)); } catch { /* ignore */ }
    }
  }

  // 在 DO 内对一条记录做一次改动（串行，原子）。
  // body: { username, op, ...op 参数 }；成功回 {ok:true, rec, ...}，
  // 业务不成立回 {ok:false, error}（HTTP 200，调用方原样转给 app）。
  async applyOp(body) {
    const username = typeof body.username === "string" ? body.username : "";
    const op = body.op;
    if (!username || !op) return json({ ok: false, error: "缺少 username 或 op" }, 400);
    const loaded = await this.loadRecord(username);
    const rec = loaded.rec;
    let result = null;
    switch (op) {
      case "checkin": {
        const d = body.today;
        if (typeof d !== "string" || !isValidDateStr(d)) return json({ ok: false, error: "日期不对" }, 400);
        if (rec.ck === d) return json({ ok: false, error: "今天已经签到过了" });
        rec.xp += LEVEL_CHECKIN_XP;
        rec.ck = d;
        break;
      }
      case "add-xp": {
        const d = body.today;
        if (typeof d !== "string" || !isValidDateStr(d)) return json({ ok: false, error: "日期不对" }, 400);
        if (!rec.bound) return json({ ok: false, error: "还没有绑定情侣" });
        // v10 W-M1: 双向绑定校验放进 DO 内做——加分前一刻跨 DO 再读一次
        // 伴侣记录，确认对方仍指回我。跨 DO 读不到/调用失败时以外层 handler
        // 的校验为准（只在“明确读到对方没指回我”时拒绝），不因一次读失败
        // 把合法的 +2 挡掉。
        if (this.env.LEVEL_STORE) {
          try {
            const pStub = this.env.LEVEL_STORE.get(this.env.LEVEL_STORE.idFromName("level:" + rec.bound));
            const pr = await pStub.fetch("https://do/load", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ username: rec.bound }),
            });
            if (pr.ok) {
              const pj = await pr.json();
              const prec = parseLevelRecord(JSON.stringify(pj.record || null));
              if (prec.bound !== username) return json({ ok: false, error: "还没有绑定情侣" });
            }
          } catch { /* 见上 */ }
        }
        if (rec.msgd !== d) { rec.msgd = d; rec.msgc = 0; }
        result = { counted: false };
        if (rec.msgc < LEVEL_MESSAGE_DAILY_MAX) {
          rec.msgc += 1;
          rec.xp += LEVEL_MESSAGE_XP;
          result.counted = true;
        }
        break;
      }
      case "claim-mail": {
        const mailId = body.mail_id;
        const kind = body.kind;
        if (typeof mailId !== "string" || !mailId) return json({ ok: false, error: "缺少 mail_id" }, 400);
        // 补充项 S2 (v10.5 配套): “已经领过了”带 code:"already_claimed"，
        // app 侧优先读 code 判断，不再用 contains 子串匹配。
        if (rec.cmail.indexOf(mailId) !== -1) return json({ ok: false, error: "已经领过了", code: "already_claimed" });
        // v10 W-M13: DO 内防御性校验——amount/title 不再直接信任调用方。
        // 旧版 Math.floor(undefined) 得 NaN，xp 变 NaN 后存盘变 null、下次解析回 0，
        // 等于清空经验。
        if (kind === "xp") {
          const amt = body.amount;
          if (typeof amt !== "number" || !Number.isFinite(amt) || amt < 1 || amt > LEVEL_MAX_MAIL_XP) {
            return json({ ok: false, error: "经验数量不对" }, 400);
          }
          rec.xp += Math.floor(amt);
        } else if (kind === "title") {
          const title = body.title;
          if (typeof title !== "string" || !title || title.length > LEVEL_MAX_TITLE_LEN) {
            return json({ ok: false, error: "称号不对" }, 400);
          }
          if (rec.stitles.indexOf(title) === -1) {
            if (rec.stitles.length >= LEVEL_MAX_STITLES) {
              return json({ ok: false, error: "称号太多了" }, 400);
            }
            rec.stitles.push(title);
          }
        } else {
          return json({ ok: false, error: "邮件类型不对" }, 400);
        }
        rec.cmail.push(mailId);
        if (rec.cmail.length > LEVEL_MAX_CLAIMED_MAIL_IDS) {
          rec.cmail = rec.cmail.slice(rec.cmail.length - LEVEL_MAX_CLAIMED_MAIL_IDS);
        }
        break;
      }
      case "bind": {
        if (typeof body.partner !== "string" || !body.partner) return json({ ok: false, error: "对方用户名不对" }, 400);
        rec.bound = body.partner;
        break;
      }
      case "unbind": {
        // v10 W-B3: 未绑定时直接报 ok:false，不清零经验（旧版无条件 xp=0，
        // 误调/重调一次就把本人全部经验丢光且无法恢复）。
        if (!rec.bound) return json({ ok: false, error: "还没有绑定情侣" });
        const partnerName = rec.bound;
        rec.bound = "";
        rec.xp = 0;
        rec.ck = "";
        rec.msgd = "";
        rec.msgc = 0;
        if (rec.stitles.indexOf(rec.dtitle) === -1) rec.dtitle = "";
        result = { partner: partnerName };
        break;
      }
      case "heal-unbind": {
        rec.bound = "";
        break;
      }
      case "clear-bound-if": {
        // 对方解绑时清掉我这边指回对方的 bound
        if (rec.bound === body.by) rec.bound = "";
        break;
      }
      case "migrate": {
        // v10 W-B1: 服务端封顶 + 白名单，DO 内再拦一道（纵深防御）。
        const ext = body.ext && typeof body.ext === "object" ? body.ext : {};
        const xpCap = typeof body.xpCap === "number" && Number.isFinite(body.xpCap) && body.xpCap >= 0
          ? Math.floor(body.xpCap) : 0;
        const allowedTitles = Array.isArray(body.allowedTitles)
          ? body.allowedTitles.filter((t) => typeof t === "string") : null;
        const snap = { bound: "", xp: 0, ck: "", msgd: "", msgc: 0, stitles: [], cmail: [], dtitle: "", updatedAt: 0 };
        if (typeof ext.bound === "string") snap.bound = ext.bound;
        if (typeof ext.xp === "number" && ext.xp >= 0) snap.xp = Math.floor(ext.xp);
        if (isValidDateStr(ext.ck)) snap.ck = ext.ck;
        if (isValidDateStr(ext.msgd)) snap.msgd = ext.msgd;
        if (typeof ext.msgc === "number" && ext.msgc >= 0) snap.msgc = Math.floor(ext.msgc);
        if (Array.isArray(ext.stitles)) {
          snap.stitles = ext.stitles
            .filter((t) => typeof t === "string" && t.length >= 1 && t.length <= LEVEL_MAX_TITLE_LEN)
            .slice(0, LEVEL_MAX_STITLES);
        }
        if (Array.isArray(ext.cmail)) snap.cmail = ext.cmail.slice(-LEVEL_MAX_CLAIMED_MAIL_IDS).filter((t) => typeof t === "string");
        if (typeof ext.dtitle === "string") snap.dtitle = ext.dtitle;
        // 超上限直接拒绝本次迁移（不做“截断到上限”的静默处理，让客户端知道被拒了）。
        if (snap.xp > xpCap) return json({ ok: false, error: "快照经验超出服务器上限，拒绝迁移" }, 400);
        // 称号只留白名单里的（等级称号或邮件登记表里的称号），其余丢弃不合并。
        if (allowedTitles) snap.stitles = snap.stitles.filter((t) => allowedTitles.indexOf(t) !== -1);
        // updatedAt 不再信任客户端：用服务器时间。
        snap.updatedAt = Date.now();
        const wasExisted = loaded.existed;
        Object.assign(rec, levelMergeMigrateRecords(rec, snap, allowedTitles));
        result = { migrated: !wasExisted, merged: wasExisted };
        break;
      }
      default:
        return json({ ok: false, error: "不支持的操作" }, 400);
    }
    await this.saveRecord(username, rec);
    return json({ ok: true, rec, ...(result || {}) });
  }
}

// ---------- /level/* 各接口（body 已解析好） ----------
// v10 W-C2: DO 调用失败（LEVEL_STORE 异常、存储错误）由这层 try/catch 接住，
// 一律返回 JSON 500，不再冒泡成 Cloudflare 默认非 JSON 500。
async function handleLevelRequest(env, path, body, clientIp) {
  try {
    return await handleLevelRequestInner(env, path, body, clientIp);
  } catch (e) {
    console.error("level 接口异常", path, e);
    return json({ ok: false, error: "服务器内部错误，请稍后再试" }, 500);
  }
}

async function handleLevelRequestInner(env, path, body, clientIp) {
  if (!env.LEVEL_KV) {
    return json({ ok: false, error: "Worker 还没配好等级数据（LEVEL_KV 未绑定）" }, 500);
  }
  // v7 M-16：等级记录在 DO 里；DO 绑定没生效时直接 500，
  // 别让请求走到一半才在 DO 调用处炸掉。判别式：绑定生效时错密码
  // 照旧 403，没生效时 /level/* 一律报这个 500。
  if (!env.LEVEL_STORE) {
    return json({ ok: false, error: "Worker 还没配好等级存储（LEVEL_STORE 未绑定）" }, 500);
  }
  // v10 W-M7: level 密码校验限流（每 IP+用户名 30 次/分钟），挡在线试探。
  const lvUser = (body.username || "").trim();
  if (lvUser) {
    rateLimitPrune();
    if (!rateLimitOk("lv:" + clientIp + ":" + lvUser, 30, 60000)) {
      return json({ ok: false, error: "请求太频繁，请稍后再试" }, 429);
    }
  }

  // ----- POST /level/checkin：每日签到 +4 XP -----
  if (path === "/checkin") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const d = serverDateInTz();
    if (!d) return json({ ok: false, error: "服务器日期算不出来" }, 400);
    // v10 W-M4: 不再校验 body.today，服务器日期就是权威（手机时间错了也能签到）。
    const r = await levelApply(env, username, "checkin", { today: d });
    // 补充项 S1 (v10.5 配套): “今天已经签到过了”失败回包里带服务器日期 date，
    // app 侧以服务端返回为准写 EXT，不再用设备日期。
    if (!r.ok) return json({ ok: false, error: r.error, date: d });
    const rec = r.rec;
    const total = await levelCoupleTotal(env, rec, username);
    const level = levelForXp(total);
    return json({ ok: true, xp: rec.xp, totalXp: total, level: level, title: levelTitleFor(level), checkedInToday: true });
  }

  // ----- POST /level/add-xp：发消息 +2 XP（每天最多 4 条，须双向绑定） -----
  if (path === "/add-xp") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const d = serverDateInTz();
    if (!d) return json({ ok: false, error: "服务器日期算不出来" }, 400);
    // v10 W-M4: 不再校验 body.today。
    const rec = await levelLoad(env, username);
    if (!rec.bound) return json({ ok: false, error: "还没有绑定情侣" });
    const partner = await levelLoad(env, rec.bound);
    if (partner.bound !== username) return json({ ok: false, error: "还没有绑定情侣" });
    // v10 W-M1: 双向校验还在 DO 内做一次（applyOp 里），加分本身在 DO 内做。
    const r = await levelApply(env, username, "add-xp", { today: d });
    if (!r.ok) return json({ ok: false, error: r.error });
    // v10 W-M1: 加分后重读伴侣最新记录算总分，不再用加分前加载的旧值。
    let total = r.rec.xp;
    try {
      const partnerFresh = await levelLoad(env, r.rec.bound);
      if (partnerFresh.bound === username) total += partnerFresh.xp;
    } catch {
      total = r.rec.xp + partner.xp; // 读不到就用校验时的旧值兜底
    }
    const level = levelForXp(total);
    return json({ ok: true, xp: r.rec.xp, totalXp: total, level: level, title: levelTitleFor(level), counted: r.counted });
  }

  // ----- POST /level/claim-mail：领邮件（服务器判重，同一封只能领一次） -----
  if (path === "/claim-mail") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const mailId = (body.mail_id || "").trim();
    const kind = body.kind;
    if (!mailId) return json({ ok: false, error: "缺少 mail_id" }, 400);
    if (kind !== "xp" && kind !== "title") return json({ ok: false, error: "邮件类型不对" }, 400);
    const amount = body.amount;
    const title = (body.title || "").trim();
    if (kind === "xp" && (typeof amount !== "number" || amount < 1 || amount > LEVEL_MAX_MAIL_XP)) {
      return json({ ok: false, error: "经验数量不对" }, 400);
    }
    if (kind === "title" && (!title || title.length > LEVEL_MAX_TITLE_LEN)) {
      return json({ ok: false, error: "称号不对" }, 400);
    }
    // v5 B-2：先查邮件登记表——mail_id 必须是管理员经 /level/send-mail
    // 真发过的，且 kind/金额/称号/收件人要和登记时一致，否则就是凭空伪造。
    // v5 上线前经 v4 发出的邮件没有登记，领时会报“不存在”，属一次性代价。
    const mailRaw = await env.LEVEL_KV.get("mail:" + mailId);
    if (!mailRaw) return json({ ok: false, error: "这封邮件不存在或已失效" });
    let mail;
    try { mail = JSON.parse(mailRaw); } catch { return json({ ok: false, error: "这封邮件不存在或已失效" }); }
    if (!mail || mail.kind !== kind) return json({ ok: false, error: "邮件内容对不上" });
    if (kind === "xp" && mail.amount !== Math.floor(amount)) return json({ ok: false, error: "邮件内容对不上" });
    if (kind === "title" && mail.title !== title) return json({ ok: false, error: "邮件内容对不上" });
    // v10 W-M6: scope 为 one 时 mail.to 缺失也拒绝领取（旧版 `mail.to &&`
    // 会让缺 to 的脏记录任人可领）。
    if (mail.scope === "one" && mail.to !== username) return json({ ok: false, error: "这封邮件不是发给你的" });
    // v7：判重 + 加经验/称号在 DO 内一次做完，同一封并发领两次也只会
    // 成功一次（DO 串行；v6 的 levelMutate 在这里仍有毫秒级窗口）。
    const r = await levelApply(env, username, "claim-mail", {
      mail_id: mailId, kind,
      amount: kind === "xp" ? Math.floor(amount) : 0,
      title: kind === "title" ? title : "",
    });
    // 补充项 S2: DO 回的 code (如 already_claimed) 原样透传给 app。
    if (!r.ok) return json({ ok: false, error: r.error, ...(r.code ? { code: r.code } : {}) });
    const rec = r.rec;
    const total = await levelCoupleTotal(env, rec, username);
    const level = levelForXp(total);
    return json({ ok: true, xp: rec.xp, totalXp: total, level: level, title: levelTitleFor(level), titles: rec.stitles });
  }

  // ----- POST /level/send-mail：管理员发邮件（服务器验管理员身份） -----
  // v10 W-B2: 管理员身份只认“服务端自己查到的公告群的群主”——
  // 用 app token 按名字找公告群，调用者必须是那个群的群主；邮件发到服务端
  // 查到的那个群 id，客户端传的 group_id 忽略（旧版只认“任意群的群主”，
  // 任一用户自建一个群就能铸造 10000 XP/任意称号邮件再发给自己）。
  // v10 W-B5/W-P4: 幂等查+写进 MailGate DO 原子完成，顺序统一为“先发后记键”，
  // 发送失败释放预留，不留幂等键。
  if (path === "/send-mail") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const scope = body.scope;
    const to = (body.to || "").trim();
    const kind = body.kind;
    const amount = body.amount;
    const title = (body.title || "").trim();
    const note = (body.note || "").trim();
    // v5 M-13：可选幂等键（app v10.1 开始传，UUID；重试时复用同一把 key）。
    const idemKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim().slice(0, 128) : "";
    if (scope !== "all" && scope !== "one") return json({ ok: false, error: "scope 不对" }, 400);
    if (kind !== "xp" && kind !== "title") return json({ ok: false, error: "邮件类型不对" }, 400);
    if (kind === "xp" && (typeof amount !== "number" || amount < 1 || amount > LEVEL_MAX_MAIL_XP)) {
      return json({ ok: false, error: "经验数量要在 1～10000 之间" }, 400);
    }
    if (kind === "title") {
      if (!title || title.length > LEVEL_MAX_TITLE_LEN) {
        return json({ ok: false, error: "称号不对" }, 400);
      }
      if (scope === "all") return json({ ok: false, error: "称号只能单独发给一个人" }, 400);
    }
    if (scope === "one" && !to) return json({ ok: false, error: "请输入对方的用户名" }, 400);
    if (scope === "one" && to === username) return json({ ok: false, error: "不能把邮件发给自己" }, 400);
    // v10 W-M6: note 限长 200 字。
    if (note.length > NOTE_MAX_LEN) return json({ ok: false, error: "备注最多 200 字" }, 400);
    if (!requireEasemobSecrets(env)) {
      return json({ ok: false, error: "Worker 还没配好密钥" }, 500);
    }
    if (!env.MAIL_GATE) {
      return json({ ok: false, error: "Worker 还没配好邮件幂等存储（MAIL_GATE 未绑定）" }, 500);
    }
    try {
      const appToken = await getAppToken(env);
      const annGroup = await findAnnouncementGroup(env, appToken);
      if (!annGroup || !annGroup.id) {
        return json({ ok: false, error: "找不到系统公告群，请先建一个名为「我们的爱情-系统公告」的群" }, 400);
      }
      const admin = await levelVerifyGroupOwner(env, appToken, annGroup.id, username);
      if (!admin.isOwner) return json({ ok: false, error: "只有系统公告群的群主可以发邮件" }, 403);
      // v10 W-M6: scope 为 one 时收件人必须存在。
      if (scope === "one" && !(await userExists(env, appToken, to))) {
        return json({ ok: false, error: "收件人不存在" }, 400);
      }
      let gate = null;
      if (idemKey) {
        const res = await mailGateReserve(env, "idem-mail:" + idemKey, 600000);
        if (res.replayed) return json({ ok: true, mail_id: res.value, replayed: true });
        if (!res.ok) return json({ ok: false, error: res.error || "正在处理中，请稍后再试" });
        gate = res;
      }
      const mailId = crypto.randomUUID();
      let msgBody;
      if (kind === "title") {
        msgBody = "📬 邮件：管理员授予你称号「" + title + "」" + (note ? "\n" + note : "");
      } else {
        msgBody = "📬 邮件：管理员送你 " + Math.floor(amount) + " 经验" + (note ? "\n" + note : "");
      }
      const ext = { mail: kind, mail_id: mailId, mail_scope: scope };
      if (kind === "xp") ext.mail_amt = Math.floor(amount);
      if (kind === "title") ext.mail_title = title;
      if (note) ext.mail_note = note;
      if (scope === "one") ext.mail_to = to;
      // 先发环信消息，成功后再登记 + 记幂等键；发送失败释放预留，不留键。
      try {
        if (scope === "all") {
          await levelSendEasemobMessage(env, appToken, "chatgroups", annGroup.id, msgBody, username, ext);
        } else {
          await levelSendEasemobMessage(env, appToken, "users", to, msgBody, username, ext);
        }
      } catch (e) {
        if (gate) await mailGateRelease(env, "idem-mail:" + idemKey, gate.nonce);
        throw e;
      }
      const mailRecord = { kind: kind, scope: scope, from: username, createdAt: Date.now() };
      if (kind === "xp") mailRecord.amount = Math.floor(amount);
      if (kind === "title") mailRecord.title = title;
      if (scope === "one") mailRecord.to = to;
      try {
        await env.LEVEL_KV.put("mail:" + mailId, JSON.stringify(mailRecord));
      } catch (e) {
        console.error("邮件登记写 KV 失败", mailId, e);
        if (gate) await mailGateRelease(env, "idem-mail:" + idemKey, gate.nonce);
        return json({ ok: false, error: "邮件登记失败，请重试" }, 500);
      }
      if (gate) await mailGateConfirm(env, "idem-mail:" + idemKey, gate.nonce, mailId);
      return json({ ok: true, mail_id: mailId });
    } catch (e) {
      if (e && e.upstream) return json({ ok: false, error: "环信服务暂时不可用，请稍后再试" }, 500);
      console.error("发邮件时出错", e);
      return json({ ok: false, error: "发邮件失败，请稍后再试" }, 500);
    }
  }

  // ----- POST /level/send-announcement：管理员发公告（验身份 + 60 秒去重） -----
  // v10 W-B5/W-P4: 去重查+写进 MailGate DO 原子完成，顺序统一为“先发后记键”——
  // 先发环信消息，成功后再确认去重键；发送失败释放预留，不留去重键，60 秒内可重试
  // （旧版先 put ann: 占位再发，发送失败后去重键仍在，60 秒内重试报“不要重复发送”）。
  if (path === "/send-announcement") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const groupId = (body.group_id || "").trim();
    const title = (body.title || "").trim();
    const content = (body.content || "").trim();
    if (!groupId) return json({ ok: false, error: "缺少 group_id" }, 400);
    if (!title || !content) return json({ ok: false, error: "标题和内容不能为空" }, 400);
    if (!requireEasemobSecrets(env)) {
      return json({ ok: false, error: "Worker 还没配好密钥" }, 500);
    }
    if (!env.MAIL_GATE) {
      return json({ ok: false, error: "Worker 还没配好公告去重存储（MAIL_GATE 未绑定）" }, 500);
    }
    try {
      const appToken = await getAppToken(env);
      const admin = await levelVerifyGroupOwner(env, appToken, groupId, username);
      if (!admin.isOwner) return json({ ok: false, error: "只有管理员可以发公告" }, 403);
      // v8：公告只能发到系统公告群。控制台和 app 各自盯着两个同名不同 id
      // 的公告群，之前只验“是不是群主”不验群名，发到错群也返回 ok:true，
      // 控制台显示“已发布”但 app 读另一个群所以看不到。群名不对直接 403，
      // 不再静默成功。
      // v9：只有“明确知道群名且不对”才拦；取不到群名时放行（只认 groupname
      // 一个字段的 v8 把正确群也 403 了，因为环信有的接口返回的是 name）。
      if (admin.groupname && admin.groupname !== "我们的爱情-系统公告") {
        return json({ ok: false, error: "公告只能发到系统公告群" }, 403);
      }
      const hash = await levelSha256Hex(title + "\n" + content);
      const gate = await mailGateReserve(env, "ann:" + hash, 60000);
      if (gate.replayed) return json({ ok: false, error: "不要重复发送" });
      if (!gate.ok) return json({ ok: false, error: gate.error || "正在处理中，请稍后再试" });
      try {
        await levelSendEasemobMessage(env, appToken, "chatgroups", groupId, "[公告]" + title + "\n" + content, username, null);
      } catch (e) {
        await mailGateRelease(env, "ann:" + hash, gate.nonce);
        throw e;
      }
      await mailGateConfirm(env, "ann:" + hash, gate.nonce, null);
      return json({ ok: true });
    } catch (e) {
      if (e && e.upstream) return json({ ok: false, error: "环信服务暂时不可用，请稍后再试" }, 500);
      console.error("发公告时出错", e);
      return json({ ok: false, error: "发公告失败，请稍后再试" }, 500);
    }
  }

  // ----- POST /level/get-couple：查情侣状态（双向绑定校验，单向自动自愈） -----
  if (path === "/get-couple") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const d = serverDateInTz();
    const rec = await levelLoad(env, username);
    // v5 B-3：未绑定也返回本人经验/等级/签到状态，app 不再拿 myXp=0 覆盖本地。
    const unbound = (r) => {
      const lv = levelForXp(r.xp);
      return {
        ok: true, bound: false,
        myXp: r.xp, level: lv, title: levelTitleFor(lv),
        checkedInToday: d ? r.ck === d : false,
        msgCountToday: d && r.msgd === d ? r.msgc : 0,
      };
    };
    if (!rec.bound) return json(unbound(rec));
    const partner = await levelLoad(env, rec.bound);
    if (!partner || partner.bound !== username) {
      const healed = await levelApply(env, username, "heal-unbind", {});
      return json(unbound(healed.ok ? healed.rec : rec));
    }
    const total = rec.xp + partner.xp;
    const level = levelForXp(total);
    return json({
      ok: true, bound: true, partner: rec.bound,
      myXp: rec.xp, partnerXp: partner.xp, totalXp: total,
      level: level, title: levelTitleFor(level),
      checkedInToday: d ? rec.ck === d : false,
      msgCountToday: d && rec.msgd === d ? rec.msgc : 0,
    });
  }

  // ----- POST /level/get-other：查别人的等级（只读，供好友行徽章用，v6 P-6） -----
  // 只读不改数据，不做自愈（对方单向绑定不由我来清）。
  // 对方没有记录或未绑定 → {ok:true, bound:false}；
  // 对方已绑定 → {ok:true, bound:true, level, title, totalXp}，
  // totalXp 照 get-couple 的算法算（对方 xp + 其伴侣 xp，伴侣不指回对方时只算对方的）。
  if (path === "/get-other") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const other = (body.other || "").trim();
    if (!other || !isValidEasemobUsername(other)) return json({ ok: false, error: "对方用户名不对" }, 400);
    const rec = await levelLoad(env, other);
    if (!rec.bound) return json({ ok: true, bound: false });
    const total = await levelCoupleTotal(env, rec, other);
    const level = levelForXp(total);
    return json({ ok: true, bound: true, level: level, title: levelTitleFor(level), totalXp: total });
  }

  // ----- POST /level/migrate：首次把手机 EXT 里的等级快照迁到服务器 -----
  // v10 W-B1: 服务端不再无条件信任客户端快照——
  //   经验上限 = 12 × (服务器今天 − 2025-10-17 的天数) + 已登记的邮件经验总和
  //              + 10000（一次性补登旧版无登记邮件的宽限）；超上限直接拒绝本次迁移。
  //   称号只接受等级称号（按封顶后经验算出的等级及以下的 LV.1–18 称号）或邮件
  //   登记表里的称号，其余丢弃不合并。
  //   bound 只有对方经 Easemob 查确实存在、且对方服务器记录里 bound 等于我或
  //   对方尚无服务器记录时才接受；对方记录已存在且 bound 不是我时丢弃快照的 bound。
  //   客户端传的 updatedAt 不参与任何排序/取大，用服务器时间。
  if (path === "/migrate") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const ext = body.ext && typeof body.ext === "object" ? body.ext : {};
    const today = serverDateInTz();
    const days = today ? Math.max(0, daysBetween(MIGRATE_BASE_DATE, today)) : 0;
    let mailXp = 0;
    const allowedTitles = new Set();
    try {
      const mails = await listMailRecords(env);
      for (const m of mails) {
        if (!m || typeof m !== "object") continue;
        const forMe = m.scope === "all" || (m.scope === "one" && m.to === username);
        if (!forMe) continue;
        if (m.kind === "xp" && typeof m.amount === "number" && m.amount > 0) mailXp += Math.floor(m.amount);
        if (m.kind === "title" && typeof m.title === "string" && m.title) allowedTitles.add(m.title);
      }
    } catch (e) {
      console.error("迁移读邮件登记失败", e);
    }
    const xpCap = 12 * days + mailXp + MIGRATE_LEGACY_XP_ALLOWANCE;
    const cappedLevel = levelForXp(xpCap);
    for (let i = 1; i <= cappedLevel; i++) allowedTitles.add(LEVEL_TITLES[i - 1]);
    // bound 校验：对方必须真实存在、且对方无服务器记录或已指回我。
    // 验不出来（环信不可用/对方不存在/对方已绑别人）就丢弃快照的 bound，
    // 保留服务器的 bound，不因此拒绝整次迁移（绑定走 /level/bind 单独验）。
    let snapBound = typeof ext.bound === "string" ? ext.bound.trim() : "";
    if (snapBound) {
      let accept = false;
      try {
        if (requireEasemobSecrets(env)) {
          const appToken = await getAppToken(env);
          if (await userExists(env, appToken, snapBound)) {
            const p = await levelLoadFull(env, snapBound);
            if (!p.existed || p.rec.bound === username) accept = true;
          }
        }
      } catch (e) {
        console.error("迁移验 bound 失败，丢弃快照 bound", e);
        accept = false;
      }
      if (!accept) snapBound = "";
    }
    const extForDo = { ...ext, bound: snapBound };
    const r = await levelApply(env, username, "migrate", {
      ext: extForDo, xpCap, allowedTitles: [...allowedTitles],
    });
    if (!r.ok) return json({ ok: false, error: r.error });
    return json({ ok: true, migrated: r.migrated, merged: r.merged, record: r.rec });
  }

  // ----- POST /level/bind：把绑定写进服务器（v5 补 B-1，v10 修 W-B6） -----
  // v10: 只验对方用户名格式已不够——
  //   ① 对方必须在环信上真实存在；② 对方已绑定别人时拒绝；
  //   ③ 调用者已绑定别人时先解掉旧绑定（清旧伴侣回指），不静默覆盖。
  if (path === "/bind") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const partner = (body.partner || "").trim();
    if (!partner || partner === username) return json({ ok: false, error: "对方用户名不对" }, 400);
    if (!isValidEasemobUsername(partner)) return json({ ok: false, error: "对方用户名不对" }, 400);
    if (!requireEasemobSecrets(env)) {
      return json({ ok: false, error: "Worker 还没配好密钥" }, 500);
    }
    try {
      const appToken = await getAppToken(env);
      if (!(await userExists(env, appToken, partner))) {
        return json({ ok: false, error: "对方用户不存在" }, 400);
      }
    } catch (e) {
      if (e && e.upstream) return json({ ok: false, error: "环信服务暂时不可用，请稍后再试" }, 500);
      console.error("绑定验对方存在失败", e);
      return json({ ok: false, error: "绑定失败，请稍后再试" }, 500);
    }
    const myRec = await levelLoad(env, username);
    const partnerFull = await levelLoadFull(env, partner);
    if (partnerFull.existed && partnerFull.rec.bound && partnerFull.rec.bound !== username) {
      return json({ ok: false, error: "对方已绑定其他人" }, 400);
    }
    if (myRec.bound === partner) return json({ ok: true, bound: partner });
    const oldPartner = myRec.bound || "";
    const r = await levelApply(env, username, "bind", { partner });
    if (!r.ok) return json({ ok: false, error: r.error });
    if (oldPartner && oldPartner !== partner) {
      // 换绑：清掉旧伴侣的回指（尽力而为；失败时对方下次 get-couple 自愈兜底）。
      try {
        await levelApply(env, oldPartner, "clear-bound-if", { by: username });
      } catch (e) {
        console.error("换绑清旧伴侣回指失败", oldPartner, e);
      }
    }
    return json({ ok: true, bound: partner });
  }

  // ----- POST /level/unbind：解绑（等级清零，特殊称号保留） -----
  // v10 W-B3: 未绑定时 DO 直接报 ok:false，这里原样返回，不清零经验。
  // v10 W-M2: 设计——解绑只清发起方经验，对方保留全部经验；这里只清对方的
  // 回指。双人解绑非原子：对方这一步失败/崩溃时，对方残留的 bound 靠其下次
  // get-couple 自愈兜底。
  if (path === "/unbind") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const r = await levelApply(env, username, "unbind", {});
    if (!r.ok) return json({ ok: false, error: r.error });
    const partnerName = r.partner || "";
    if (partnerName) {
      try {
        const partner = await levelLoad(env, partnerName);
        if (partner.bound === username) {
          await levelApply(env, partnerName, "clear-bound-if", { by: username });
        }
      } catch (e) {
        console.error("解绑清对方回指失败", partnerName, e);
      }
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: "不支持的 level 接口" }, 404);
}

export default {
  async fetch(request, env) {
    const ip = clientIp(request);
    // v10 W-C1: 外层 try/catch，未捕获异常也返回 JSON 500，不再冒泡成默认 500。
    try {
      if (request.method === "OPTIONS") {
        const h = corsHeadersFor(request);
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type",
            ...h,
          },
        });
      }
      if (request.method !== "POST") {
        return withCors(json({ ok: false, error: "只支持 POST" }, 404), request);
      }
      const url = new URL(request.url);

      // ---------- POST /level/*：情侣等级/经验/签到/邮件（v4） ----------
      // 路径可带 /level 前缀也可不带（代理会去掉前缀再转发，两种都认）。
      let levelPath = url.pathname;
      if (levelPath.startsWith("/level/")) levelPath = levelPath.slice("/level".length);
      if (levelPath === "/checkin" || levelPath === "/add-xp" || levelPath === "/claim-mail"
        || levelPath === "/send-mail" || levelPath === "/send-announcement"
        || levelPath === "/get-couple" || levelPath === "/get-other" || levelPath === "/migrate" || levelPath === "/unbind"
        || levelPath === "/bind") {
        const levelBody = await parseJsonBody(request);
        if (!levelBody) return withCors(json({ ok: false, error: "请求体不是 JSON 或不是对象" }, 400), request);
        return withCors(await handleLevelRequest(env, levelPath, levelBody, ip), request);
      }

      // ---------- POST /stats: 用户统计 (管理员工具) ----------
      if (url.pathname === "/stats") {
        const body = await parseJsonBody(request);
        if (!body) return withCors(json({ ok: false, error: "请求体不是 JSON 或不是对象" }, 400), request);
        // v10 W-M7: /stats 猜 key 限流（每 IP 10 次/分钟）。
        rateLimitPrune();
        if (!rateLimitOk("stats:" + ip, 10, 60000)) {
          return withCors(json({ ok: false, error: "请求太频繁，请稍后再试" }, 429), request);
        }
        if (!verifyAdminKey(env, body)) {
          return withCors(json({ ok: false, error: "管理员密钥不对" }, 403), request);
        }
        if (!requireEasemobSecrets(env)) {
          return withCors(json({ ok: false, error: "Worker 还没配好密钥" }, 500), request);
        }
        try {
          const appToken = await getAppToken(env);
          // v10 W-M9: 分页拉全量用户再计总数（旧版只读 limit=100 一页，
          // 环信默认页大小小于 limit 或返回截断时 total 会低估）。
          let total = 0;
          let cursor = "";
          for (let page = 0; page < 100; page++) {
            const u = `${BASE(env)}/users?limit=100` + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
            const r = await fetch(u, { headers: { Authorization: "Bearer " + appToken } });
            if (!r.ok) {
              if (r.status >= 500) throw new UpstreamError("环信服务暂时不可用");
              throw new Error("环信查用户失败: HTTP " + r.status);
            }
            const j = await r.json();
            const list = Array.isArray(j.entities) ? j.entities : [];
            total += list.length;
            cursor = typeof j.cursor === "string" ? j.cursor : "";
            if (!cursor) break;
          }
          return withCors(json({ ok: true, total: total, limit: USER_LIMIT, remaining: Math.max(0, USER_LIMIT - total) }), request);
        } catch (e) {
          console.error("查用户统计时出错", e);
          return withCors(json({ ok: false, error: "查用户统计失败，请稍后再试" }, 500), request);
        }
      }

      // ---------- POST /admin-delete: 管理员帮别人删号 ----------
      if (url.pathname === "/admin-delete") {
        const body = await parseJsonBody(request);
        if (!body) return withCors(json({ ok: false, error: "请求体不是 JSON 或不是对象" }, 400), request);
        const username = (body.username || "").trim();
        if (!username) return withCors(json({ ok: false, error: "缺少 username" }, 400), request);
        if (!verifyAdminKey(env, body)) {
          return withCors(json({ ok: false, error: "管理员密钥不对" }, 403), request);
        }
        if (!requireEasemobSecrets(env)) {
          return withCors(json({ ok: false, error: "Worker 还没配好密钥" }, 500), request);
        }
        // M10：上次删成功但 app 没收到结果，重试直接返回成功。
        const replayed = await idemReplay(env, "adel", username);
        if (replayed) return withCors(json(replayed), request);
        try {
          const appToken = await getAppToken(env);
          const r = await fetch(`${BASE(env)}/users/${encodeURIComponent(username)}`, {
            method: "DELETE",
            headers: { Authorization: "Bearer " + appToken },
          });
          if (!r.ok) {
            const t = await r.text().catch(() => "");
            console.error("环信删号失败: HTTP " + r.status + " " + t.slice(0, 200));
            if (r.status >= 500) throw new UpstreamError("环信服务暂时不可用");
            return withCors(json({ ok: false, error: "环信删号失败，请稍后再试" }, 502), request);
          }
          await idemPut(env, "adel", username, { ok: true, deleted: username });
          return withCors(json({ ok: true, deleted: username }), request);
        } catch (e) {
          console.error("删号时出错", e);
          return withCors(json({ ok: false, error: "删号失败，请稍后再试" }, 500), request);
        }
      }

      // ---------- POST /delete-account: 用户自己注销 ----------
      if (url.pathname !== "/delete-account") {
        return withCors(json({ ok: false, error: "只支持 POST /delete-account、/stats、/admin-delete、/level/*" }, 404), request);
      }
      const body = await parseJsonBody(request);
      if (!body) return withCors(json({ ok: false, error: "请求体不是 JSON 或不是对象" }, 400), request);
      const username = (body.username || "").trim();
      if (!username) return withCors(json({ ok: false, error: "缺少 username" }, 400), request);
      if (!requireEasemobSecrets(env)) {
        return withCors(json({ ok: false, error: "Worker 还没配好密钥" }, 500), request);
      }
      // v10 W-M7: 删号密码校验限流（每 IP+用户名 20 次/分钟）。
      rateLimitPrune();
      if (!rateLimitOk("del:" + ip + ":" + username, 20, 60000)) {
        return withCors(json({ ok: false, error: "请求太频繁，请稍后再试" }, 429), request);
      }

      // M10：上次删成功但 app 没收到结果，重试直接返回成功。
      // （放在身份校验之前：用户已被删掉时，密码/token 校验本来就会失败。）
      const replayed = await idemReplay(env, "del", username);
      if (replayed) return withCors(json(replayed), request);

      // 1. 校验本人 (防别人乱删号)
      // v10 W-B4: token 路径二次核对归属 + token 失败回退密码校验（见 verifyOwner）。
      let ok = false;
      try {
        ok = await verifyOwner(env, username, body.userToken, body.password);
      } catch (e) {
        console.error("校验身份时出错", e);
        return withCors(json({ ok: false, error: "身份校验服务暂时不可用，请稍后再试" }, 500), request);
      }
      if (!ok) return withCors(json({ ok: false, error: "身份校验失败, 只能注销自己的账号" }, 403), request);

      // 2. 应用 token + 删服务器上的账号
      try {
        const appToken = await getAppToken(env);
        const r = await fetch(`${BASE(env)}/users/${encodeURIComponent(username)}`, {
          method: "DELETE",
          headers: { Authorization: "Bearer " + appToken },
        });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          console.error("环信删号失败: HTTP " + r.status + " " + t.slice(0, 200));
          if (r.status >= 500) throw new UpstreamError("环信服务暂时不可用");
          return withCors(json({ ok: false, error: "环信删号失败，请稍后再试" }, 502), request);
        }
        await idemPut(env, "del", username, { ok: true, deleted: username });
        return withCors(json({ ok: true, deleted: username }), request);
      } catch (e) {
        console.error("删号时出错", e);
        return withCors(json({ ok: false, error: "删号失败，请稍后再试" }, 500), request);
      }
    } catch (e) {
      console.error("Worker 未捕获异常", e);
      return withCors(json({ ok: false, error: "服务器内部错误，请稍后再试" }, 500), request);
    }
  },
};
