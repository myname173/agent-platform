#!/bin/bash
# 密钥泄露扫描：把 .env 里的「实际值」拿去搜 git 内容。
# 同时扫「已提交到 HEAD 的内容」和「暂存区」——只扫暂存区是不够的：
# 一个早已提交进去的秘密（例如 migration/SOURCE.json 里的 N8N_ENCRYPTION_KEY，
# 本仓库是 public）永远不会被发现，因为每次扫描时它都不在暂存区。
# 只报告「命中在哪个文件」，绝不打印密钥本身。
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

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
