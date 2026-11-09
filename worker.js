// 我们的爱情 - 真注销后端 (Cloudflare Worker) v6
// 作用:
//   POST /delete-account  app 点"注销账号"时, 先由 Worker 删掉环信服务器上的账号, 再由 app 清本地数据。
//   POST /stats           管理员工具查用户统计: 已注册多少用户 / 还剩多少名额 (环信免费测试版上限 100)。
//   POST /admin-delete    管理员帮别人删号: 管理员不需要被删账号的密码, 凭管理员密钥删号。
//   POST /level/*         情侣等级/经验/签到/邮件改由服务器说了算 (v10.0):
//     /level/checkin          每日签到 +4 XP (服务器日期说了算, 改手机时间刷不了)
//     /level/add-xp           发消息 +2 XP (每天最多 4 条, 1:1 和大厅共用计数, 须双向绑定)
//     /level/claim-mail       领邮件 (服务器判重, 同一封只能领一次)
//     /level/send-mail        管理员发邮件 (服务器验管理员身份, 再调环信发消息)
//     /level/send-announcement 管理员发公告 (服务器验管理员身份 + 60 秒去重)
//     /level/get-couple       查情侣状态 (双向绑定校验, 未绑定/单向绑定自动自愈)
//     /level/get-other        查别人的等级 (只读, 供好友行徽章用, v6 新增)
//     /level/migrate          首次把手机 EXT 里的等级快照迁到服务器 (已有记录时按字段合并, v6)
//     /level/bind             绑定 (v5：把 bound 写进服务器 KV，补 B-1)
//     /level/unbind           解绑 (等级清零, 特殊称号保留)
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
// Secret (值就是邀请码 Worker 的那个管理密钥, 用户手里有), 不要写进代码。
//
// v3 (2026-11-09) M10 删号幂等：删成功后把结果写进 KV 缓存 10 分钟；
// app 因网络问题重试时，先查缓存——缓存命中且环信那边已查无此人，
// 就直接返回上次的成功结果，不再重复删；同名新账号仍在则走正常流程。
// 失败的结果不缓存，重试会重新走流程。app 不用改，重试逻辑本来就有。
//
// v6 (2026-11-10) 审计 v10.0-v2.1 的第二批修复：
//   M-17：cmail 上限从 100 提到 1000（LEVEL_MAX_CLAIMED_MAIL_IDS），
//     claim-mail 截断和 migrate 的 slice 都走这个常量；app 那边
//     CoupleLevel.MAX_CLAIMED_MAIL_IDS 也要同步改成 1000。
//   M-28：/level/migrate 不再先写者胜——服务器已有记录时按字段合并
//     后迁的快照（xp 取大、ck 取晚、msgd/msgc 取晚、stitles/cmail
//     并集、dtitle/bound 按规则取、updatedAt 取大），返回合并后记录；
//     请求体可带 updatedAt（毫秒时间戳），和记录一起存下来。
//   P-6：新增 POST /level/get-other，只读不改：验身份后读对方记录，
//     未绑定回 {ok:true, bound:false}，已绑定回 {ok:true, bound:true,
//     level, title, totalXp}（totalXp 照 get-couple 的算法算）。
//   M-16：评估结论——选 (a)，保留 v5 的 levelMutate 乐观重试当缓解，
//     记为“已知窄窗口、未彻底修”，不上 Durable Object。理由：
//     ① KV 没有 CAS，纯 KV 做不到真正原子；DO 当锁要给 7 个改接口
//     全套加 acquire/release + 过期 + DO 挂了全拒的 fail-closed，
//     每个失败路径都是新风险；DO 当账本要把 live 的 u: 记录从
//     LEVEL_KV 搬进 DO 存储，还要跨 DO 读伴侣记录算总分，
//     是带数据迁移的大改。② M-16 的实际伤害很小：同一用户两次改动
//     在几十毫秒内重叠才丢一次 +2/+4 XP（只丢不翻倍、不 corrupt），
//     触发要签到后立刻发消息且恰好撞上窗口，用户量只有 3 人。
//     ③ InviteClaim 的 DO 只守一个码的一次认领，形状简单；
//     level 是每用户记录 × 7 个接口，不是一个量级。若以后用户量
//     上来或真丢过经验，再单独立项做 DO 账本迁移（含回填 + 双读），
//     不塞进 v10.2。wrangler.toml 因此不动。
//
// v5 (2026-11-10) 审计 v10.0-v2.1 的修复：
//   B-2：/level/send-mail 发成功后把邮件登记进 KV（mail:<mail_id>），
//     /level/claim-mail 按登记表验真——不存在、kind/金额/称号/收件人
//     对不上的直接拒绝，改过客户端再也凭空刷不了经验和称号。
//     注意：v5 上线前经 v4 发出的邮件没有登记，领时会报“不存在”，
//     属一次性代价（v4 才上线两天，实际发出的邮件极少）。
//   B-1：新增 POST /level/bind，绑定成功后 app 调它把 bound 写进 KV；
//     否则新绑定永远写不到服务器，get-couple 报未绑定还会把本地绑定清掉。
//   B-3：/level/get-couple 未绑定时也返回 myXp/level/title/checkedInToday/
//     msgCountToday，app 不再拿 myXp=0 覆盖本地经验。
//   M-13：/level/send-mail 接受可选 idempotency_key，10 分钟内同 key
//     重试直接返回原来那封的 mail_id，不再重发（app v10.1 开始传）。
//   M-15：服务器日期固定按 Asia/Shanghai 算，不再信任客户端传的 tz
//     （改过客户端轮换 tz 可多签到；用户在中国，app 的 tz 本来就是上海）。
//   M-16：改记录的接口走 levelMutate（读-改-写前再读一次比对，变了就
//     在新记录上重做一次），并发丢更新的窗口缩到毫秒级；KV 没有 CAS，
//     彻底修要上 Durable Object，不做，残余窗口如实记录。
//
// v4 (2026-11-09) B1/B2/B4/M24：等级/经验/签到/领邮件改由服务器说了算。
// 以前这些存在每个人自己的环信 EXT 里、手机端自己写，改过的客户端能
// 伪造经验和邮件公告、重装能重复领邮件、改手机时间能反复签到。现在
// 全部记在 love-level KV 里（每人一条 u:<username>），手机只负责显示
// 和发起请求。健康快照不搬，仍在 EXT；绑定/解绑流程不搬，仍走环信消息。
//
// 需要在 Worker 里配置的 Secrets (Dashboard > Settings > Variables):
//   EASEMOB_ORG           例: 1195261106225962
//   EASEMOB_APP           例: women-de-aiqing
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

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

// 拿应用级 token (client_credentials, 用 Client ID + Client Secret)
async function getAppToken(env) {
  const r = await fetch(`${BASE(env)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "client_credentials",
      client_id: env.EASEMOB_CLIENT_ID,
      client_secret: env.EASEMOB_CLIENT_SECRET,
    }),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("拿应用 token 失败: HTTP " + r.status + " " + t.slice(0, 200));
  }
  const j = await r.json();
  return j.access_token;
}

// 校验"请求的人就是这个账号本人": 优先用用户 token 调 GET /users/{username},
// 成功说明 token 属于该用户; 没 token 时用账号密码登录一次校验。
async function verifyOwner(env, username, userToken, password) {
  if (userToken) {
    const r = await fetch(`${BASE(env)}/users/${encodeURIComponent(username)}`, {
      headers: { Authorization: "Bearer " + userToken },
    });
    return r.ok;
  }
  if (password) {
    const r = await fetch(`${BASE(env)}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "password",
        username,
        password,
      }),
    });
    return r.ok;
  }
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
  const r = await fetch(`${BASE(env)}/users/${encodeURIComponent(username)}`, {
    headers: { Authorization: "Bearer " + appToken },
  });
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
// KV 模型（love-level，变量名 LEVEL_KV）：
//   u:<username> → { bound, xp, ck, msgd, msgc, stitles[], cmail[]（最近 1000 个）, dtitle, updatedAt }
//   ann:<sha256(标题+"\n"+内容)> → { at }（公告去重，60 秒过期）
//   mail:<mail_id> → { kind, amount|title, scope, to, from, createdAt }（v5：发邮件登记，领邮件时验真；不设过期，管理员发的邮件量很小）
//   idem-mail:<idempotency_key> → { mail_id }（v5：发邮件幂等，10 分钟过期）
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

function isValidDateStr(s) {
  return typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

// 把一条 KV 原始 JSON 解析成等级记录；没有/坏了就给一份空的。
// updatedAt（v6）：快照的毫秒时间戳，migrate 合并时取两边较大值存下来；
// 老记录没有这个字段时按 0 处理。
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
    if (Array.isArray(j.stitles)) rec.stitles = j.stitles.filter((t) => typeof t === "string");
    if (Array.isArray(j.cmail)) rec.cmail = j.cmail.filter((t) => typeof t === "string");
    if (typeof j.dtitle === "string") rec.dtitle = j.dtitle;
    if (typeof j.updatedAt === "number" && j.updatedAt >= 0) rec.updatedAt = Math.floor(j.updatedAt);
  } catch { /* 读坏了就按空记录走，不崩 */ }
  return rec;
}

// 读一条等级记录；没有就给一份空的（不写回，等真正改了再写）。
async function levelLoad(env, username) {
  if (!env.LEVEL_KV) return parseLevelRecord(null);
  try {
    const raw = await env.LEVEL_KV.get("u:" + username);
    return parseLevelRecord(raw);
  } catch { return parseLevelRecord(null); }
}

async function levelSave(env, username, rec) {
  if (!env.LEVEL_KV) return;
  await env.LEVEL_KV.put("u:" + username, JSON.stringify(rec));
}

// v5 M-16：KV 没有 CAS/事务，读-改-写并发会丢更新。
// 缓解：改记录的接口都走 levelMutate——读、改、写前再读一次比对，
// 期间有人写过就在新记录上重做一次改动再写。窗口从"整个请求"
// （含环信密码校验的网络往返）缩到"一次 KV 读 + 一次写"的毫秒级。
// v6 评估结论：彻底修要上 Durable Object（当锁或当账本），改动面大、
// 还要搬 live 数据，风险不可控，而实际伤害只是偶丢一次 +2/+4 XP；
// 选 (a) 保留本缓解，M-16 记为“已知窄窗口、未彻底修”，详见文件头 v6。
// fn(rec) 是纯改动：改 rec 的字段；返回 null 表示成功，返回错误字符串
// 表示本次改动不成立（如已签到/已领过），此时不写回。
// 返回 { ok: true, rec }（写回后的记录）或 { ok: false, error }。
async function levelMutate(env, username, fn) {
  const raw1 = await env.LEVEL_KV.get("u:" + username);
  let rec = parseLevelRecord(raw1);
  let err = fn(rec);
  if (err) return { ok: false, error: err };
  const raw2 = await env.LEVEL_KV.get("u:" + username);
  if (raw2 !== raw1) {
    rec = parseLevelRecord(raw2);
    err = fn(rec);
    if (err) return { ok: false, error: err };
  }
  await levelSave(env, username, rec);
  return { ok: true, rec };
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
async function levelVerify(env, body) {
  const username = (body.username || "").trim();
  const password = body.password || "";
  if (!username || !password) return null;
  if (!requireEasemobSecrets(env)) return null;
  try {
    const ok = await verifyOwner(env, username, null, password);
    return ok ? username : null;
  } catch {
    return null;
  }
}

// 管理员校验：用 app token 调环信 GET /chatgroups/{group_id}，owner 必须是本人。
async function levelVerifyGroupOwner(env, appToken, groupId, username) {
  const r = await fetch(`${BASE(env)}/chatgroups/${encodeURIComponent(groupId)}`, {
    headers: { Authorization: "Bearer " + appToken },
  });
  if (!r.ok) return false;
  try {
    const j = await r.json();
    const data = j.data;
    const owner = data && typeof data === "object" && !Array.isArray(data)
      ? data.owner
      : (Array.isArray(data) && data[0] ? data[0].owner : j.owner);
    return owner === username;
  } catch {
    return false;
  }
}

// 用 app token 调环信发消息（1:1 或群聊），ext 原样带过去。
async function levelSendEasemobMessage(env, appToken, targetType, target, body, from, ext) {
  const payload = {
    target_type: targetType,
    target: [target],
    msg: { type: "txt", msg: body },
    from: from,
  };
  if (ext && Object.keys(ext).length > 0) payload.ext = ext;
  const r = await fetch(`${BASE(env)}/messages`, {
    method: "POST",
    headers: { Authorization: "Bearer " + appToken, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error("环信发消息失败: HTTP " + r.status + " " + t.slice(0, 200));
  }
  return r.json();
}

async function levelSha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// v6 M-28：双设备迁移合并。服务器已有记录时不再直接丢弃后迁的快照，
// 而是按字段合并，返回合并后的记录：
//   xp 取两边较大值；ck 取较晚的日期（YYYY-MM-DD 字符串直接比大小）；
//   msgd/msgc 取 msgd 较晚的那份（相等取 msgc 较大值）；
//   stitles 取并集去重；cmail 取并集去重、留最近 1000 个；
//   dtitle 用快照的（如果它在合并后的 stitles 里），否则保留服务器的；
//   bound 用快照的（如果非空），否则保留服务器的（解绑走 /level/unbind
//     直接清服务器，快照里 bound 为空只是旧缓存，不是解绑意图）；
//   updatedAt 取两边较大值。
// 合并是幂等的：同一份快照迁两次，结果不变。
function levelMergeMigrateRecords(server, snap) {
  const merged = {
    bound: snap.bound ? snap.bound : server.bound,
    xp: Math.max(server.xp, snap.xp),
    ck: snap.ck > server.ck ? snap.ck : server.ck,
    msgd: "",
    msgc: 0,
    stitles: [],
    cmail: [],
    dtitle: "",
    updatedAt: Math.max(server.updatedAt || 0, snap.updatedAt || 0),
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
    : server.dtitle;
  return merged;
}

// ---------- /level/* 各接口（body 已解析好） ----------
async function handleLevelRequest(env, path, body) {
  if (!env.LEVEL_KV) {
    return json({ ok: false, error: "Worker 还没配好等级数据（LEVEL_KV 未绑定）" }, 500);
  }

  // ----- POST /level/checkin：每日签到 +4 XP -----
  if (path === "/checkin") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const d = serverDateInTz();
    if (!d) return json({ ok: false, error: "服务器日期算不出来" }, 400);
    if (typeof body.today === "string" && body.today !== d) {
      return json({ ok: false, error: "日期对不上，请检查手机时间" }, 400);
    }
    const r = await levelMutate(env, username, (rec) => {
      if (rec.ck === d) return "今天已经签到过了";
      rec.xp += LEVEL_CHECKIN_XP;
      rec.ck = d;
      return null;
    });
    if (!r.ok) return json({ ok: false, error: r.error });
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
    if (typeof body.today === "string" && body.today !== d) {
      return json({ ok: false, error: "日期对不上，请检查手机时间" }, 400);
    }
    const rec = await levelLoad(env, username);
    if (!rec.bound) return json({ ok: false, error: "还没有绑定情侣" });
    const partner = await levelLoad(env, rec.bound);
    if (partner.bound !== username) return json({ ok: false, error: "还没有绑定情侣" });
    // counted 在闭包里：fn 可能因重试跑两次，每次开头先清零，
    // 最终值以实际写回的那次为准。
    let counted = false;
    const r = await levelMutate(env, username, (m) => {
      counted = false;
      if (m.msgd !== d) { m.msgd = d; m.msgc = 0; }
      if (m.msgc < LEVEL_MESSAGE_DAILY_MAX) {
        m.msgc += 1;
        m.xp += LEVEL_MESSAGE_XP;
        counted = true;
      }
      return null;
    });
    if (!r.ok) return json({ ok: false, error: r.error });
    const total = r.rec.xp + partner.xp;
    const level = levelForXp(total);
    return json({ ok: true, xp: r.rec.xp, totalXp: total, level: level, title: levelTitleFor(level), counted: counted });
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
    if (mail.scope === "one" && mail.to && mail.to !== username) return json({ ok: false, error: "这封邮件不是发给你的" });
    const r = await levelMutate(env, username, (rec) => {
      if (rec.cmail.indexOf(mailId) !== -1) return "已经领过了";
      if (kind === "xp") {
        rec.xp += Math.floor(amount);
      } else {
        if (rec.stitles.indexOf(title) === -1) rec.stitles.push(title);
      }
      rec.cmail.push(mailId);
      if (rec.cmail.length > LEVEL_MAX_CLAIMED_MAIL_IDS) {
        rec.cmail = rec.cmail.slice(rec.cmail.length - LEVEL_MAX_CLAIMED_MAIL_IDS);
      }
      return null;
    });
    if (!r.ok) return json({ ok: false, error: r.error });
    const rec = r.rec;
    const total = await levelCoupleTotal(env, rec, username);
    const level = levelForXp(total);
    return json({ ok: true, xp: rec.xp, totalXp: total, level: level, title: levelTitleFor(level), titles: rec.stitles });
  }

  // ----- POST /level/send-mail：管理员发邮件（服务器验管理员身份） -----
  if (path === "/send-mail") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const groupId = (body.group_id || "").trim();
    const scope = body.scope;
    const to = (body.to || "").trim();
    const kind = body.kind;
    const amount = body.amount;
    const title = (body.title || "").trim();
    const note = (body.note || "").trim();
    // v5 M-13：可选幂等键（app v10.1 开始传，UUID；重试时复用同一把 key）。
    const idemKey = typeof body.idempotency_key === "string" ? body.idempotency_key.trim().slice(0, 128) : "";
    if (!groupId) return json({ ok: false, error: "缺少 group_id" }, 400);
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
    if (!requireEasemobSecrets(env)) {
      return json({ ok: false, error: "Worker 还没配好密钥" }, 500);
    }
    try {
      const appToken = await getAppToken(env);
      const isAdmin = await levelVerifyGroupOwner(env, appToken, groupId, username);
      if (!isAdmin) return json({ ok: false, error: "只有管理员可以发邮件" }, 403);
      // v5 M-13：同 key 10 分钟内重试，直接返回原来那封，不再重发。
      if (idemKey) {
        const priorRaw = await env.LEVEL_KV.get("idem-mail:" + idemKey);
        if (priorRaw) {
          try {
            const prior = JSON.parse(priorRaw);
            if (prior && prior.mail_id) return json({ ok: true, mail_id: prior.mail_id, replayed: true });
          } catch { /* 坏记录就继续正常发 */ }
        }
      }
      const mailId = crypto.randomUUID();
      // v5 B-2：先把邮件登记进 KV 再发消息——发完响应丢了，收件人仍能凭
      // mail_id 领到；若发消息失败，记录只是孤儿（mail_id 是随机 UUID，
      // 没人猜得到），无害。
      const mailRecord = { kind: kind, scope: scope, from: username, createdAt: Date.now() };
      if (kind === "xp") mailRecord.amount = Math.floor(amount);
      if (kind === "title") mailRecord.title = title;
      if (scope === "one") mailRecord.to = to;
      await env.LEVEL_KV.put("mail:" + mailId, JSON.stringify(mailRecord));
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
      if (scope === "all") {
        await levelSendEasemobMessage(env, appToken, "chatgroups", groupId, msgBody, username, ext);
      } else {
        await levelSendEasemobMessage(env, appToken, "users", to, msgBody, username, ext);
      }
      // v5 M-13：发成功后记下幂等键（10 分钟过期）。
      if (idemKey) {
        try {
          await env.LEVEL_KV.put("idem-mail:" + idemKey, JSON.stringify({ mail_id: mailId }), { expirationTtl: 600 });
        } catch { /* 记幂等键失败不影响已发出的邮件 */ }
      }
      return json({ ok: true, mail_id: mailId });
    } catch (e) {
      return json({ ok: false, error: "发邮件时出错: " + e.message }, 500);
    }
  }

  // ----- POST /level/send-announcement：管理员发公告（验身份 + 60 秒去重） -----
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
    try {
      const appToken = await getAppToken(env);
      const isAdmin = await levelVerifyGroupOwner(env, appToken, groupId, username);
      if (!isAdmin) return json({ ok: false, error: "只有管理员可以发公告" }, 403);
      const hash = await levelSha256Hex(title + "\n" + content);
      const dupKey = "ann:" + hash;
      const dup = await env.LEVEL_KV.get(dupKey);
      if (dup) return json({ ok: false, error: "不要重复发送" });
      await env.LEVEL_KV.put(dupKey, JSON.stringify({ at: Date.now() }), { expirationTtl: 60 });
      await levelSendEasemobMessage(env, appToken, "chatgroups", groupId, "[公告]" + title + "\n" + content, username, null);
      return json({ ok: true });
    } catch (e) {
      return json({ ok: false, error: "发公告时出错: " + e.message }, 500);
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
      const healed = await levelMutate(env, username, (r) => { r.bound = ""; return null; });
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
    if (!other || !/^[a-z][a-z0-9_-]{0,63}$/.test(other)) return json({ ok: false, error: "对方用户名不对" }, 400);
    const rec = await levelLoad(env, other);
    if (!rec.bound) return json({ ok: true, bound: false });
    const total = await levelCoupleTotal(env, rec, other);
    const level = levelForXp(total);
    return json({ ok: true, bound: true, level: level, title: levelTitleFor(level), totalXp: total });
  }

  // ----- POST /level/migrate：首次把手机 EXT 里的等级快照迁到服务器 -----
  // v6 M-28：服务器已有记录时不再先写者胜直接返回，而是按字段合并
  // 后迁的快照（见 levelMergeMigrateRecords），写回并返回合并后记录；
  // 没有记录时照旧写快照（把 updatedAt 也存下来）。
  // 请求体可带 updatedAt（数字，毫秒时间戳；app 发 System.currentTimeMillis()）。
  if (path === "/migrate") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const ext = body.ext && typeof body.ext === "object" ? body.ext : {};
    const rec = { bound: "", xp: 0, ck: "", msgd: "", msgc: 0, stitles: [], cmail: [], dtitle: "", updatedAt: 0 };
    if (typeof ext.bound === "string") rec.bound = ext.bound;
    if (typeof ext.xp === "number" && ext.xp >= 0) rec.xp = Math.floor(ext.xp);
    if (isValidDateStr(ext.ck)) rec.ck = ext.ck;
    if (isValidDateStr(ext.msgd)) rec.msgd = ext.msgd;
    if (typeof ext.msgc === "number" && ext.msgc >= 0) rec.msgc = Math.floor(ext.msgc);
    if (Array.isArray(ext.stitles)) rec.stitles = ext.stitles.filter((t) => typeof t === "string");
    if (Array.isArray(ext.cmail)) rec.cmail = ext.cmail.slice(-LEVEL_MAX_CLAIMED_MAIL_IDS).filter((t) => typeof t === "string");
    if (typeof ext.dtitle === "string") rec.dtitle = ext.dtitle;
    if (typeof body.updatedAt === "number" && body.updatedAt >= 0) rec.updatedAt = Math.floor(body.updatedAt);
    const existingRaw = await env.LEVEL_KV.get("u:" + username);
    if (existingRaw) {
      try {
        const existing = parseLevelRecord(existingRaw);
        const merged = levelMergeMigrateRecords(existing, rec);
        await levelSave(env, username, merged);
        return json({ ok: true, migrated: false, merged: true, record: merged });
      } catch { /* 坏记录就按没有处理，继续写快照 */ }
    }
    await levelSave(env, username, rec);
    return json({ ok: true, migrated: true, record: rec });
  }

  // ----- POST /level/bind：把绑定写进服务器 KV（v5 补 B-1） -----
  // 触发：app 在绑定接受成功后调（v10.1 起）；只验对方用户名格式，
  // 不验对方是否存在/是否指回我——get-couple 的双向校验会兜底
  // （对方不指回我就自愈清掉）。
  if (path === "/bind") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const partner = (body.partner || "").trim();
    if (!partner || partner === username) return json({ ok: false, error: "对方用户名不对" }, 400);
    if (!/^[a-z][a-z0-9_-]{0,63}$/.test(partner)) return json({ ok: false, error: "对方用户名不对" }, 400);
    const r = await levelMutate(env, username, (rec) => { rec.bound = partner; return null; });
    if (!r.ok) return json({ ok: false, error: r.error });
    return json({ ok: true, bound: partner });
  }

  // ----- POST /level/unbind：解绑（等级清零，特殊称号保留） -----
  if (path === "/unbind") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    let partnerName = "";
    const r = await levelMutate(env, username, (rec) => {
      partnerName = rec.bound;
      rec.bound = "";
      rec.xp = 0;
      rec.ck = "";
      rec.msgd = "";
      rec.msgc = 0;
      if (rec.stitles.indexOf(rec.dtitle) === -1) rec.dtitle = "";
      return null;
    });
    if (!r.ok) return json({ ok: false, error: r.error });
    if (partnerName) {
      const partner = await levelLoad(env, partnerName);
      if (partner.bound === username) {
        partner.bound = "";
        await levelSave(env, partnerName, partner);
      }
    }
    return json({ ok: true });
  }

  return json({ ok: false, error: "不支持的 level 接口" }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return json({ ok: true });
    const url = new URL(request.url);
    if (request.method !== "POST") {
      return json({ ok: false, error: "只支持 POST" }, 404);
    }

    // ---------- POST /level/*：情侣等级/经验/签到/邮件（v4） ----------
    // 路径可带 /level 前缀也可不带（代理会去掉前缀再转发，两种都认）。
    let levelPath = url.pathname;
    if (levelPath.startsWith("/level/")) levelPath = levelPath.slice("/level".length);
    if (levelPath === "/checkin" || levelPath === "/add-xp" || levelPath === "/claim-mail"
      || levelPath === "/send-mail" || levelPath === "/send-announcement"
      || levelPath === "/get-couple" || levelPath === "/get-other" || levelPath === "/migrate" || levelPath === "/unbind"
      || levelPath === "/bind") {
      let levelBody;
      try {
        levelBody = await request.json();
      } catch {
        return json({ ok: false, error: "请求体不是 JSON" }, 400);
      }
      return await handleLevelRequest(env, levelPath, levelBody);
    }

    // ---------- POST /stats: 用户统计 (管理员工具) ----------
    if (url.pathname === "/stats") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "请求体不是 JSON" }, 400);
      }
      if (!verifyAdminKey(env, body)) {
        return json({ ok: false, error: "管理员密钥不对" }, 403);
      }
      if (!requireEasemobSecrets(env)) {
        return json({ ok: false, error: "Worker 还没配好密钥" }, 500);
      }
      try {
        const appToken = await getAppToken(env);
        // 免费版最多 100 个账号, 一页 limit=100 就全拿到了。
        const r = await fetch(`${BASE(env)}/users?limit=100`, {
          headers: { Authorization: "Bearer " + appToken },
        });
        if (!r.ok) {
          const t = await r.text();
          return json({ ok: false, error: "环信查用户失败: HTTP " + r.status + " " + t.slice(0, 200) }, 502);
        }
        const j = await r.json();
        const list = Array.isArray(j.entities) ? j.entities : [];
        const total = list.length;
        return json({ ok: true, total: total, limit: USER_LIMIT, remaining: Math.max(0, USER_LIMIT - total) });
      } catch (e) {
        return json({ ok: false, error: "查用户统计时出错: " + e.message }, 500);
      }
    }

    // ---------- POST /admin-delete: 管理员帮别人删号 ----------
    if (url.pathname === "/admin-delete") {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, error: "请求体不是 JSON" }, 400);
      }
      const username = (body.username || "").trim();
      if (!username) return json({ ok: false, error: "缺少 username" }, 400);
      if (!verifyAdminKey(env, body)) {
        return json({ ok: false, error: "管理员密钥不对" }, 403);
      }
      if (!requireEasemobSecrets(env)) {
        return json({ ok: false, error: "Worker 还没配好密钥" }, 500);
      }
      // M10：上次删成功但 app 没收到结果，重试直接返回成功。
      const replayed = await idemReplay(env, "adel", username);
      if (replayed) return json(replayed);
      try {
        const appToken = await getAppToken(env);
        const r = await fetch(`${BASE(env)}/users/${encodeURIComponent(username)}`, {
          method: "DELETE",
          headers: { Authorization: "Bearer " + appToken },
        });
        if (!r.ok) {
          const t = await r.text();
          return json({ ok: false, error: "环信删号失败: HTTP " + r.status + " " + t.slice(0, 200) }, 502);
        }
        await idemPut(env, "adel", username, { ok: true, deleted: username });
        return json({ ok: true, deleted: username });
      } catch (e) {
        return json({ ok: false, error: "删号时出错: " + e.message }, 500);
      }
    }

    // ---------- POST /delete-account: 用户自己注销 (v1 原样, 一字未动) ----------
    if (url.pathname !== "/delete-account") {
      return json({ ok: false, error: "只支持 POST /delete-account、/stats、/admin-delete、/level/*" }, 404);
    }
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, error: "请求体不是 JSON" }, 400);
    }
    const username = (body.username || "").trim();
    if (!username) return json({ ok: false, error: "缺少 username" }, 400);
    if (!requireEasemobSecrets(env)) {
      return json({ ok: false, error: "Worker 还没配好密钥" }, 500);
    }

    // M10：上次删成功但 app 没收到结果，重试直接返回成功。
    // （放在身份校验之前：用户已被删掉时，密码/token 校验本来就会失败。）
    const replayed = await idemReplay(env, "del", username);
    if (replayed) return json(replayed);

    // 1. 校验本人 (防别人乱删号)
    let ok = false;
    try {
      ok = await verifyOwner(env, username, body.userToken, body.password);
    } catch (e) {
      return json({ ok: false, error: "校验身份时出错: " + e.message }, 500);
    }
    if (!ok) return json({ ok: false, error: "身份校验失败, 只能注销自己的账号" }, 403);

    // 2. 应用 token + 删服务器上的账号
    try {
      const appToken = await getAppToken(env);
      const r = await fetch(`${BASE(env)}/users/${encodeURIComponent(username)}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer " + appToken },
      });
      if (!r.ok) {
        const t = await r.text();
        return json({ ok: false, error: "环信删号失败: HTTP " + r.status + " " + t.slice(0, 200) }, 502);
      }
      await idemPut(env, "del", username, { ok: true, deleted: username });
      return json({ ok: true, deleted: username });
    } catch (e) {
      return json({ ok: false, error: "删号时出错: " + e.message }, 500);
    }
  },
};
