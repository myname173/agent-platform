import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getKeys, manageKey } from '@/lib/n8n-client';

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const data = await getKeys();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let payload: any = {};
  try {
    payload = await req.json();
  } catch {
    /* empty body */
  }

  const clean = {
    action: String(payload.action || ''),
    name: String(payload.name || ''),
    rate_limit_rpm: payload.rate_limit_rpm === undefined ? undefined : Number(payload.rate_limit_rpm)
  };

  try {
    const out = await manageKey(clean);
    return NextResponse.json(out.body ?? { error: 'upstream error' }, { status: out.status });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
