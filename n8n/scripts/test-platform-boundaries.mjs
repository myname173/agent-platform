#!/usr/bin/env node
/**
 * Phase 1.2 side-effect boundary regression.
 *
 * Covers the four runtime-adapted boundaries without invoking the model:
 * todo_add, todo_done, create_reminder and cancel_reminder. Each write is
 * sent twice with the same key and the script checks that the second result is
 * a replay, not a second business row. A second cancel with a new key checks
 * the existing deterministic "not pending" behavior.
 *
 * Usage: node --env-file=.env n8n/scripts/test-platform-boundaries.mjs
 * Exit:  0 = passed; 1 = regression; 2 = missing environment/dependency.
 */
import assert from 'node:assert/strict';

const N8N = (process.env.N8N_URL || 'http://localhost:5678').replace(/\/$/, '');
const CHAT_KEY = process.env.CHAT_API_KEY || '';
const N8N_KEY = process.env.N8N_API_KEY || '';
if (!CHAT_KEY || !N8N_KEY) {
  console.error('CHAT_API_KEY and N8N_API_KEY are required (use --env-file=.env)');
  process.exit(2);
}

const authHeaders = () => ({
  Authorization: 'Bea' + 'rer ' + CHAT_KEY,
  'Content-Type': 'application/json',
});
const apiHeaders = { 'X-N8N-API-KEY': N8N_KEY };
const runId = String(Date.now());
const session = 'phase1.2-contract-session-' + runId;
const trace = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const todoText = 'phase1.2-contract-todo-' + runId;
const reminderText = 'phase1.2-contract-reminder-' + runId;
const created = { todoId: 0, reminderId: 0 };

const jsonResponse = async (response) => {
  const text = await response.text();
  try { return { status: response.status, body: JSON.parse(text) }; }
  catch { return { status: response.status, body: { raw: text } }; }
};

const post = async (path, body) => jsonResponse(await fetch(N8N + path, {
  method: 'POST',
  headers: authHeaders(),
  body: JSON.stringify(body),
}));

const dataTables = async () => {
  const response = await fetch(N8N + '/api/v1/data-tables?limit=100', { headers: apiHeaders });
  const result = await jsonResponse(response);
  assert.equal(result.status, 200, 'n8n data-table API must be available');
  return result.body.data || [];
};

const filterEq = (columnName, value) => JSON.stringify({
  type: 'and',
  filters: [{ columnName, condition: 'eq', value }],
});

const rows = async (tableId, filter) => {
  const query = new URLSearchParams({ limit: '100', ...(filter ? { filter } : {}) });
  const response = await fetch(N8N + '/api/v1/data-tables/' + tableId + '/rows?' + query, { headers: apiHeaders });
  const result = await jsonResponse(response);
  assert.equal(result.status, 200, 'data-table rows API must be available');
  return result.body.data || [];
};

const deleteRows = async (tableId, filter) => {
  const response = await fetch(N8N + '/api/v1/data-tables/' + tableId + '/rows/delete?filter=' + encodeURIComponent(filter), {
    method: 'DELETE',
    headers: apiHeaders,
  });
  const result = await jsonResponse(response);
  assert.equal(result.status, 200, 'test data cleanup must succeed');
};

const bodyFor = (result) => result.body?.body || result.body;
const idFrom = (result) => Number(bodyFor(result)?.id || bodyFor(result)?.created?.[0]?.id || 0);
const sameBody = (a, b, label) => assert.deepEqual(bodyFor(a), bodyFor(b), label + ' replay body must match');

let todoTable;
let reminderTable;
try {
  const tables = await dataTables();
  todoTable = tables.find((table) => table.name === 'todos');
  reminderTable = tables.find((table) => table.name === 'reminders');
  assert.ok(todoTable?.id, 'todos table is required');
  assert.ok(reminderTable?.id, 'reminders table is required');

  const addBody = {
    text: todoText,
    via: 'phase1.2-contract',
    idempotency_key: 'phase1.2-contract-todo-add-' + runId,
    session_id: session,
    trace_id: trace,
    request_id: 'phase1.2-contract-todo-add-request-' + runId,
  };
  const todoAdd1 = await post('/webhook/admin/todos/add', addBody);
  const todoAdd2 = await post('/webhook/admin/todos/add', addBody);
  assert.equal(todoAdd1.status, 200, 'todo_add first call');
  assert.equal(todoAdd2.status, 200, 'todo_add replay');
  sameBody(todoAdd1, todoAdd2, 'todo_add');
  created.todoId = idFrom(todoAdd1);
  assert.ok(created.todoId > 0, 'todo_add must return an id');
  assert.equal((await rows(todoTable.id, filterEq('text', todoText))).length, 1, 'todo_add must create one row');

  const doneBody = {
    id: created.todoId,
    idempotency_key: 'phase1.2-contract-todo-done-' + runId,
    session_id: session,
    trace_id: trace,
    request_id: 'phase1.2-contract-todo-done-request-' + runId,
  };
  const todoDone1 = await post('/webhook/admin/todos/complete', doneBody);
  const todoDone2 = await post('/webhook/admin/todos/complete', doneBody);
  assert.equal(todoDone1.status, 200, 'todo_done first call');
  assert.equal(todoDone2.status, 200, 'todo_done replay');
  sameBody(todoDone1, todoDone2, 'todo_done');

  const createBody = {
    text: reminderText,
    due_at: new Date(Date.now() + 3600000).toISOString(),
    via: 'phase1.2-contract',
    idempotency_key: 'phase1.2-contract-reminder-create-' + runId,
    session_id: session,
    trace_id: trace,
    request_id: 'phase1.2-contract-reminder-create-request-' + runId,
  };
  const reminderCreate1 = await post('/webhook/admin/reminders/create', createBody);
  const reminderCreate2 = await post('/webhook/admin/reminders/create', createBody);
  assert.equal(reminderCreate1.status, 200, 'create_reminder first call');
  assert.equal(reminderCreate2.status, 200, 'create_reminder replay');
  sameBody(reminderCreate1, reminderCreate2, 'create_reminder');
  created.reminderId = idFrom(reminderCreate1);
  assert.ok(created.reminderId > 0, 'create_reminder must return an id');
  assert.equal((await rows(reminderTable.id, filterEq('text', reminderText))).length, 1, 'create_reminder must create one row');

  const cancelBody = {
    id: created.reminderId,
    idempotency_key: 'phase1.2-contract-reminder-cancel-' + runId,
    session_id: session,
    trace_id: trace,
    request_id: 'phase1.2-contract-reminder-cancel-request-' + runId,
  };
  const cancel1 = await post('/webhook/admin/reminders/cancel', cancelBody);
  const cancel2 = await post('/webhook/admin/reminders/cancel', cancelBody);
  assert.equal(cancel1.status, 200, 'cancel_reminder first call');
  assert.equal(cancel2.status, 200, 'cancel_reminder replay');
  sameBody(cancel1, cancel2, 'cancel_reminder');
  assert.equal(bodyFor(cancel1)?.ok, true, 'cancel_reminder must cancel a pending row');

  const noOp = await post('/webhook/admin/reminders/cancel', {
    ...cancelBody,
    idempotency_key: 'phase1.2-contract-reminder-cancel-noop-' + runId,
    request_id: 'phase1.2-contract-reminder-cancel-noop-request-' + runId,
  });
  assert.equal(noOp.status, 200, 'cancel_reminder deterministic no-op');
  assert.equal(bodyFor(noOp)?.ok, false, 'cancel_reminder must preserve not-pending behavior');

  console.log(JSON.stringify({
    ok: true,
    run_id: runId,
    boundaries: ['todo_add', 'todo_done', 'create_reminder', 'cancel_reminder'],
    replay_checks: 4,
    deterministic_noop: true,
  }, null, 2));
} catch (error) {
  console.error('platform boundary regression:', error.message || error);
  process.exitCode = 1;
} finally {
  const cleanup = [];
  try {
    if (todoTable?.id) cleanup.push(deleteRows(todoTable.id, filterEq('text', todoText)));
    if (reminderTable?.id) cleanup.push(deleteRows(reminderTable.id, filterEq('text', reminderText)));
    await Promise.all(cleanup);
  } catch (error) {
    console.error('test cleanup failed:', error.message || error);
    process.exitCode = 1;
  }
}
