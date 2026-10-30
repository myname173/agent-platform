#!/bin/bash
# 密钥泄露扫描：把 .env 里的「实际值」拿去搜 git 内容。
#
# 用法：
#   bash scripts/secret-scan.sh                  # 全量：已提交树 + 暂存区（原有行为）
#   bash scripts/secret-scan.sh --added <range>  # 只扫这段范围【新增的行】：凭据类命中 exit 1
#   bash scripts/secret-scan.sh --self-test      # 证明这道闸门双向可判（会拦、也不误伤）
#
# 为什么要 --added：全量扫描把历史遗留泄露一遍遍列出来，"这次新加了什么"
# 被噪音埋掉。2026-10-29 推那 70 个文件时全量报了十几个键，逐条核对下来全是
# 早已公开的旧命中 —— 那样的输出没人会读，闸门等于没有。
#
# 分级（见 build_pairs）：
#   cred = >=16 字符、不是 http(s) 地址、不是裸域名/IP、不是纯数字 —— 这类命中【拦截】
#   cfg  = 其余值（本地服务 URL、平台域名、访问码等）—— 只【提示】，不拦截
# 不这么做的话闸门会被直接 --no-verify 绕过：LOBECHAT_ACCESS_CODE 的值就是
# "agent-platform"，它作为 K8s namespace / 镜像前缀 / 包名出现在几十处，
# 每个提交都会"命中"。已知的让步：https 开头的 webhook URL 落在 cfg，
# 只提示不拦截 —— 要收紧就改 build_pairs 的第一条判断。
#
# 只扫暂存区是不够的：早已提交进去的秘密（例如 migration/SOURCE.json 里的
# N8N_ENCRYPTION_KEY）不会出现在暂存区。本脚本只报告命中在哪个文件，
# 绝不打印密钥本身。
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

PAIRS="${TMPDIR:-/tmp}/secret_scan_pairs.$$"
BLOB="${TMPDIR:-/tmp}/secret_scan_blob.$$"
trap 'rm -f "$PAIRS" "$BLOB"' EXIT

# ---------- .env -> key<TAB>value<TAB>class ----------
build_pairs() {
  [ -f .env ] || { echo "!! 没有 .env，无法按实际值判断（首次使用请先 cp .env.example .env）" >&2; return 1; }
  awk '
    function classify(k, v,   n) {
      if (length(v) < 16) return "cfg"
      if (v ~ /^https?:\/\//) return "cfg"
      if (v ~ /^[a-z0-9.-]+\.[a-z][a-z0-9-]*$/ && v !~ /[A-Z]/) return "cfg"   # 裸域名
      if (v ~ /^[0-9.]+$/) return "cfg"                                        # 纯数字/IP
      return "cred"
    }
    /^[[:space:]]*#/ {next}
    /^[[:space:]]*$/ {next}
    {
      eq=index($0,"="); if (eq==0) next;
      k=substr($0,1,eq-1); v=substr($0,eq+1);
      gsub(/\r/,"",v);
      gsub(/^[ \t]+/,"",v); gsub(/[ \t]+$/,"",v);
      gsub(/^"/,"",v); gsub(/"$/,"",v);
      gsub(/^\047/,"",v); gsub(/\047$/,"",v);
      gsub(/\t/," ",v);
      gsub(/^[ \t]+/,"",k); gsub(/[ \t]+$/,"",k);
      if (length(k)>0 && length(v)>=10) printf "%s\t%s\t%s\n", k, v, classify(k, v);
    }
  ' .env > "$PAIRS"
  # 分隔符是 TAB：读它的循环必须用同一个 IFS，否则 value 全空 = 永远"零命中"的假绿
  [ -s "$PAIRS" ] || { echo "!! .env 里没有 >=10 字符的值可查" >&2; return 1; }
}

# 在待检文本里找 .env 真实值。
#   stdout: cred 命中行 / cfg 提示行
#   返回：1 = 有 cred 命中（要拦），0 = 没有；checked=0 时返回 2（结果不可信）
scan_blob() {
  local blob="$1" checked=0 cred=0 key val cls files out_c="" out_cfg=""
  while IFS="$(printf '\t')" read -r key val cls; do
    [ -z "$val" ] && continue
    checked=$((checked+1))
    if grep -qF -- "$val" "$blob"; then
      files=$(grep -F -- "$val" "$blob" | cut -f1 | sort -u | tr '\n' ' ')
      if [ "$cls" = "cred" ]; then
        cred=$((cred+1))
        out_c="${out_c}[${key}] -> ${files}\n"
      else
        out_cfg="${out_cfg}   (cfg) [${key}] -> ${files}\n"
      fi
    fi
  done < "$PAIRS"
  printf '%b' "$out_c"
  if [ -n "$out_cfg" ]; then echo "-- 以下命中的是配置类值，不拦截（值本身就写在文档/编排里）："; printf '%b' "$out_cfg"; fi
  echo "checked_keys=$checked cred_class=$(awk -F'\t' '$3=="cred"' "$PAIRS" | wc -l) blob_lines=$(wc -l < "$blob")" >&2
  [ "$checked" -eq 0 ] && { echo "!! 循环一个 key 都没检查，结果不可信" >&2; return 2; }
  [ "$cred" -gt 0 ] && return 1
  return 0
}

added_blob() {  # $1=range -> BLOB = 该范围新增的行，每行前缀文件名
  git diff -U0 --no-color "$1" 2>/dev/null | awk '
    /^\+\+\+ b\// {f=substr($0,7); next}
    /^\+\+\+/ {next}
    /^\+/ {sub(/^\+/,""); print f "\t" $0}
  ' > "$BLOB"
}

# ---------- --self-test ----------
if [ "${1:-full}" = "--self-test" ]; then
  build_pairs || exit 2
  echo "=== self-test：--added 必须双向可判 ==="
  cred_val=$(awk -F'\t' '$3=="cred"{print $2; exit}' "$PAIRS")
  cfg_val=$(awk -F'\t' '$3=="cfg"{print $2; exit}' "$PAIRS")
  [ -n "$cred_val" ] || { echo "FAIL: .env 里找不到凭据类值，没法验证拦截能力"; exit 2; }

  printf 'SENTINEL\t%s\n' "$cred_val" > "$BLOB"
  if scan_blob "$BLOB" >/dev/null 2>&1; then
    echo "FAIL: 植入凭据类真实值却没报命中 -> 这道闸门是假绿的"; exit 2
  fi
  echo "OK  : 凭据类值出现 -> 判定拦截（exit 1）"

  if [ -n "$cfg_val" ]; then
    printf 'SENTINEL\t%s\n' "$cfg_val" > "$BLOB"
    if scan_blob "$BLOB" >/dev/null 2>&1; then
      echo "OK  : 配置类值出现 -> 只提示，不拦截"
    else
      echo "FAIL: 配置类值被判成要拦截 -> 会误伤日常提交"; exit 2
    fi
  fi

  printf 'README.md\tjust some harmless prose about the platform\n' > "$BLOB"
  if scan_blob "$BLOB" >/dev/null 2>&1; then
    echo "OK  : 干净文本 -> 零命中"
  else
    echo "FAIL: 干净文本被判成命中"; exit 2
  fi
  echo "-- self-test 通过 --"
  exit 0
fi

# ---------- --added <range> ----------
if [ "${1:-full}" = "--added" ]; then
  range="${2:-}"
  [ -n "$range" ] || { echo "用法: secret-scan.sh --added <git 范围，如 origin/main..HEAD>" >&2; exit 2; }
  build_pairs || exit 2
  added_blob "$range"
  if [ ! -s "$BLOB" ]; then
    echo "-- $range 没有新增行，跳过 --"
    exit 0
  fi
  out=$(scan_blob "$BLOB" 2>/tmp/secret_scan_diag.$$); rc=$?
  diag=$(cat /tmp/secret_scan_diag.$$ 2>/dev/null); rm -f /tmp/secret_scan_diag.$$
  echo "$diag"
  if [ "$rc" -eq 1 ]; then
    echo "!! 【新增的行】里出现凭据类 .env 真实值（值本身不打印）："
    printf '%s\n' "$out"
    echo "   改成从环境变量读（node --env-file=.env / docker compose --env-file），别把值写进文件。"
    echo "   已经推出去过的值只能轮换：删文件不撤销历史。"
    exit 1
  fi
  [ "$rc" -eq 2 ] && { echo "!! 扫描器没检查到任何 key，不放行 —— 先修扫描器"; exit 1; }
  printf '%s\n' "$out" | grep -q . && printf '%s\n' "$out"
  echo "-- 新增行没有凭据类命中 --"
  exit 0
fi

# ---------- 默认：全量扫描 ----------
echo "=== 1) 用 .env 的实际值扫【已提交 + 暂存区】 ==="
hits=0
checked=0
while IFS='=' read -r k v; do
  # 跳过注释/空行
  case "$k" in ''|'#'*) continue;; esac
  # 去掉首尾引号与空白
  v="${v%$'\r'}"
  v="$(printf '%s' "$v" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'$//")"
  # 太短的值（true/false/端口号等）会误报，跳过
  [ "${#v}" -lt 10 ] && continue
  checked=$((checked+1))
  head_hits=$(git grep -I -l -F -- "$v" HEAD 2>/dev/null)
  idx_hits=$(git grep --cached -I -l -F -- "$v" 2>/dev/null)
  if [ -n "$head_hits" ] || [ -n "$idx_hits" ]; then
    echo "!! [$k] 的值出现在："
    if [ -n "$head_hits" ]; then echo "$head_hits" | sed 's/^/      committed: /'; fi
    if [ -n "$idx_hits" ]; then echo "$idx_hits" | sed 's/^/      staged:    /'; fi
    hits=$((hits+1))
  fi
done < .env
echo "-- 检查了 $checked 个长值，命中 $hits 个（committed 是已泄露，必须处理）--"

echo
echo "=== 2) 通用密钥特征扫描（已提交 + 暂存区）==="
for pat in 'gho_' 'ghp_' 'github_pat_' 'sk-[A-Za-z0-9]\{20,\}' 'AKIA[0-9A-Z]\{16\}' 'BEGIN [A-Z ]*PRIVATE KEY' 'n8n_api_[0-9a-f]\{40,\}' 'eyJhbGciOi'; do
  files=$( { git grep -I -l -E -- "$pat" HEAD 2>/dev/null; git grep --cached -I -l -E -- "$pat" 2>/dev/null; } | sort -u )
  n=$(printf '%s' "$files" | grep -c . )
  printf '%-38s %s 个文件\n' "$pat" "$n"
  [ "$n" != "0" ] && printf '%s\n' "$files" | sed 's/^/     /'
done

echo
echo "=== 3) 暂存区里所有 .env* 文件 ==="
git diff --cached --name-only | grep -iE '(^|/)\.env' || echo "（无）"

echo
echo "=== 4) 历史深度检查（可选，慢）==="
echo "注意：上面的 'committed' 只扫当前树（HEAD）。秘密一旦进过历史，"
echo "即使后来删掉也仍可从 git log 里翻出来 —— 那叫已泄露，不是修好了。"
echo "要查历史，手动跑（会逐提交翻，比较慢）："
echo "    git log --all -p -S '<要查的值>' -- . | head -50"
echo "    # 或 git rev-list --all | xargs -n1 git grep -F '<值>'"
echo "历史泄露只能靠轮换该值 +（可选）重写历史解决，删文件不算。"
echo
echo "只看【这次会推出去的新增内容】： bash scripts/secret-scan.sh --added origin/main..HEAD"
echo "确认这道闸门真的会拦（不是假绿）： bash scripts/secret-scan.sh --self-test"
