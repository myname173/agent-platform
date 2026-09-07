'use client';

import React, { useEffect, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow
} from '@/components/ui/table';
import { Icons } from '@/components/icons';

type Workflow = {
  id: string;
  name: string;
  active: boolean;
  nodes: any[];
  updatedAt: string;
};

type Execution = {
  id: string;
  workflowId: string;
  status: string;
  mode: string;
  finishedAt: string;
};

export default function WorkflowDashboard() {
  const [health, setHealth] = useState<{ status?: string } | null>(null);
  const [workflows, setWorkflows] = useState<Workflow[]>([]);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    async function fetchData() {
      try {
        const [healthRes, workflowsRes, executionsRes] = await Promise.all([
          fetch('/api/n8n/health').then(res => res.json()),
          fetch('/api/n8n/workflows').then(res => res.json()),
          fetch('/api/n8n/executions?limit=10').then(res => res.json())
        ]);
        
        setHealth(healthRes);
        setWorkflows(workflowsRes.data || []);
        setExecutions(executionsRes.data || []);
      } catch (error) {
        console.error('Failed to fetch n8n data', error);
      } finally {
        setLoading(false);
      }
    }

    fetchData();
  }, []);

  const isHealthy = health?.status === 'ok';

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-[40px] w-[300px]" />
        <div className="grid gap-6 md:grid-cols-2">
          <Skeleton className="h-[400px] w-full" />
          <Skeleton className="h-[400px] w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2">
        <h2 className="text-xl font-bold tracking-tight">n8n Connection Status</h2>
        <Badge variant={isHealthy ? 'default' : 'destructive'} className={isHealthy ? 'bg-green-500' : ''}>
          {isHealthy ? <Icons.check className="mr-1 h-3 w-3" /> : <Icons.alertCircle className="mr-1 h-3 w-3" />}
          {isHealthy ? 'Connected' : 'Disconnected'}
        </Badge>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>Workflows</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Nodes</TableHead>
                  <TableHead>Updated At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {workflows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center">No workflows found.</TableCell>
                  </TableRow>
                ) : (
                  workflows.map((wf) => (
                    <TableRow key={wf.id}>
                      <TableCell className="font-medium">{wf.name}</TableCell>
                      <TableCell>
                        <Badge variant={wf.active ? 'default' : 'secondary'}>
                          {wf.active ? 'Active' : 'Inactive'}
                        </Badge>
                      </TableCell>
                      <TableCell>{wf.nodes?.length || 0}</TableCell>
                      <TableCell>{wf.updatedAt ? new Date(wf.updatedAt).toLocaleDateString() : 'N/A'}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Recent Executions</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>ID</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Mode</TableHead>
                  <TableHead>Finished At</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {executions.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center">No executions found.</TableCell>
                  </TableRow>
                ) : (
                  executions.map((exec) => (
                    <TableRow key={exec.id}>
                      <TableCell>{exec.id}</TableCell>
                      <TableCell>{exec.workflowId}</TableCell>
                      <TableCell>
                        <Badge variant={exec.status === 'success' ? 'default' : 'destructive'} className={exec.status === 'success' ? 'bg-green-500' : ''}>
                          {exec.status}
                        </Badge>
                      </TableCell>
                      <TableCell>{exec.mode}</TableCell>
                      <TableCell>{exec.finishedAt ? new Date(exec.finishedAt).toLocaleString() : 'N/A'}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
