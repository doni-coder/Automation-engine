/**
 * Webhook Trigger Node
 * 
 * This node receives incoming HTTP requests and passes the request data
 * to the next node in the workflow.
 * 
 * Configuration:
 * - path: The webhook path suffix (optional, auto-generated if not provided)
 * - method: HTTP method to listen on (GET, POST, PUT, PATCH, DELETE)
 * - responseBody: Custom response body to return (optional)
 * - responseStatusCode: Custom response status code (default: 200)
 */

export const webhookTriggerDefinition = {
  name: 'Webhook Trigger',
  type: 'webhookTrigger',
  category: 'trigger',
  icon: 'Webhook',
  description: 'Starts a workflow when an HTTP request is received',
  color: '#7c3aed',
  inputs: [],
  outputs: ['main'],
  defaults: {
    path: '',
    method: 'POST',
    responseBody: '',
    responseStatusCode: 200,
    responseHeaders: { 'Content-Type': 'application/json' },
  },
};

/**
 * Execute the webhook trigger node.
 * In the engine, this is called when a webhook request comes in.
 * 
 * @param {Object} node - The node configuration
 * @param {Object} inputs - The incoming data (from the webhook request)
 * @returns {Object} The output data to pass to the next node
 */
export async function executeWebhookTrigger(node, inputs) {
  const { method, responseBody, responseStatusCode, responseHeaders } = {
    ...webhookTriggerDefinition.defaults,
    ...node.parameters,
  };

  const output = {
    httpMethod: inputs.method || method,
    headers: inputs.headers || {},
    query: inputs.query || {},
    params: inputs.params || {},
    body: inputs.body || {},
    rawBody: inputs.rawBody || '',
    timestamp: new Date().toISOString(),
  };

  const response = {
    statusCode: responseStatusCode,
    headers: responseHeaders,
    body: responseBody ? parseResponseBody(responseBody, output) : JSON.stringify({ success: true, received: true }),
  };

  return {
    data: output,
    webhookResponse: response,
  };
}

function parseResponseBody(template, data) {
  // Simple template substitution: {{body.field}} or {{query.field}}
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const parts = path.trim().split('.');
    let value = data;
    for (const part of parts) {
      if (value && typeof value === 'object') value = value[part];
      else return match;
    }
    return value !== undefined ? String(value) : match;
  });
}
