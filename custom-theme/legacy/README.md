# custom-theme/legacy —— 历史版本，不要用

这里放的是**已被取代**的主题文件与脚本。**唯一在用的是上一层的 `pivot-theme-v2.*` + `../apply-theme-v2.ps1`。**

归档时间：2026-10-27。原因见下。

| 文件 | 曾经是什么 | 为什么废弃 |
|---|---|---|
| `pivot-theme.css` / `pivot-theme.js` | 第一代 PivotAI 主题（2026-09-11，LobeChat 1.x） | 全仓已无任何脚本引用；视觉上与线上蓝版几乎无差别（v2 就是从它 port 的），没有独立价值 |
| `apply-theme-v1.ps1` | 把 v1 注入 LobeChat 1.x | **在 LobeHub 2.x 上必然失败**：它写死 `/app/.next/static/css/967104e9fd9cfb93.css` 和 `main-app-*.js`，那是 1.x 的构建产物；2.x 只服务 `/app/public/_spa/**` |
| `apply-theme-v2-root-copy.ps1` | v2 应用器的早期草稿（放在仓库根目录） | 功能是 `../apply-theme-v2.ps1` 的子集：没有人脸贴图投放、没有 `-Check` 探针、没有 `-Restart`、没有版本指纹 |
| `inject-pivot.js` | v1 时代的注入器 | 无任何引用 |

## 为什么必须归档而不是留着

同一个动作（"把主题装进容器"）曾经有 **三份** 实现，md5 全不相同。跑错哪一份都不会报错，
只会静默得到旧主题——2026-10-27 排查时，线上容器就停在 **2026-10-09 之前的蓝色版本**，陈旧 18 天。

**判断"哪份是活的"的正确方式**（不要靠文件名猜）：

```bash
# 1) 容器里有没有 v2 的托管块
curl -s http://127.0.0.1:3210/_spa-auth/assets/<hash>.css | grep -c 'PIVOTAI-THEME-V2:START'
# 2) 容器里有没有 v2 独有的人脸贴图（只有 v2 会投放）
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' http://127.0.0.1:3210/_spa/pivot-face.jpg
# 3) 线上托管块与仓库文件的差异（含版本指纹）
powershell -File custom-theme/apply-theme-v2.ps1 -Check
```

注意：`pivot-apply.js` 只注入 `_spa/**` 下的 `vendor-ui-runtime-*.js`，**不覆盖 `_spa-auth/**`**，
所以登录页只会拿到主题的 CSS，拿不到 JS（黑底、星空、人脸都靠 JS）。这是设计现状，不是 bug。
