const API_BASE = '/api';

async function request(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const config = {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  };

  const response = await fetch(url, config);
  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }

  return data;
}

export const api = {
  // Workflows
  listWorkflows: () => request('/workflows'),
  getWorkflow: (id) => request(`/workflows/${id}`),
  createWorkflow: (data) => request('/workflows', {
    method: 'POST',
    body: JSON.stringify(data),
  }),
  updateWorkflow: (id, data) => request(`/workflows/${id}`, {
    method: 'PUT',
    body: JSON.stringify(data),
  }),
  deleteWorkflow: (id) => request(`/workflows/${id}`, {
    method: 'DELETE',
  }),
  toggleWorkflow: (id, active) => request(`/workflows/${id}/toggle`, {
    method: 'POST',
    body: JSON.stringify({ active }),
  }),
  testWorkflow: (id, data = {}) => request(`/workflows/${id}/test`, {
    method: 'POST',
    body: JSON.stringify({ data }),
  }),

  // Test a single node with custom input data
  executeNode: (workflowId, nodeId, inputData = {}) => request(`/workflows/${workflowId}/execute-node`, {
    method: 'POST',
    body: JSON.stringify({ nodeId, inputData }),
  }),

  // Test a single node by running the full workflow up to that node
  testNode: (workflowId, nodeId, triggerData = {}) => request(`/workflows/${workflowId}/test-node`, {
    method: 'POST',
    body: JSON.stringify({ nodeId, triggerData }),
  }),

  // Node Types
  getNodeTypes: () => request('/workflows/types'),

  // Executions
  listExecutions: (workflowId) => {
    const query = workflowId ? `?workflowId=${workflowId}` : '';
    return request(`/executions${query}`);
  },
  getExecution: (id) => request(`/executions/${id}`),

  // Live execution via SSE
  subscribeToExecution: (executionId, handlers) => {
    const eventSource = new EventSource(`/api/executions/${executionId}/stream`);

    eventSource.addEventListener('connected', (e) => {
      const data = JSON.parse(e.data);
      handlers.onConnected?.(data);
    });

    eventSource.addEventListener('started', (e) => {
      const data = JSON.parse(e.data);
      handlers.onStarted?.(data);
    });

    eventSource.addEventListener('node:started', (e) => {
      const data = JSON.parse(e.data);
      handlers.onNodeStarted?.(data);
    });

    eventSource.addEventListener('node:success', (e) => {
      const data = JSON.parse(e.data);
      handlers.onNodeSuccess?.(data);
    });

    eventSource.addEventListener('node:error', (e) => {
      const data = JSON.parse(e.data);
      handlers.onNodeError?.(data);
    });

    eventSource.addEventListener('node:skipped', (e) => {
      const data = JSON.parse(e.data);
      handlers.onNodeSkipped?.(data);
    });

    eventSource.addEventListener('completed', (e) => {
      const data = JSON.parse(e.data);
      handlers.onCompleted?.(data);
      eventSource.close();
    });

    eventSource.onerror = (err) => {
      handlers.onError?.(err);
      eventSource.close();
    };

    // Return unsubscribe function
    return () => {
      eventSource.close();
    };
  },
};
