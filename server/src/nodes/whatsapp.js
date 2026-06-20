import axios from 'axios';
import { resolveTemplate } from '../utils.js';

export const whatsappDefinition = {
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
};

export async function executeWhatsApp(node, inputs) {
  const params = { ...whatsappDefinition.defaults, ...node.parameters };
  const { accessToken, phoneNumberId, to, messageType, messageBody, templateName, templateLanguage, templateParameters } = params;

  if (!accessToken || !phoneNumberId || !to) {
    return { data: null, error: 'WhatsApp node requires accessToken, phoneNumberId, and to fields', success: false };
  }

  const resolvedTo = resolveTemplate(to, inputs);
  const resolvedBody = resolveTemplate(messageBody, inputs);
  const resolvedParams = (templateParameters || []).map(p =>
    typeof p === 'string' ? resolveTemplate(p, inputs) : p
  );

  try {
    const messagePayload = messageType === 'template'
      ? {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: resolvedTo,
          type: 'template',
          template: {
            name: templateName,
            language: { code: templateLanguage },
            components: resolvedParams.length > 0 ? [{
              type: 'body',
              parameters: resolvedParams.map(p => ({ type: 'text', text: String(p) })),
            }] : [],
          },
        }
      : {
          messaging_product: 'whatsapp',
          recipient_type: 'individual',
          to: resolvedTo,
          type: 'text',
          text: { preview_url: false, body: resolvedBody },
        };

    const response = await axios.post(
      `https://graph.facebook.com/v20.0/${phoneNumberId}/messages`,
      messagePayload,
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
    );

    return {
      data: { messageId: response.data.messages?.[0]?.id, to: resolvedTo, type: messageType, status: 'sent', apiResponse: response.data },
      success: true,
      error: null,
    };
  } catch (error) {
    return { data: null, error: `WhatsApp API error: ${error.response?.data?.error?.message || error.message}`, success: false };
  }
}
