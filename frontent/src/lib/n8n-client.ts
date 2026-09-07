const N8N_URL = process.env.NEXT_PUBLIC_N8N_URL || 'http://localhost:5678';
const N8N_API_KEY = process.env.N8N_API_KEY || '';

const headers = {
  'X-N8N-API-KEY': N8N_API_KEY,
  'Content-Type': 'application/json'
};

export async function getHealthz() {
  try {
    const res = await fetch(`${N8N_URL}/healthz`, { headers });
    if (!res.ok) throw new Error('Health check failed');
    return await res.json();
  } catch (error) {
    console.error('Error fetching health:', error);
    return { status: 'error' };
  }
}

export async function getWorkflows() {
  const res = await fetch(`${N8N_URL}/api/v1/workflows`, { headers });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}

export async function getExecutions(limit: number = 10) {
  const res = await fetch(`${N8N_URL}/api/v1/executions?limit=${limit}`, { headers });
  if (!res.ok) throw new Error(`API error: ${res.status}`);
  return res.json();
}
