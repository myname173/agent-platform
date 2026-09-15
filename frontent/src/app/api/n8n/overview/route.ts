import { NextResponse } from 'next/server';
import { auth } from '@clerk/nextjs/server';
import { getOverview } from '@/lib/n8n-client';

export async function GET() {
  const { userId } = await auth();

  if (!userId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const data = await getOverview();
    return NextResponse.json(data);
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}
