import { notFound } from 'next/navigation';

/* 模板遗留页面 —— 已下线（F3）。
   原实现见 git 历史；这里统一返回 404，避免与平台自有页面语义冲突
   （例如 /dashboard/users 与 People 页、/dashboard/chat 与 Playground）。 */
export default function Page() {
  notFound();
}
