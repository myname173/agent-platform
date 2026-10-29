import { NextResponse } from 'next/server';
import { requireUser } from '@/lib/api-guard';
import { getPlatformJob } from '@/lib/n8n-client';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { denied } = await requireUser();
  if (denied) return denied;

  const { id } = await ctx.params;
  if (!/^[A-Za-z0-9._:-]{1,180}$/.test(id)) {
    return NextResponse.json({ error: '无效的 task_id' }, { status: 400 });
  }

  try {
    return NextResponse.json(await getPlatformJob(id));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const status = message.includes('不存在') || message.includes('job_not_found') ? 404 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
