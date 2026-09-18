import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getReminders } from '@/lib/n8n-client';

export async function GET(req: Request) {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const owner = new URL(req.url).searchParams.get('owner') || undefined;

  try {
    const data = await getReminders(owner);
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
