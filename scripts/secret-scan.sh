#!/bin/bash
# 密钥泄露扫描：把 .env 里的「实际值」拿去搜暂存区（git index）内容。
# 只报告「命中在哪个文件」，绝不打印密钥本身。
set -u
cd /c/Users/13682/Desktop/agent-platform-main

echo "=== 1) 用 .env 的实际值扫暂存区 ==="
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
  found=$(git grep --cached -l -F -- "$v" 2>/dev/null)
  if [ -n "$found" ]; then
    echo "!! [$k] 的值出现在："
    echo "$found" | sed 's/^/     /'
    hits=$((hits+1))
  fi
done < .env
echo "-- 检查了 $checked 个长值，命中 $hits 个 --"

echo
echo "=== 2) 通用密钥特征扫描（暂存区）==="
for pat in 'gho_' 'ghp_' 'github_pat_' 'sk-[A-Za-z0-9]\{20,\}' 'AKIA[0-9A-Z]\{16\}' 'BEGIN [A-Z ]*PRIVATE KEY' 'n8n_api_[0-9a-f]\{40,\}' 'eyJhbGciOi'; do
  n=$(git grep --cached -l -E -- "$pat" 2>/dev/null | wc -l)
  printf '%-38s %s 个文件\n' "$pat" "$n"
  [ "$n" != "0" ] && git grep --cached -l -E -- "$pat" 2>/dev/null | sed 's/^/     /'
done

echo
echo "=== 3) 暂存区里所有 .env* 文件 ==="
git diff --cached --name-only | grep -iE '(^|/)\.env' || echo "（无）"
