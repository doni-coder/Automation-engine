import axios from 'axios';
import { resolveTemplate } from '../utils.js';

export const httpDefinition = {
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
};

export async function executeHttp(node, inputs) {
  const params = { ...httpDefinition.defaults, ...node.parameters };
  const { method, url, headers, body, queryParams, authentication, username, password, token, retryOnFail, maxRetries } = params;

  if (!url) {
    return { data: null, error: 'HTTP node requires a URL', success: false };
  }

  // Resolve templates
  const resolvedUrl = resolveTemplate(url, inputs);
  const resolvedHeaders = {};
  for (const [key, value] of Object.entries(headers || {})) {
    resolvedHeaders[key] = resolveTemplate(String(value), inputs);
  }
  const resolvedQuery = {};
  for (const [key, value] of Object.entries(queryParams || {})) {
    resolvedQuery[key] = resolveTemplate(String(value), inputs);
  }

  const axiosConfig = {
    method: method.toLowerCase(),
    url: resolvedUrl,
    headers: resolvedHeaders,
    params: resolvedQuery,
    timeout: 30000,
    validateStatus: () => true,
  };

  if (authentication === 'basicAuth' && username) {
    axiosConfig.auth = { username, password: password || '' };
  } else if (authentication === 'bearerToken' && token) {
    axiosConfig.headers['Authorization'] = `Bearer ${resolveTemplate(token, inputs)}`;
  }

  if (body && ['post', 'put', 'patch'].includes(method.toLowerCase())) {
    try {
      axiosConfig.data = JSON.parse(resolveTemplate(body, inputs));
      if (!resolvedHeaders['Content-Type']) {
        axiosConfig.headers['Content-Type'] = 'application/json';
      }
    } catch {
      axiosConfig.data = resolveTemplate(body, inputs);
    }
  }

  const maxAttempts = retryOnFail ? Math.max(maxRetries + 1, 1) : 1;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await axios(axiosConfig);
      const isSuccess = response.status >= 200 && response.status < 300;
      return {
        data: isSuccess ? response.data : { status: response.status, statusText: response.statusText, error: `HTTP ${response.status}: ${response.statusText}` },
        success: isSuccess,
        error: !isSuccess ? `HTTP ${response.status}: ${response.statusText}` : null,
        attempt,
      };
    } catch (error) {
      lastError = error;
      if (attempt < maxAttempts) {
        await new Promise(resolve => setTimeout(resolve, Math.pow(2, attempt) * 1000));
      }
    }
  }

  return { data: null, error: `HTTP request failed after ${maxAttempts} attempt(s): ${lastError.message}`, success: false };
}
