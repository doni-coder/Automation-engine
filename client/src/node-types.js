/**
 * Node type definitions embedded directly in the frontend.
 * This ensures the node palette always renders, even if the server
 * is not running. The server API is only needed for workflow execution.
 */
export const NODE_TYPES = {
  webhookTrigger: {
    definition: {
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
    },
  },
  whatsapp: {
    definition: {
      name: 'WhatsApp',
      type: 'whatsapp',
      category: 'communication',
      icon: 'MessageCircle',
      description: 'Send WhatsApp messages via the Business API',
      color: '#25D366',
      inputs: ['main'],
      outputs: ['main'],
      defaults: {
        accessToken: '',
        phoneNumberId: '',
        to: '',
        messageType: 'text',
        messageBody: 'Hello from n8n-clone!',
        templateName: '',
        templateLanguage: 'en_US',
        templateParameters: [],
      },
    },
  },
  http: {
    definition: {
      name: 'HTTP Request',
      type: 'http',
      category: 'communication',
      icon: 'Globe',
      description: 'Make HTTP requests to external APIs',
      color: '#3b82f6',
      inputs: ['main'],
      outputs: ['main'],
      defaults: {
        method: 'GET',
        url: '',
        headers: {},
        body: '',
        queryParams: {},
        authentication: 'none',
        username: '',
        password: '',
        token: '',
        retryOnFail: false,
        maxRetries: 0,
      },
    },
  },
  router: {
    definition: {
      name: 'Router',
      type: 'router',
      category: 'flow',
      icon: 'GitBranch',
      description: 'Route data to different branches based on conditions',
      color: '#f59e0b',
      inputs: ['main'],
      outputs: [], // Dynamic — generated based on conditions + fallback
      defaults: {
        conditions: [
          { label: 'Branch 1', field: '', operator: 'equals', value: '' },
          { label: 'Branch 2', field: '', operator: 'equals', value: '' },
        ],
        fallbackBranch: true,
        mode: 'firstMatch',
      },
    },
  },
  aiModel: {
    definition: {
      name: 'AI Model',
      type: 'aiModel',
      category: 'ai',
      icon: 'Brain',
      description: 'Send prompts to Google Gemini AI and get responses',
      color: '#4285F4',
      inputs: ['main'],
      outputs: ['main'],
      defaults: {
        apiKey: '',
        model: 'gemini-1.5-flash',
        systemPrompt: 'You are a helpful assistant.',
        userMessage: '',
        temperature: 0.7,
        maxOutputTokens: 2048,
      },
    },
  },
};
