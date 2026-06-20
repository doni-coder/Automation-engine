import { v4 as uuidv4 } from 'uuid';

/**
 * In-memory data store for workflows, executions, and webhook mappings.
 * In a production system this would be a database (PostgreSQL, etc.).
 */
class MemoryStore {
  constructor() {
    this.workflows = new Map();
    this.executions = new Map();
    this.webhookMappings = new Map(); // webhookId -> workflowId
  }

  // ---- Workflows ----

  listWorkflows() {
    return Array.from(this.workflows.values());
  }

  getWorkflow(id) {
    return this.workflows.get(id) || null;
  }

  createWorkflow(data) {
    const now = new Date().toISOString();
    const workflow = {
      id: uuidv4(),
      name: data.name || 'Untitled Workflow',
      description: data.description || '',
      nodes: data.nodes || [],
      edges: data.edges || [],
      active: false,
      webhookId: null,
      createdAt: now,
      updatedAt: now,
    };

    // Generate webhook ID if there's a webhook trigger node
    const webhookNode = workflow.nodes.find(n => n.type === 'webhookTrigger');
    if (webhookNode) {
      workflow.webhookId = uuidv4().slice(0, 8);
      this.webhookMappings.set(workflow.webhookId, workflow.id);
    }

    this.workflows.set(workflow.id, workflow);
    return workflow;
  }

  updateWorkflow(id, data) {
    const existing = this.workflows.get(id);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...data,
      id,
      updatedAt: new Date().toISOString(),
    };

    // Handle webhook mapping changes
    if (data.nodes) {
      const hadWebhook = existing.nodes.some(n => n.type === 'webhookTrigger');
      const hasWebhook = data.nodes.some(n => n.type === 'webhookTrigger');

      if (hasWebhook && !hadWebhook) {
        // Webhook trigger was added — create new webhook ID
        updated.webhookId = uuidv4().slice(0, 8);
        this.webhookMappings.set(updated.webhookId, id);
      } else if (!hasWebhook && hadWebhook) {
        // Webhook trigger was removed — clean up mapping
        if (existing.webhookId) {
          this.webhookMappings.delete(existing.webhookId);
        }
        updated.webhookId = null;
      }
      // If webhook existed and still exists, keep the same webhookId
    }

    this.workflows.set(id, updated);
    return updated;
  }

  deleteWorkflow(id) {
    const workflow = this.workflows.get(id);
    if (workflow && workflow.webhookId) {
      this.webhookMappings.delete(workflow.webhookId);
    }
    return this.workflows.delete(id);
  }

  toggleActive(id, active) {
    const workflow = this.workflows.get(id);
    if (!workflow) return null;
    workflow.active = active;
    workflow.updatedAt = new Date().toISOString();
    return workflow;
  }

  getWorkflowByWebhookId(webhookId) {
    const workflowId = this.webhookMappings.get(webhookId);
    if (!workflowId) return null;
    const workflow = this.workflows.get(workflowId);
    if (!workflow || !workflow.active) return null;
    return workflow;
  }

  // ---- Executions ----

  listExecutions(workflowId = null) {
    const all = Array.from(this.executions.values());
    if (workflowId) {
      return all.filter(e => e.workflowId === workflowId).sort((a, b) =>
        new Date(b.startedAt) - new Date(a.startedAt)
      );
    }
    return all.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt));
  }

  getExecution(id) {
    return this.executions.get(id) || null;
  }

  createExecution(workflowId, triggerData = {}) {
    const execution = {
      id: uuidv4().slice(0, 12),
      workflowId,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      triggerData,
      nodeResults: [],
      error: null,
    };
    this.executions.set(execution.id, execution);
    return execution;
  }

  updateExecution(id, data) {
    const existing = this.executions.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...data };
    this.executions.set(id, updated);
    return updated;
  }
}

const store = new MemoryStore();
export default store;
