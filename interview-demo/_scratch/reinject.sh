#!/bin/bash
# 把 custom-theme/ 里的 v2 主题重新注入 lobechat 容器并重启。
# 背景：注入不是持久的 —— `docker compose up -d`（重建容器）会清掉，`docker restart` 不会。
# 注意：MSYS_NO_PATHCONV=1 必须加，否则 Git Bash 会把容器内的 /tmp/xxx 改写成 Windows 路径。
set -euo pipefail
cd /c/Users/13682/Desktop/agent-platform-main
export MSYS_NO_PATHCONV=1

docker cp custom-theme/pivot-theme-v2.css lobechat:/tmp/pivot-theme-v2.css
docker cp custom-theme/pivot-theme-v2.js  lobechat:/tmp/pivot-theme-v2.js
docker cp custom-theme/pivot-apply.js     lobechat:/tmp/pivot-apply.js

# 人脸底图由 CSS 以 url('/_spa/pivot-face.jpg') 引用，必须落在 public 目录里。
# 只在缺失或大小不同的时候拷（2 MB，没必要每次都传）。
need_face=$(docker exec lobechat sh -c '[ -f /app/public/_spa/pivot-face.jpg ] && stat -c %s /app/public/_spa/pivot-face.jpg || echo 0')
want_face=$(stat -c %s custom-theme/pivot-face.jpg)
if [ "$need_face" != "$want_face" ]; then
  echo "--- 人脸底图：容器内 ${need_face}B -> 宿主机 ${want_face}B，重新拷贝 ---"
  docker cp custom-theme/pivot-face.jpg lobechat:/app/public/_spa/pivot-face.jpg
else
  echo "--- 人脸底图：已一致（${want_face}B），跳过 ---"
fi

echo "--- apply ---"
docker exec lobechat node /tmp/pivot-apply.js

echo "--- 容器内文件校验（应与宿主机一致）---"
docker exec lobechat sh -c 'sha256sum /tmp/pivot-theme-v2.css /tmp/pivot-theme-v2.js'

echo "--- restart ---"
docker restart lobechat >/dev/null
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' --noproxy '*' --max-time 4 http://127.0.0.1:3210/signin 2>/dev/null || true)
  if [ "$code" = "200" ] || [ "$code" = "302" ]; then echo "lobechat up after ${i}s (HTTP $code)"; exit 0; fi
  sleep 1
done
echo "!! lobechat 未在 60s 内就绪"; exit 1
