/**
 * AI Model Node
 *
 * Integrates with Google Gemini API for chat completions.
 * Supports system prompts, user messages with template expressions,
 * configurable model selection, temperature, and max output tokens.
 *
 * Configuration:
 * - apiKey: Google AI Studio API key
 * - model: Gemini model (gemini-2.0-flash, gemini-1.5-flash, gemini-1.5-pro, gemini-2.0-pro)
 * - systemPrompt: System/instructions prompt
 * - userMessage: User message (supports {{ }} template expressions)
 * - temperature: Response creativity (0.0 - 2.0)
 * - maxOutputTokens: Maximum tokens in the response
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { resolveTemplate } from '../utils.js';

export const aiModelDefinition = {
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
};

const SUPPORTED_MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-1.5-pro',
  'gemini-2.0-pro',
];

/**
 * Execute the AI Model node.
 *
 * @param {Object} node - The node configuration
 * @param {Object} inputs - The incoming data from the previous node
 * @returns {Object} The AI response data
 */
export async function executeAiModel(node, inputs) {
  const params = { ...aiModelDefinition.defaults, ...node.parameters };
  const { apiKey, model, systemPrompt, userMessage, temperature, maxOutputTokens } = params;

  if (!apiKey) {
    return { data: null, error: 'AI Model node requires an API key', success: false };
  }

  // Resolve templates in the prompts
  const resolvedSystemPrompt = resolveTemplate(systemPrompt || '', inputs);
  const resolvedUserMessage = resolveTemplate(userMessage || '', inputs);

  if (!resolvedUserMessage) {
    return { data: null, error: 'AI Model node requires a user message', success: false };
  }

  try {
    const genAI = new GoogleGenerativeAI(apiKey);

    // Pick the model — fallback to gemini-1.5-flash if invalid
    const modelName = SUPPORTED_MODELS.includes(model) ? model : 'gemini-1.5-flash';

    const generativeModel = genAI.getGenerativeModel({
      model: modelName,
      systemInstruction: resolvedSystemPrompt,
      generationConfig: {
        temperature: Number(temperature) || 0.7,
        maxOutputTokens: Number(maxOutputTokens) || 2048,
      },
    });

    const chat = generativeModel.startChat();
    const result = await chat.sendMessage(resolvedUserMessage);
    const response = await result.response;
    const text = response.text();

    // Also extract usage metadata if available
    const usageMetadata = response.usageMetadata || null;

    return {
      data: {
        text,
        model: modelName,
        usage: usageMetadata
          ? {
              promptTokens: usageMetadata.promptTokenCount,
              candidatesTokens: usageMetadata.candidatesTokenCount,
              totalTokens: usageMetadata.totalTokenCount,
            }
          : null,
        finishReason: response.candidates?.[0]?.finishReason || null,
      },
      success: true,
      error: null,
    };
  } catch (error) {
    return {
      data: null,
      error: `Gemini API error: ${error.message}`,
      success: false,
    };
  }
}
