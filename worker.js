// 我们的爱情 - 真注销后端 (Cloudflare Worker) v14
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
//     /level/check-deleted    批量查环信账号是否已被注销 (供大厅“已注销用户”标记用, v13 新增)
//     /level/record-recall    1:1 撤回成功后登记一条 (供对方下次进聊天页补删, v14 新增)
//     /level/get-recalls      1:1 聊天页查对方撤回过我哪些消息 (v14 新增)
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
// v11 (2026-11-11) 审计 v10.8.1-full 的 Worker 16 条全修 + 新功能：
//   W-B1: /level/migrate 称号白名单改按“合并后实际 XP 对应的等级”算，
//         不再按 xpCap 算。xpCap 的经验上限公式本身不动
//         (12×天数 + 邮件XP + 10000，超限拒绝），只改白名单口径；
//         白名单 = 合并后 XP 对应等级及以下的 LV.1–N 称号 + 邮件登记表里的称号。
//         DO 内二次过滤沿用同一份白名单（handler 算好传进去）。
//   W-B2: 公告群 id 钉死 (group pinning)：钉死的 id 存在 LEVEL_KV
//         ("announce-group-pin")；首次运行时按名查找并写入 KV；之后每次
//         优先用钉死的 id 调群详情校验（群名必须仍是“我们的爱情-系统公告”），
//         查不到钉死的 id 或群名对不上时直接报错，绝不回落到“第一个同名群”；
//         首次按名查找时若发现多个同名群也拒绝认领（fail closed）。
//         send-mail 与 send-announcement 两处同 pin（都走 findAnnouncementGroup）。
//         群重建时处理：管理员在 Easemob 控制台建好新群后，删掉 LEVEL_KV 里
//         的 announce-group-pin 键，下一次请求会按名重新查找并钉死新 id。
//   W-M3: DO 内跨 DO 读伴侣记录加 2 秒短超时 (AbortController)，超时/失败
//         时以外层 handler 的校验为准，不再环形等待到整个请求超时。
//   W-M4: /admin-delete 加限流（每 IP 10 次/分钟，与 /stats 同款）。
//   W-M5: 限流仍是进程内“尽力而为”（isolate 重启即清零，多 isolate 下放宽 N 倍，
//         见 rateLimitOk 注释）；经 InstaBox 代理时 /stats 的桶仍由全部代理
//         用户共享——代理只透传 Content-Type/Content-Length，不传真实客户端 IP
//         (server.js proxyToWorker)，Worker 侧无法可信分桶，残留见汇报；
//         level/删号按 IP+用户名分桶，不受此影响。
//   W-M6: 全部 (body.xxx || "").trim() 改成 strField 类型校验：非字符串
//         字段返回 400/403，不再抛 TypeError → JSON 500。
//   W-M7: send-mail 改成“先记键后发 + 失败补偿”：先在 KV 登记 mail 记录，
//         再发环信消息；发送失败删登记、释放幂等占位；发送成功后写
//         idem-mail-rec 登记 + confirm 幂等键；重试时先查 idem 登记，
//         第一次发送成功但 confirm 丢失时直接重放，不再发第二封。
//         残留窗口见 send-mail 注释（需“发送成功 + confirm 丢 + 登记写失败
//         三连败 + 60 秒后重试”才可能重复）。
//   W-M8: /level/send-announcement 标题 ≤50 字、内容 ≤2000 字（超限 400）；
//         去重键加上群 id。
//   W-M9: /level/bind 的对方校验移进 DO 内二次校验（bind op 的 checkPartner）：
//         对方已绑别人时 DO 内拒绝；myRec.bound === partner 的提前返回分支
//         也验对方回指。
//   W-M10: 不改 token 路径（等测试账号实测定级）。verifyUserTokenOwner 注释
//         已写清假设与风险：二次核对成立的前提是“环信 user token GET 他人
//         资料会 403 或只返回本人资料”，官方文档未证实；若实测为“任一合法
//         token 可读任意用户资料”，该核对为空校验，任意登录用户可删任意账号。
//   W-P2: ADMIN_KEY 比较改成恒定时间比较 (timingSafeEqual)。
//   新功能 (用户 2026-11-11 批准): /level/send-announcement 接受
//     {admin_key, title, content}：admin_key 复用 checkAdminKey 校验
//     (fail closed，失败 403)，通过后跳过密码验证和群主身份验证，直接以
//     管理员身份发到 pinning 的公告群（from 用群主账号）；60 秒去重、群组
//     锁定等现有逻辑不变；密钥值不写进代码或日志。
//
// v12 (2026-11-12) 审计 v10.8.6-full 的 Worker 12 条全修（W-M3 彻底修、
//   W-M4 按用户决定修、W-M10 测试账号实测，见下）：
//   W-M1: 公告去重命中改回 {ok:true, replayed:true}，与 send-mail 一致
//         （旧版 {ok:false, error:"不要重复发送"}，调用方只能按文案区分成败）。
//   W-M2: checkin / claim-mail 的 levelCoupleTotal 加 try/catch 兜底
//         （照抄 add-xp 的写法）：伴侣 DO 读失败时用本人 xp 算总分，
//         已落盘的签到/领邮件不再被报成 500。
//   W-M3: /delete-account 的幂等重放移到 verifyOwner 之后（与 /admin-delete
//         对称），不再凭用户名裸探“该账号刚被删”；并彻底修掉该移动的
//         副作用（用户 2026-11-12 不接受“合法重试也 403”的取舍）：
//         删成功时把请求体里实际给出的凭证（token 和/或密码）各存一份
//         SHA-256 哈希进幂等记录（只存哈希，绝不存明文）；校验失败时先
//         凭旧凭证哈希比对重放——合法重试（app 存着同一份凭证）能成功，
//         探测者只凭用户名拿不出凭证、哈希比对失败仍 403；重放前仍先验
//         “用户已不在环信上”，同名新账号不受旧记录影响。详见
//         idemReplayWithCred 注释（为什么能同时满足两点）。
//   W-M4: 换绑经验清零（用户决定 2026-11-12）：DO bind op 里，之前绑定过
//         别人（rec.bound 非空）且本次绑的是不同的人时，本人 XP 清零、
//         等级称号随之收回，邮箱授予的特殊称号 stitles/dtitle 不动；
//         首次绑定与绑回同一人不触发；回包透传 xpReset 给 app。
//         unbind 本来就清零，“分手后直接换绑”与“先解绑再绑”结果一致。
//   W-M5: fetchGroupInfo 的 owner 加备用字段名 fallback
//         （owner → owner_username → group_owner，照抄 groupname 的
//         groupname→name 两级 fallback 写法）。
//   W-M6: /stats 也认 j.data 形状（与 findAnnouncementGroup 的群列表解析
//         同款，entities/data 两种形状都认）。
//   W-M11: admin_key 与密码同时出现时改回 400，要求只传一种（旧版 admin_key
//         优先、错 key + 对密码也回 403“管理员密钥不对”，语义不明）。
//   W-M12: 公告改成 send-mail 的“先记键后发 + 失败补偿”：发送成功后写
//         idem-ann-rec KV 登记（10 分钟 TTL）+ confirm 幂等键；重试时先查
//         登记，第一次发送成功但 confirm 丢失时直接重放，不再发第二条。
//         残留窗口与 send-mail 同款（登记写失败 + confirm 丢 + 10 分钟后重试）。
//   W-P1: 公告标题/内容长度按码点计数（[...str].length），emoji 只算 1 位。
//   W-P2: level 限流桶按端点分组拆开：get-couple 单独一桶，checkin/add-xp
//         另一桶，其余 level 接口仍共用原桶——get-couple 轮询不再挤占签到/加分。
//   W-P3: GET 任意路径回 405（Method Not Allowed），其余方法保持 404。
//   W-M10 已实测（2026-11-12，测试账号，绝未用真账号）：删号 token 路径
//         依赖的假设成立，且比 403 更严——同一 user token GET 本人资料 200，
//         GET 他人资料 401（EasemobSecurityException / unauthorized，
//         两组独立账号对均复现）。结论：token 路径安全，不改；二次核对留作
//         纵深防御。详见 verifyUserTokenOwner 注释。
//
// v13 (2026-11-12) 新功能：POST /level/check-deleted（批量查账号是否已注销，
//   供大厅“已注销用户”标记用）：
//   为什么必须走服务端：消息本身分不清发送者是被删号还是被移出大厅
//   （两种情况在成员列表里都“不在”），LEVEL_KV 里的等级记录在删号后
//   仍保留，/level/get-other 也分不出来；唯一可信的判据是服务端用
//   app token 问环信 GET /users/{用户名}。
//   调用方须先过 levelVerify（username+password，与其余 level 接口
//   同款），匿名请求直接 403——存在性查询不能做成匿名口子（防用户名
//   枚举）；限流走 handleLevelRequestInner 开头的通用桶（lv: 每 IP+
//   用户名 30 次/分钟，与其余 level 接口同款）。
//   请求体 { username, password, usernames: [...] }，usernames 最多
//   50 个，超限 400；非字符串/空串/重复项跳过（不整批失败）。
//   逐个用 app token 查：200 = 还在（不返回），404 = 已注销（进
//   deleted），其余状态/网络失败进 unknown——绝不在不确定时判已注销
//   （fail closed：401/403/5xx 都只算 unknown）。返回
//   { ok:true, deleted:[...], unknown:[...] }。
//   删号成功后同名新账号再注册时 GET 返回 200，旧删除记录不影响判定。
//
// v14 (2026-11-12) 新功能：POST /level/record-recall + /level/get-recalls
//   （1:1 撤回兜底——撤回 CMD 是一次性信号，对方 App 被系统杀掉或手机关机
//   时永远收不到，对方手机上的消息就一直不消失；撤回成功后发送方还在
//   服务器登记一条，对方下次进 1:1 聊天页问服务器就能补删）:
//   记录存在 LEVEL_KV：键 recalls:<收件人>:<发送人>，值是 [{id, at}]（按
//   撤回时间升序，最多 500 条，超了丢最旧的；超过 7 天的条目在读写时
//   懒清理）。注意是“发送人撤回了发给收件人的消息”，get 时收件人是调
//   用者本人、发送人是 body.peer；record 时收件人是 body.peer、发送人
//   是调用者本人——两边别弄反。
//   失败安全：记录是“至少一次”的兜底，不是精确一次——get 是纯读（只清
//   7 天以上的过期条目），绝不因“已返回过”就删记录；app 读到后删本地
//   失败了，下次进页还会再给一次。TTL 7 天是上限（7 天内对方总会开一次
//   聊天页；7 天还没读到的记录丢了也认——再老的撤回基本没人会翻）。
//   调用方须先过 levelVerify（username+password，与其余 level 接口
//   同款），匿名请求直接 403；限流走 handleLevelRequestInner 开头的
//   通用桶（lv: 每 IP+用户名 30 次/分钟，与其余 level 接口同款）。
//   record 请求体 { username, password, peer, msgId }，peer 须是合法
//   用户名且不能是自己，msgId 非空且 ≤128 字符（不合规 400）；成功
//   { ok:true }，重复登记同一条直接返回 ok（幂等，不重复记）。
//   get 请求体 { username, password, peer }，peer 须是合法用户名
//   （不合规 400）；成功 { ok:true, msgIds:[...] }，没有记录时空数组。
//   两个接口只认 1:1 聊天——大厅撤回走群 CMD 广播，不走这套记录。
//   （KV 读-改-写有小竞态：同一对用户同时撤回两条时，后写可能覆盖先写
//   的一条；1:1 撤回是人手一个一个点的，并发窗口极小，接受；record 写
//   失败时返回 500 让 app 知道——app 本来就是静默 best-effort。)
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
// v11 W-M5 残留（改不掉，写清）：(a) 计数存在各 isolate 的内存里，isolate
// 重启/扩容即清零，多 isolate 下限流是 N 倍放宽；(b) 经 InstaBox 代理访问
// 时，Cloudflare 看到的 CF-Connecting-IP 是 InstaBox 单一出口 IP，/stats
// 10/min 由全部代理用户共享——一个人打满就让其他人连带 429。代理侧无法
// 改：server.js 的 proxyToWorker 只透传 Content-Type/Content-Length，
// 不传 X-Forwarded-For 或任何客户端标识；Worker 侧若改信 X-Forwarded-For，
// 直接调 workers.dev 的调用方可以任意伪造该头、每请求换一个 IP 绕过限流，
// 比共享桶更糟，所以不改。level/删号按 IP+用户名分桶，不受此影响；
// /stats 只有管理员一人调，影响极小；/check 30/min 共享是剩余敞口，
// 接受（按码分桶会削弱防猜，不做）。
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

// v11 W-M6: 取 JSON 字符串字段——是字符串才 trim，非字符串（数字/数组/
// 对象/null/缺失）返回 null，调用方回 400/403；不再用
// (body.xxx || "").trim() 直接抛 TypeError → JSON 500。
function strField(body, name) {
  if (!body || typeof body !== "object") return null;
  const v = body[name];
  return typeof v === "string" ? v.trim() : null;
}

// v11 W-P2: 恒定时间比较——逐字节异或累加再判；循环恒定跑
// max(len) 次，不因“第几位不同”提前返回；两端长度不同时也一样
// 跑满循环（长度差只进初始 diff，不影响循环次数之外的时序）。
// 注意：比较耗时仍随 max(len) 变化，但不泄露“前几位是否相同”。
function timingSafeEqual(a, b) {
  const sa = typeof a === "string" ? a : "";
  const sb = typeof b === "string" ? b : "";
  const ba = new TextEncoder().encode(sa);
  const bb = new TextEncoder().encode(sb);
  const max = Math.max(ba.length, bb.length);
  let diff = ba.length ^ bb.length;
  for (let i = 0; i < max; i++) {
    const x = i < ba.length ? ba[i] : 0;
    const y = i < bb.length ? bb[i] : 0;
    diff |= x ^ y;
  }
  return diff === 0;
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

// v12 W-M10（已实测，2026-11-12，测试账号 wmm10test1/2 与 wmm10ctl1/2，
//   绝未用真账号）：假设成立，且比原假设的 403 更严——
//   同一 user token GET 本人资料返回 200（entities[0].username = 本人）；
//   GET 他人资料返回 401 {exception:"EasemobSecurityException",
//   error:"unauthorized", error_description:"Unable to authenticate (OAuth)"}，
//   两组独立账号对均复现。结论：任一合法 token 不能读任意用户资料，
//   token 路径安全，无需改为“只返回 token 归属的校验”或弃用；下面二次
//   核对（返回体用户名必须等于要删的用户名）继续留作纵深防御。
//   环信侧行为如将来有变（返回体口径变化），二次核对仍会 fail closed。
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
// v11 W-M6: userToken/password 非字符串时按“没给”处理，不直接拼进请求头。
async function verifyOwner(env, username, userToken, password) {
  if (typeof userToken === "string" && userToken) {
    const t = await verifyUserTokenOwner(env, username, userToken);
    if (t.ok) return true;
    // token 失败 (invalid/mismatch)：往下试密码；上游异常时上面已抛错，不会走到这里。
  }
  if (typeof password === "string" && password) return await verifyPassword(env, username, password);
  return false;
}

// 管理员密钥校验: 没配 ADMIN_KEY 就一律拒绝 (fail closed), 对不上也拒绝。
// v11 W-P2: 恒定时间比较；v11 W-M6: admin_key 非字符串直接拒绝，不 trim 抛错。
function verifyAdminKey(env, body) {
  if (!env.ADMIN_KEY) return false;
  const key = strField(body, "admin_key");
  return key !== null && key !== "" && timingSafeEqual(key, env.ADMIN_KEY);
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

// v12 W-M3（彻底修）：凭旧凭证哈希重放删号成功结果。
//   为什么这样能同时满足两点：
//   (a) 合法重试能成功——删号成功后响应丢失，账号已不在环信上，
//       verifyOwner 必然失败；但重试方手里仍是删号时用的那份凭证
//       （app 存着同一份 token/密码），其 SHA-256 与删号成功时存入
//       幂等记录的哈希比对通过，且环信上该用户确实已不存在，就重放
//       成功结果，不再 403。
//   (b) 探测仍被挡住——探测者只知道用户名，拿不出被删账号的旧凭证，
//       哈希比对失败就返回 null（调用方照旧 403），凭用户名裸探与
//       v12 之前一样拿不到任何信息；且重放前仍先验“用户已不在环信上”，
//       同名新账号注册后旧凭证既不能删新号、也不能重放旧结果。
//   凭证只存 SHA-256 哈希（levelSha256Hex，WebCrypto），绝不存明文
//   token/密码；哈希不可逆推不出凭证原文。删号成功时把请求体里实际
//   给出的全部凭证（token 和/或密码）各存一份哈希——请求整体当时已
//   通过 verifyOwner 校验，其中个别没通过的凭证（如 token 对、密码
//   错时密码的哈希）只有看到过该次请求体的人才拿得到，等价于同一
//   个合法客户端重试，不构成新口子。
//   旧版幂等记录（无 credHashes 字段）直接视为不可重放（fail closed）。
//   注意：哈希比对只证明“出示了删号时用过的凭证”，不证明“现在仍是
//   该账号主人”——但重放只返回一个已经发生的删除结果，不做新删除，
//   且用户已不存在，风险等价于“再告诉你一次删成功了”。
async function idemReplayWithCred(env, kind, username, userToken, password) {
  const cached = await idemGet(env, kind, username);
  if (!cached || !cached.ok) return null;
  const stored = Array.isArray(cached.credHashes) ? cached.credHashes : [];
  if (!stored.length) return null; // 旧记录无凭证哈希，不可重放
  const cands = [];
  if (typeof userToken === "string" && userToken) cands.push(await levelSha256Hex(userToken));
  if (typeof password === "string" && password) cands.push(await levelSha256Hex(password));
  let match = false;
  for (const c of cands) {
    for (const s of stored) {
      if (typeof s === "string" && timingSafeEqual(c, s)) { match = true; break; }
    }
    if (match) break;
  }
  if (!match) return null;
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
// v14: 撤回记录保留 7 天、每对用户最多 500 条（见 record-recall 注释）。
const RECALL_TTL_MS = 7 * 24 * 3600 * 1000;
const RECALL_MAX = 500;
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
  // v11 W-M6: username 非字符串直接不通过；password 非字符串按空密码处理。
  const username = strField(body, "username");
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) return null;
  if (!requireEasemobSecrets(env)) return null;
  const ok = await verifyPassword(env, username, password);
  return ok ? username : null;
}

// v11 W-B2: 公告群 id 钉死 (group pinning) 的 KV 键。钉死的 id 存在 LEVEL_KV
// 里；首次运行时按名查找并写入 KV；之后每次优先用钉死的 id 校验。
// 群重建时处理：管理员在 Easemob 控制台建好新群后，删掉 LEVEL_KV 里的
// 这个键，下一次请求会按名重新查找并钉死新 id（首次查找若发现多个同名群
// 则拒绝认领，需先在控制台删掉多余的同名群）。
const ANNOUNCE_GROUP_PIN_KV_KEY = "announce-group-pin";

async function getPinnedAnnounceGroupId(env) {
  if (!env.LEVEL_KV) return "";
  try {
    const v = await env.LEVEL_KV.get(ANNOUNCE_GROUP_PIN_KV_KEY);
    return typeof v === "string" ? v.trim() : "";
  } catch {
    return "";
  }
}

async function setPinnedAnnounceGroupId(env, id) {
  if (!env.LEVEL_KV || !id) return;
  try {
    await env.LEVEL_KV.put(ANNOUNCE_GROUP_PIN_KV_KEY, id);
  } catch (e) {
    console.error("公告群钉死 id 写 KV 失败", id, e);
  }
}

// 用 app token 调环信 GET /chatgroups/{group_id} 取群信息。
// 返回 { id, owner, groupname }；群不存在/无权限返回 null；
// 上游 5xx/网络异常抛 UpstreamError。
async function fetchGroupInfo(env, appToken, groupId) {
  let r;
  try {
    r = await fetch(`${BASE(env)}/chatgroups/${encodeURIComponent(groupId)}`, {
      headers: { Authorization: "Bearer " + appToken },
    });
  } catch (e) {
    console.error("取群信息失败: 网络异常", e);
    throw new UpstreamError("环信服务暂时不可用");
  }
  if (!r.ok) {
    if (r.status >= 500) throw new UpstreamError("环信服务暂时不可用");
    return null;
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
    // v12 W-M5: owner 加备用字段名 fallback（照抄上面 groupname 的
    // groupname→name 两级 fallback 写法）：环信详情某天缺 owner 字段时，
    // 依次试 owner_username / group_owner，仍取不到才按 "" 处理。
    const ow = typeof info.owner === "string" && info.owner
      ? info.owner
      : (typeof info.owner_username === "string" && info.owner_username
        ? info.owner_username
        : (typeof info.group_owner === "string" ? info.group_owner : ""));
    return {
      id: String(groupId),
      owner: ow,
      groupname: gn,
    };
  } catch {
    return null;
  }
}

// 管理员校验：用 app token 调环信 GET /chatgroups/{group_id}，owner 必须是本人。
// 返回 { isOwner, groupname }：groupname 供 /level/send-announcement 校验
// “只能发到系统公告群”（v8）。环信返回的 data 可能是对象也可能是数组，
// owner 和 groupname 都按两种形状取。
// v9 修正：环信群详情接口的群名字段不固定（有的返回 groupname，有的返回
// name），两个都试；取不到群名时返回 ""，调用方不得仅凭 "" 就拦截
// （v8 的教训：只认 groupname 时，取不到就把正确群也 403 了）。
async function levelVerifyGroupOwner(env, appToken, groupId, username) {
  let info;
  try {
    info = await fetchGroupInfo(env, appToken, groupId);
  } catch (e) {
    if (e && e.upstream) throw e;
    console.error("验群主失败", e);
    return { isOwner: false, groupname: "" };
  }
  if (!info) return { isOwner: false, groupname: "" };
  return { isOwner: info.owner === username, groupname: info.groupname };
}

// v10 W-B2: 服务端自己定公告群——用 app token 翻页拉群列表，按名字找
// “我们的爱情-系统公告”。找到返回 { id, owner, groupname }，找不到返回 null。
// 找不到时调用方返回明确错误，不在服务端建群。
// v11 W-B2: 改成 group pinning（见文件头 v11 说明）：
//   ① KV 里有钉死的 id 时，只认该 id——调群详情校验群名仍是公告群名，
//      查不到/群名对不上直接返回 null，不回落到按名查找；
//   ② KV 里没有时按名翻页找，找到唯一一个才钉死并返回；翻页找完发现
//      多个同名群时拒绝认领（返回 null，日志记数），不取第一个。
async function findAnnouncementGroup(env, appToken) {
  const pinnedId = await getPinnedAnnounceGroupId(env);
  if (pinnedId) {
    const info = await fetchGroupInfo(env, appToken, pinnedId);
    // v9 同款原则：群名明确不对才拒绝；取不到群名（""）时放行——钉死的 id
    // 本身就是身份，群名只是二次核对，不因字段缺失把正确群拦掉。
    if (!info || (info.groupname && info.groupname !== ANNOUNCE_GROUP_NAME)) {
      console.error("钉死的公告群 id 查不到或群名不对，拒绝认领", pinnedId, info ? info.groupname : null);
      return null;
    }
    return info;
  }
  const matches = [];
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
        matches.push({
          id: String(g.groupid || g.id || ""),
          owner: typeof g.owner === "string" ? g.owner : "",
          groupname: name,
        });
      }
    }
    cursor = j && typeof j.cursor === "string" ? j.cursor : "";
    if (!cursor) break;
  }
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    console.error("发现多个同名公告群，拒绝认领", matches.map((m) => m.id).join(","));
    return null;
  }
  const found = matches[0];
  if (!found.id) return null;
  await setPinnedAnnounceGroupId(env, found.id);
  return found;
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
  // v11 W-M7: confirm 丢了会导致同一幂等键重试时发第二封，所以失败重试一次；
  // 两次都失败只记日志（调用方不因此报错——邮件本身已登记/已发出，
  // 领邮件走 KV 登记，不依赖 confirm；剩余窗口见 send-mail 注释）。
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await mailGateCall(env, "/confirm", { key, nonce, value: value ?? null });
      return;
    } catch (e) {
      if (attempt === 1) console.error("mail-gate confirm 失败", key, e);
    }
  }
}

async function mailGateRelease(env, key, nonce) {
  try {
    await mailGateCall(env, "/release", { key, nonce });
  } catch (e) {
    console.error("mail-gate release 失败", key, e);
  }
}

// v11 W-M7: KV 写/删重试（瞬时失败不直接判死刑）；attempts 次都失败则抛错。
async function kvRetry(fn, attempts) {
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await fn();
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

// v14: 1:1 撤回记录（LEVEL_KV）。
//   键 recalls:<收件人>:<发送人>，值是 [{id, at}]（按撤回时间升序）。
//   注意方向：record 时收件人是 peer、发送人是调用者；get 时收件人是
//   调用者本人、发送人是 peer——两边别弄反。
//   读：KV 里没有/解析失败 → 空列表（损坏的记录直接丢弃重建，不报错）。
//   写：去重（同一 msgId 只记一次）→ 丢 7 天以上的过期条目 → 超 500
//   条时丢最旧的 → kvRetry 写 3 次。读-改-写有小竞态（同一对用户
//   同时撤回两条时后写可能覆盖先写的一条），1:1 撤回是人手一个一个
//   点的，接受；写失败时抛错，调用方按 500 处理。
function recallKey(recipient, sender) {
  return "recalls:" + recipient + ":" + sender;
}

function pruneRecallList(list) {
  const now = Date.now();
  const kept = [];
  for (const e of list) {
    if (!e || typeof e !== "object" || typeof e.id !== "string" || !e.id) continue;
    if (typeof e.at !== "number" || now - e.at > RECALL_TTL_MS) continue;
    kept.push({ id: e.id, at: e.at });
  }
  while (kept.length > RECALL_MAX) kept.shift();
  return kept;
}

async function readRecallList(env, recipient, sender) {
  let raw = null;
  try {
    raw = await env.LEVEL_KV.get(recallKey(recipient, sender));
  } catch (e) {
    throw e;
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return pruneRecallList(parsed);
  } catch (e) {
    return [];
  }
}

async function appendRecall(env, recipient, sender, msgId) {
  const list = await readRecallList(env, recipient, sender);
  for (const e of list) {
    if (e.id === msgId) return false; // 已登记过：幂等，直接返回
  }
  list.push({ id: msgId, at: Date.now() });
  const pruned = pruneRecallList(list);
  await kvRetry(
    () => env.LEVEL_KV.put(recallKey(recipient, sender), JSON.stringify(pruned)), 3);
  return true;
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

  // v11 W-M3/W-M9: 跨 DO 读伴侣记录（带短超时）。读不到/超时/失败返回 null，
  // 调用方以外层 handler 的校验为准（只在“明确读到对方没指回我”时拒绝），
  // 不让两个 DO 环形等待到整个请求超时。超时 2 秒：DO 内读一次正常在
  // 百毫秒级，2 秒足够，超时即视为对方 DO 正忙、本次不靠它定。
  async loadPartnerRecord(partner, timeoutMs) {
    if (!this.env.LEVEL_STORE || !partner) return null;
    const ms = typeof timeoutMs === "number" && timeoutMs > 0 ? timeoutMs : 2000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    try {
      const pr = await this.env.LEVEL_STORE.get(
        this.env.LEVEL_STORE.idFromName("level:" + partner)
      ).fetch("https://do/load", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: partner }),
        signal: controller.signal,
      });
      if (!pr.ok) return null;
      const pj = await pr.json();
      return parseLevelRecord(JSON.stringify(pj.record || null));
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
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
        // 伴侣记录，确认对方仍指回我。v11 W-M3: 跨 DO 读带 2 秒短超时，
        // 读不到/超时以外层 handler 的校验为准（只在“明确读到对方没指回我”
        // 时拒绝），不因一次读失败把合法的 +2 挡掉，也不再环形等待。
        const prec = await this.loadPartnerRecord(rec.bound, 2000);
        if (prec && prec.bound !== username) return json({ ok: false, error: "还没有绑定情侣" });
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
        // v11 W-M9: 对方校验移进 DO 内二次做——写我方 bound 之前再读一次
        // 对方记录，对方已绑别人时拒绝，堵住“外层校验 → 写入”之间的 TOCTOU
        // 窗口。跨 DO 读带 2 秒短超时（见 loadPartnerRecord），超时/失败时
        // 以外层 handler 的校验为准；双方同时互绑时对方 DO 正忙、读超时，
        // 两边以外层校验为准各自写下互指，结果仍是双向绑定，不死锁。
        if (body.checkPartner) {
          const prec = await this.loadPartnerRecord(body.partner, 2000);
          if (prec && prec.bound && prec.bound !== username) {
            return json({ ok: false, error: "对方已绑定其他人" }, 400);
          }
        }
        // v12 W-M4 (用户决定 2026-11-12：换绑经验清零)：
        //   触发条件只有一种——之前绑定过别人 (rec.bound 非空) 且本次绑的是
        //   不同的人 (rec.bound !== partner)。首次绑定 (rec.bound 为空) 与
        //   绑回同一人 (rec.bound === partner) 都不触发。
        //   清零内容与 unbind 同款：xp/签到/消息计数清零，等级称号随 XP
        //   清零而收回（等级称号由等级推导）；邮箱授予的特殊称号 stitles
        //   与 dtitle 不动（dtitle 若不在 stitles 里才清空，照抄 unbind）。
        //   unbind 本来就清零，所以“分手后直接换绑”与“先解绑再绑”结果一致。
        if (rec.bound && rec.bound !== body.partner) {
          rec.xp = 0;
          rec.ck = "";
          rec.msgd = "";
          rec.msgc = 0;
          if (rec.stitles.indexOf(rec.dtitle) === -1) rec.dtitle = "";
          result = { xpReset: true, prevPartner: rec.bound };
        }
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
  // v12 W-P2: 桶按端点分组拆开——get-couple 单独一桶，checkin/add-xp
  // 另一桶，其余 level 接口仍共用原桶；get-couple 轮询不再挤占签到/加分额度。
  const lvUser = strField(body, "username") || "";
  if (lvUser) {
    const lvBucket = path === "/get-couple" ? "lv-get:"
      : (path === "/checkin" || path === "/add-xp" ? "lv-xp:" : "lv:");
    rateLimitPrune();
    if (!rateLimitOk(lvBucket + clientIp + ":" + lvUser, 30, 60000)) {
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
    // v12 W-M2: levelCoupleTotal 加 try/catch 兜底（照抄 add-xp :1364-1367
    // 的写法）：伴侣 DO 读失败时只算本人 xp，不把已落盘的签到报成 500。
    let total = rec.xp;
    try {
      total = await levelCoupleTotal(env, rec, username);
    } catch {
      total = rec.xp;
    }
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
    // v11 W-M6: mail_id/title 非字符串直接 400，不 trim 抛错。
    const mailId = strField(body, "mail_id");
    const kind = body.kind;
    if (!mailId) return json({ ok: false, error: "缺少 mail_id" }, 400);
    if (kind !== "xp" && kind !== "title") return json({ ok: false, error: "邮件类型不对" }, 400);
    const amount = body.amount;
    const title = strField(body, "title") || "";
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
    // v12 W-M2: 与 checkin 同款兜底——伴侣 DO 读失败时只算本人 xp，
    // 不把已落盘的领邮件报成 500。
    let total = rec.xp;
    try {
      total = await levelCoupleTotal(env, rec, username);
    } catch {
      total = rec.xp;
    }
    const level = levelForXp(total);
    return json({ ok: true, xp: rec.xp, totalXp: total, level: level, title: levelTitleFor(level), titles: rec.stitles });
  }

  // ----- POST /level/send-mail：管理员发邮件（服务器验管理员身份） -----
  // v10 W-B2: 管理员身份只认“服务端自己查到的公告群的群主”——
  // 用 app token 按名字找公告群，调用者必须是那个群的群主；邮件发到服务端
  // 查到的那个群 id，客户端传的 group_id 忽略（旧版只认“任意群的群主”，
  // 任一用户自建一个群就能铸造 10000 XP/任意称号邮件再发给自己）。
  // v11 W-B2: findAnnouncementGroup 已做 group pinning，见文件头。
  // v11 W-M7: 顺序改成“先记键后发 + 失败补偿”，不再是 v10 的“先发后记键”：
  //   ① 先在 KV 登记 mail 记录（写失败直接 500，什么都没发，没有幽灵邮件）；
  //   ② 再发环信消息；发送失败删登记、释放幂等占位，重试生成新 mail_id；
  //   ③ 发送成功后写 idem-mail-rec 登记（10 分钟 TTL）+ confirm 幂等键。
  //   重试时先查 idem 登记：第一次发送成功但 confirm 丢失时直接重放，
  //   不再发第二封。残留窗口：需“发送成功 + confirm 两次重试都丢 +
  //   idem 登记三次重试都丢 + 60 秒后重试”四连败才可能重复；另发送失败后
  //   删登记两次都失败会留一条孤儿记录，但其 mail_id 是随机 UUID、只随
  //   发出的消息 ext 披露，从未发出的邮件无人知晓 mail_id、领不到。
  if (path === "/send-mail") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const scope = body.scope;
    // v11 W-M6: to/title/note 非字符串直接按空/400 处理，不 trim 抛错。
    const to = strField(body, "to") || "";
    const kind = body.kind;
    const amount = body.amount;
    const title = strField(body, "title") || "";
    const note = strField(body, "note") || "";
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
        // v11 W-M7: 重试时先查 idem 登记（写在 reserve 之前）：idem 登记只在
        // 第一次发送成功后才写，查到 + 邮件记录还在 = 第一次已发出，直接重放，
        // 连 60 秒 pending 挡期内的重试也能立即重放，不用等占位过期。
        try {
          const prev = await env.LEVEL_KV.get("idem-mail-rec:" + idemKey);
          if (prev) {
            const prevRec = await env.LEVEL_KV.get("mail:" + prev);
            if (prevRec) return json({ ok: true, mail_id: prev, replayed: true });
          }
        } catch { /* 查不到就按正常流程走 */ }
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
      const mailRecord = { kind: kind, scope: scope, from: username, createdAt: Date.now() };
      if (kind === "xp") mailRecord.amount = Math.floor(amount);
      if (kind === "title") mailRecord.title = title;
      if (scope === "one") mailRecord.to = to;
      // 先记键：登记 mail 记录（重试 3 次），写失败直接 500，什么都没发。
      try {
        await kvRetry(() => env.LEVEL_KV.put("mail:" + mailId, JSON.stringify(mailRecord)), 3);
      } catch (e) {
        console.error("邮件登记写 KV 失败", mailId, e);
        if (gate) await mailGateRelease(env, "idem-mail:" + idemKey, gate.nonce);
        return json({ ok: false, error: "邮件登记失败，请重试" }, 500);
      }
      // 后发：发环信消息；发送失败删登记（补偿，重试两次）+ 释放占位。
      try {
        if (scope === "all") {
          await levelSendEasemobMessage(env, appToken, "chatgroups", annGroup.id, msgBody, username, ext);
        } else {
          await levelSendEasemobMessage(env, appToken, "users", to, msgBody, username, ext);
        }
      } catch (e) {
        try {
          await kvRetry(() => env.LEVEL_KV.delete("mail:" + mailId), 2);
        } catch (delErr) {
          console.error("发邮件失败后删登记失败（孤儿记录，mail_id 未披露）", mailId, delErr);
        }
        if (gate) await mailGateRelease(env, "idem-mail:" + idemKey, gate.nonce);
        throw e;
      }
      // 发送成功后记 idem 登记 + confirm 幂等键（见本接口头注释的残留窗口）。
      if (gate) {
        try {
          await kvRetry(() => env.LEVEL_KV.put("idem-mail-rec:" + idemKey, mailId, { expirationTtl: 600 }), 3);
        } catch (e) {
          console.error("idem-mail-rec 登记失败", idemKey, e);
        }
        await mailGateConfirm(env, "idem-mail:" + idemKey, gate.nonce, mailId);
      }
      return json({ ok: true, mail_id: mailId });
    } catch (e) {
      if (e && e.upstream) return json({ ok: false, error: "环信服务暂时不可用，请稍后再试" }, 500);
      console.error("发邮件时出错", e);
      return json({ ok: false, error: "发邮件失败，请稍后再试" }, 500);
    }
  }

  // ----- POST /level/send-announcement：管理员发公告（验身份 + 60 秒去重） -----
  // v10 W-B5/W-P4: 去重查+写进 MailGate DO 原子完成；发送失败释放预留，
  // 不留去重键，60 秒内可重试。
  // v12 W-M12: 顺序改成 send-mail 的“先记键后发 + 失败补偿”——发送成功后
  // 写 idem-ann-rec KV 登记（10 分钟 TTL）+ confirm 幂等键；重试时先查登记，
  // 第一次发送成功但 confirm 丢失时直接重放，不再发第二条（旧版“先发后记键”，
  // 发送成功 + confirm 两次重试都丢 + 60 秒后重试会重发一条公告）。
  // v11 新功能 (用户 2026-11-11 批准): 除 {username, password, group_id, title,
  // content} 外，再接受 {admin_key, title, content}。admin_key 复用
  // verifyAdminKey 校验（fail closed，失败 403）；通过后跳过密码验证和群主
  // 身份验证，直接以管理员身份发到 pinning 的公告群（from 用群主账号）；
  // 60 秒去重、群组锁定等现有逻辑不变；密钥值不写进代码或日志。
  // v11 W-B2: 公告群不再只信客户端传的 group_id——先由 findAnnouncementGroup
  // 按 pinning 定群；密码模式下客户端 group_id 必须等于钉死的群 id，否则 403；
  // admin_key 模式下 group_id 不需要，直接用钉死的群。
  // v11 W-M8: 标题 ≤50 字、内容 ≤2000 字（超限 400）；去重键加上群 id。
  if (path === "/send-announcement") {
    // v11 W-M6: group_id/title/content 非字符串直接 400，不 trim 抛错。
    const title = strField(body, "title") || "";
    const content = strField(body, "content") || "";
    if (!title || !content) return json({ ok: false, error: "标题和内容不能为空" }, 400);
    // v12 W-P1: 长度按码点计数（[...str].length），emoji 只算 1 位，
    // 不再按 UTF-16 .length 计（emoji 占 2 位会把合法标题误判超限）。
    if ([...title].length > 50) return json({ ok: false, error: "标题最多 50 字" }, 400);
    if ([...content].length > 2000) return json({ ok: false, error: "内容最多 2000 字" }, 400);
    // v12 W-M11: admin_key 与密码同时出现时不再 admin_key 优先——
    // 直接回 400，要求调用方只传一种认证方式（admin_key 或密码二选一）。
    // 旧语义：body 含非空 admin_key 即进 admin_key 模式，错 key + 对密码
    // 也回 403“管理员密钥不对”，调用方分不清是 key 错还是模式错。
    const hasPassword = typeof body.password === "string" && body.password.trim() !== "";
    const hasAdminKey = typeof body.admin_key === "string" && body.admin_key.trim() !== "";
    if (hasAdminKey && hasPassword) {
      return json({ ok: false, error: "请只传 admin_key 或密码中的一种，不要同时传" }, 400);
    }
    const adminKeyMode = hasAdminKey;
    let username = "";
    let clientGroupId = "";
    if (adminKeyMode) {
      // admin_key 猜测也要限流（每 IP 10 次/分钟，与 /stats 同款），先限流后验 key。
      rateLimitPrune();
      if (!rateLimitOk("ann-admin:" + clientIp, 10, 60000)) {
        return json({ ok: false, error: "请求太频繁，请稍后再试" }, 429);
      }
      if (!verifyAdminKey(env, body)) return json({ ok: false, error: "管理员密钥不对" }, 403);
    } else {
      username = await levelVerify(env, body);
      if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
      clientGroupId = strField(body, "group_id") || "";
      if (!clientGroupId) return json({ ok: false, error: "缺少 group_id" }, 400);
    }
    if (!requireEasemobSecrets(env)) {
      return json({ ok: false, error: "Worker 还没配好密钥" }, 500);
    }
    if (!env.MAIL_GATE) {
      return json({ ok: false, error: "Worker 还没配好公告去重存储（MAIL_GATE 未绑定）" }, 500);
    }
    try {
      const appToken = await getAppToken(env);
      const annGroup = await findAnnouncementGroup(env, appToken);
      if (!annGroup || !annGroup.id) {
        return json({ ok: false, error: "找不到系统公告群，请先建一个名为「我们的爱情-系统公告」的群" }, 400);
      }
      let fromUser = username;
      if (adminKeyMode) {
        // admin_key 模式：跳过密码验证和群主身份验证，from 用钉死群的群主账号。
        fromUser = annGroup.owner || "";
        if (!fromUser) return json({ ok: false, error: "公告群群主未知，无法发公告" }, 500);
      } else {
        // 密码模式：客户端 group_id 必须等于钉死的群 id，否则 403；
        // 再验群主身份 + 群名（v8/v9 逻辑保留）。
        if (clientGroupId !== annGroup.id) {
          return json({ ok: false, error: "公告只能发到系统公告群" }, 403);
        }
        const admin = await levelVerifyGroupOwner(env, appToken, clientGroupId, username);
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
      }
      const hash = await levelSha256Hex(title + "\n" + content);
      // v11 W-M8: 去重键加上群 id——同一标题+内容发到不同群不再误判重复。
      // v12 W-M12: 改成 send-mail 的“先记键后发 + 失败补偿”：
      //   重试时先查 idem-ann-rec 登记——第一次发送成功但 confirm 丢失时
      //   直接重放，不再发第二条公告；登记只在发送成功后写（10 分钟 TTL），
      //   发送失败不写登记，重试正常重发。残留窗口与 send-mail 同款：
      //   需“发送成功 + 登记写失败 + confirm 丢 + 10 分钟后重试”才可能重发。
      const annKey = "ann:" + annGroup.id + ":" + hash;
      try {
        const prev = await env.LEVEL_KV.get("idem-ann-rec:" + annKey);
        if (prev) return json({ ok: true, replayed: true });
      } catch { /* 查不到就按正常流程走 */ }
      const gate = await mailGateReserve(env, annKey, 60000);
      // v12 W-M1: 去重命中改回 {ok:true, replayed:true}，与 send-mail 一致
      // （旧版 {ok:false, error:"不要重复发送"}，调用方只能按文案区分成败）。
      if (gate.replayed) return json({ ok: true, replayed: true });
      if (!gate.ok) return json({ ok: false, error: gate.error || "正在处理中，请稍后再试" });
      try {
        await levelSendEasemobMessage(env, appToken, "chatgroups", annGroup.id, "[公告]" + title + "\n" + content, fromUser, null);
      } catch (e) {
        await mailGateRelease(env, annKey, gate.nonce);
        throw e;
      }
      // 发送成功后记 idem 登记（重试 3 次，失败只记日志）+ confirm 幂等键。
      try {
        await kvRetry(() => env.LEVEL_KV.put("idem-ann-rec:" + annKey, annGroup.id, { expirationTtl: 600 }), 3);
      } catch (e) {
        console.error("公告 idem 登记失败", annKey, e);
      }
      await mailGateConfirm(env, annKey, gate.nonce, null);
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
    // v11 W-M6: other 非字符串直接 400。
    const other = strField(body, "other") || "";
    if (!other || !isValidEasemobUsername(other)) return json({ ok: false, error: "对方用户名不对" }, 400);
    const rec = await levelLoad(env, other);
    if (!rec.bound) return json({ ok: true, bound: false });
    const total = await levelCoupleTotal(env, rec, other);
    const level = levelForXp(total);
    return json({ ok: true, bound: true, level: level, title: levelTitleFor(level), totalXp: total });
  }

  // ----- POST /level/check-deleted：批量查环信账号是否已被注销 -----
  // v13 新增（大厅“已注销用户”标记用）：消息本身分不清发送者是被删号
  // 还是被移出大厅（两种情况在成员列表里都“不在”），LEVEL_KV 里的等级
  // 记录在删号后仍保留，/level/get-other 也分不出来；唯一可信的判据
  // 是服务端用 app token 问环信 GET /users/{用户名}。
  // 匿名请求直接 403（存在性查询不能做成匿名口子）；限流走开头的通用
  // 桶（lv: 每 IP+用户名 30 次/分钟，与其余 level 接口同款）。
  // 只认 404 为已注销；200 为还在；其余状态/网络失败一律 unknown，
  // 绝不在不确定时给人打“已注销”标记（fail closed）。
  if (path === "/check-deleted") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    if (!requireEasemobSecrets(env)) {
      return json({ ok: false, error: "Worker 还没配好密钥" }, 500);
    }
    const list = body.usernames;
    if (!Array.isArray(list)) return json({ ok: false, error: "缺少 usernames" }, 400);
    if (list.length > 50) return json({ ok: false, error: "一次最多查 50 个用户名" }, 400);
    const targets = [];
    const seen = new Set();
    for (const u of list) {
      if (typeof u !== "string") continue;
      const name = u.trim();
      if (!name || seen.has(name)) continue;
      seen.add(name);
      targets.push(name);
    }
    const appToken = await getAppToken(env);
    const deleted = [];
    const unknown = [];
    for (const name of targets) {
      let r;
      try {
        r = await fetch(`${BASE(env)}/users/${encodeURIComponent(name)}`, {
          headers: { Authorization: "Bearer " + appToken },
        });
      } catch (e) {
        console.error("查用户是否注销失败: 网络异常", name, e);
        unknown.push(name);
        continue;
      }
      if (r.status === 200) {
        // 还在：不进 deleted 也不进 unknown。
      } else if (r.status === 404) {
        deleted.push(name);
      } else {
        // 401/403/5xx 等：不确定，绝不判已注销。
        console.error("查用户是否注销失败: HTTP " + r.status, name);
        unknown.push(name);
      }
    }
    return json({ ok: true, deleted: deleted, unknown: unknown });
  }

  // ----- POST /level/record-recall：1:1 撤回成功后登记一条 -----
  // v14 新增（撤回兜底）：撤回 CMD 是一次性信号，对方 App 被系统杀掉
  // 或手机关机时永远收不到；登记后对方下次进 1:1 聊天页调
  // /level/get-recalls 就能补删。只认 1:1 聊天——大厅撤回走群 CMD
  // 广播，不走这套记录。调用方须先过 levelVerify，匿名 403。
  if (path === "/record-recall") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const peer = strField(body, "peer") || "";
    if (!peer || !isValidEasemobUsername(peer)) {
      return json({ ok: false, error: "对方用户名不对" }, 400);
    }
    if (peer === username) {
      return json({ ok: false, error: "不能给自己登记撤回" }, 400);
    }
    const msgId = strField(body, "msgId") || "";
    if (!msgId || msgId.length > 128) {
      return json({ ok: false, error: "消息 id 不对" }, 400);
    }
    try {
      await appendRecall(env, peer, username, msgId);
    } catch (e) {
      console.error("登记撤回失败", peer, username, e);
      return json({ ok: false, error: "服务器出错，请稍后再试" }, 500);
    }
    return json({ ok: true });
  }

  // ----- POST /level/get-recalls：1:1 聊天页查对方撤回过我哪些消息 -----
  // v14 新增：纯读。返回对方在和我的 1:1 聊天里撤回过的消息 id（7 天内）。
  // 绝不因“已返回过”就删记录——app 读到后删本地失败了，下次进页还会
  // 再给一次；只有超过 7 天的过期条目在返回前清理（顺手写回）。
  if (path === "/get-recalls") {
    const username = await levelVerify(env, body);
    if (!username) return json({ ok: false, error: "身份校验失败" }, 403);
    const peer = strField(body, "peer") || "";
    if (!peer || !isValidEasemobUsername(peer)) {
      return json({ ok: false, error: "对方用户名不对" }, 400);
    }
    let list;
    try {
      const key = recallKey(username, peer);
      const raw = await env.LEVEL_KV.get(key);
      let parsed = null;
      if (raw) {
        try { parsed = JSON.parse(raw); } catch (e) { parsed = null; }
      }
      list = Array.isArray(parsed) ? pruneRecallList(parsed) : [];
      // 读时清理了过期/损坏条目才写回（没清掉就不写，少一次 KV 写）。
      if (Array.isArray(parsed) && parsed.length !== list.length) {
        await kvRetry(() => env.LEVEL_KV.put(key, JSON.stringify(list)), 3);
      }
    } catch (e) {
      console.error("查撤回记录失败", username, peer, e);
      return json({ ok: false, error: "服务器出错，请稍后再试" }, 500);
    }
    return json({ ok: true, msgIds: list.map((e) => e.id) });
  }

  // ----- POST /level/migrate：首次把手机 EXT 里的等级快照迁到服务器 -----
  // v10 W-B1: 服务端不再无条件信任客户端快照——
  //   经验上限 = 12 × (服务器今天 − 2025-10-17 的天数) + 已登记的邮件经验总和
  //              + 10000（一次性补登旧版无登记邮件的宽限）；超上限直接拒绝本次迁移。
  // v11 W-B1: 称号白名单不再按 xpCap 算——xpCap 只管经验上限（公式不动），
  //   白名单按“合并后实际 XP”（服务器记录与快照取大）对应的等级算：
  //   白名单 = 合并后 XP 对应等级及以下的 LV.1–N 称号 + 邮件登记表里的称号。
  //   例：XP 为 0 迁“永结同心”时白名单只有 LV.1 称号，直接丢弃，不再写进 DO。
  //   注意：白名单变小后，服务器记录里已有的、超出合并后等级的等级称号
  //   在本次合并时也会被过滤掉（邮件授予的特殊称号不受影响，一直在白名单里）；
  //   等级称号本身由 totalXp 实时算出，dtitle 不在白名单里时合并会清掉它。
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
    // v11 W-B1: 白名单按合并后 XP 对应等级算。先读服务器记录（没有则按 0 算），
    // 合并后 XP = max(服务器 XP, 快照 XP)；读失败时保守按快照 XP 算（DO 内
    // 仍有 xpCap 封顶 + 白名单二次过滤，不会因此放行超限快照）。
    const snapXp = typeof ext.xp === "number" && ext.xp >= 0 ? Math.floor(ext.xp) : 0;
    let mergedXp = snapXp;
    try {
      const serverRec = await levelLoad(env, username);
      mergedXp = Math.max(serverRec.xp, snapXp);
    } catch (e) {
      console.error("迁移读服务器记录失败，按快照 XP 算白名单", e);
    }
    const mergedLevel = levelForXp(mergedXp);
    for (let i = 1; i <= mergedLevel; i++) allowedTitles.add(LEVEL_TITLES[i - 1]);
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
    // v11 W-M6: partner 非字符串直接 400。
    const partner = strField(body, "partner") || "";
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
    // v11 W-M9: 提前返回分支也要验对方回指——只有对方确实指回我才算已绑定；
    // 对方没指回我时不直接报成功，往下走正常绑定流程（DO 内二次校验）。
    if (myRec.bound === partner) {
      if (partnerFull.rec.bound === username) return json({ ok: true, bound: partner });
    }
    const oldPartner = myRec.bound || "";
    // v11 W-M9: levelApply(bind) 时由 DO 二次校验对方状态（checkPartner），
    // 堵住“外层校验 → 写入”之间的 TOCTOU 窗口。
    const r = await levelApply(env, username, "bind", { partner, checkPartner: true });
    if (!r.ok) return json({ ok: false, error: r.error });
    if (oldPartner && oldPartner !== partner) {
      // 换绑：清掉旧伴侣的回指（尽力而为；失败时对方下次 get-couple 自愈兜底）。
      try {
        await levelApply(env, oldPartner, "clear-bound-if", { by: username });
      } catch (e) {
        console.error("换绑清旧伴侣回指失败", oldPartner, e);
      }
    }
    // v12 W-M4：换绑清零时把 xpReset 透传给 app（DO 里已清 XP，app 侧可据此刷新等级显示）。
    return json({ ok: true, bound: partner, ...(r.xpReset ? { xpReset: true } : {}) });
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
        // v12 W-P3: GET 回 405（Method Not Allowed），其余方法保持 404。
        const status = request.method === "GET" ? 405 : 404;
        return withCors(json({ ok: false, error: "只支持 POST" }, status), request);
      }
      const url = new URL(request.url);

      // ---------- POST /level/*：情侣等级/经验/签到/邮件（v4） ----------
      // 路径可带 /level 前缀也可不带（代理会去掉前缀再转发，两种都认）。
      let levelPath = url.pathname;
      if (levelPath.startsWith("/level/")) levelPath = levelPath.slice("/level".length);
      if (levelPath === "/checkin" || levelPath === "/add-xp" || levelPath === "/claim-mail"
        || levelPath === "/send-mail" || levelPath === "/send-announcement"
        || levelPath === "/get-couple" || levelPath === "/get-other" || levelPath === "/migrate" || levelPath === "/unbind"
        || levelPath === "/bind" || levelPath === "/check-deleted") {
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
            // v12 W-M6: entities/data 两种形状都认（与 findAnnouncementGroup
            // 的群列表解析同款）；只认 entities 时，环信回 data 形会静默报 total 0。
            const list = Array.isArray(j && j.data)
              ? j.data
              : (Array.isArray(j && j.entities) ? j.entities : []);
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
        // v11 W-M4: /admin-delete 加限流（每 IP 10 次/分钟，与 /stats 同款），
        // 先限流后验 key，ADMIN_KEY 猜测不再零成本。
        rateLimitPrune();
        if (!rateLimitOk("adel:" + ip, 10, 60000)) {
          return withCors(json({ ok: false, error: "请求太频繁，请稍后再试" }, 429), request);
        }
        // v11 W-M6: username 非字符串直接 400。
        const username = strField(body, "username") || "";
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
      // v11 W-M6: username 非字符串直接 400。
      const username = strField(body, "username") || "";
      if (!username) return withCors(json({ ok: false, error: "缺少 username" }, 400), request);
      if (!requireEasemobSecrets(env)) {
        return withCors(json({ ok: false, error: "Worker 还没配好密钥" }, 500), request);
      }
      // v10 W-M7: 删号密码校验限流（每 IP+用户名 20 次/分钟）。
      rateLimitPrune();
      if (!rateLimitOk("del:" + ip + ":" + username, 20, 60000)) {
        return withCors(json({ ok: false, error: "请求太频繁，请稍后再试" }, 429), request);
      }

      // 1. 校验本人 (防别人乱删号)
      // v10 W-B4: token 路径二次核对归属 + token 失败回退密码校验（见 verifyOwner）。
      let ok = false;
      try {
        ok = await verifyOwner(env, username, body.userToken, body.password);
      } catch (e) {
        console.error("校验身份时出错", e);
        return withCors(json({ ok: false, error: "身份校验服务暂时不可用，请稍后再试" }, 500), request);
      }
      if (!ok) {
        // v12 W-M3（彻底修）：删成功后响应丢失的合法重试——此时账号已不在
        //   环信上，verifyOwner 必然失败；改凭“删号时存入幂等记录的旧凭证
        //   SHA-256 哈希”比对重放（见 idemReplayWithCred 注释：为什么这样
        //   能同时满足“合法重试成功 + 探测被挡”）。比对失败/无凭证时仍
        //   403，探测者只凭用户名什么都拿不到。
        const replayed = await idemReplayWithCred(env, "del", username, body.userToken, body.password);
        if (replayed) return withCors(json(replayed), request);
        return withCors(json({ ok: false, error: "身份校验失败, 只能注销自己的账号" }, 403), request);
      }

      // M10：上次删成功但 app 没收到结果，重试直接返回成功（账号仍在
      //   时返回 null，走下面正常删号；删号前已缓存的情形才可达）。
      const replayed = await idemReplay(env, "del", username);
      if (replayed) return withCors(json(replayed), request);

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
        // v12 W-M3：删成功后把请求体里实际给出的凭证各存一份 SHA-256
        // 哈希（token 和/或密码，只存哈希，绝不存明文），供“删成功后
        // 响应丢失、合法重试”时比对重放（见 idemReplayWithCred）。
        // KV 10 分钟过期，到期后重试走正常删号（账号已不在会报 502，
        // 与旧行为一致）。
        const credHashes = [];
        if (typeof body.userToken === "string" && body.userToken) credHashes.push(await levelSha256Hex(body.userToken));
        if (typeof body.password === "string" && body.password) credHashes.push(await levelSha256Hex(body.password));
        await idemPut(env, "del", username, { ok: true, deleted: username, credHashes });
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
