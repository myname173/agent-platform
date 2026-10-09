# `_scratch/` — 复现「产品级文件上传」用的脚本

这些不是演示产物，是**验证方法本身**。要在别的机器上复跑，按下面顺序。

| 脚本 | 干什么 |
|---|---|
| `dexec.sh` | `docker exec` 的重试包装。Docker Desktop 会间歇性地对 `/containers/<name>/json` 返回 500，而容器其实是好的 —— 直接 exec 会莫名其妙失败。用法：`bash dexec.sh <容器> <命令...>` |
| `s3_probe.py` | 用**平台自己的凭据**（读 `.env` 的 `MINIO_ROOT_USER/PASSWORD`）对桶做 PUT/HEAD/GET/LIST，逐字节比对。用 stdlib 手写 AWS SigV4 —— 本环境装不了 `boto3` |
| `set_bucket_cors.py` | 给 `lobechat-files` 配 CORS。**没这一步，浏览器上传会被静默拦掉**（见下） |
| `upload_via_ui.sh` | 走**真实 UI** 传文件：签会话 cookie → 打开对话前台 → 打开附件二级菜单 → 上传 → 截图 |
| `verify_upload.py` | 从 `files` 表取 S3 key，把对象取回来，**SHA-256 与本地原文件比对** |

## 三个必须知道的坑

1. **`S3_ENDPOINT` 用的是容器创建那一刻的 LAN IP。**
   换网之后容器仍指旧地址，`upload.createS3PreSignedUrl` 直接报
   `ECONNREFUSED <old-ip>:9000`。
   修：改 `.env` 的 `PLATFORM_LAN_IP` / `LAN_IP`，然后 **`docker compose up -d`**
   （`restart` 不会重新注入环境变量）。
   根治：容器内用 `minio:9000`（实测可达），只有浏览器要用的 `S3_PUBLIC_DOMAIN` 才需要真实地址。

2. **「200 不等于 CORS 通过」。**
   桶没配 CORS 时，预检 `OPTIONS` 会回 `200 OK`，但响应头里**一个 `Access-Control-*` 都没有**。
   浏览器于是在跨域时**根本不发**真正的 `PUT`，应用只能 `abortS3Upload`。
   判据就在前端的网络记录里：
   `createS3PreSignedUrl 200` → `OPTIONS 200` → `PUT (无状态)` → `abortS3Upload 200`。
   用 `set_bucket_cors.py` 配上，复验预检已返回 `access-control-allow-origin` 等头。

3. **认证是绕过去的，上传没有。**
   LobeChat 用 Better Auth 邮箱密码，密码没记录、邮箱是占位地址。
   脚本从 `auth_sessions` 取现成会话，用 `AUTH_SECRET` 做 HMAC-SHA256 签名，
   cookie `better-auth.session_token=<token>.<base64签名>`
   （**只传 token 不签名会被当成匿名，`get-session` 返回 `null`**）。
   **仅认证这一步是绕的；上传走的是产品自己的界面和接口。**

## 运行顺序

```bash
# 1. 先看基线与配置
bash interview-demo/_scratch/dexec.sh postgres psql -U n8n -d lobechat -c "select count(*) from files;"

# 2. 需要的话配 CORS（幂等）
C:/Users/13682/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe \
  interview-demo/_scratch/set_bucket_cors.py

# 3. 走真实 UI 上传（后台跑，约 4 分钟）
bash interview-demo/_scratch/upload_via_ui.sh > /tmp/up.log 2>&1 &

# 4. 验证：取回来逐字节比对
ROW=$(bash interview-demo/_scratch/dexec.sh postgres psql -U n8n -d lobechat -t -A -F'|' \
      -c "select id,name,size,url from files order by created_at desc limit 1;" | tr -d '\r')
export FILE_ID=$(echo "$ROW" | cut -d'|' -f1)   FILE_NAME=$(echo "$ROW" | cut -d'|' -f2)
export FILE_SIZE=$(echo "$ROW" | cut -d'|' -f3) FILE_KEY=$(echo "$ROW" | cut -d'|' -f4)
C:/Users/13682/.workbuddy-ai/binaries/python/versions/3.13.12/python.exe \
  interview-demo/_scratch/verify_upload.py
```

预期末行：`RESULT: PASS`。
