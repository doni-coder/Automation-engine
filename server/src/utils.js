/**
 * Resolve template variables in a string using data from previous nodes.
 * Supports:
 *   - {{ field.subfield }} — nested property access via dot notation
 *   - {{ field[0] }} or {{ field[0].subfield }} — array index access via bracket notation
 *   - {{ $node.nodeId.body[0].id }} — cross-node references in workflow context
 *
 * @param {string} template - The template string with {{ }} placeholders
 * @param {Object} data - The data object to resolve against
 * @returns {string} The resolved string
 */
export function resolveTemplate(template, data) {
  if (!template || typeof template !== 'string') return template;
  return template.replace(/\{\{([^}]+)\}\}/g, (match, path) => {
    const trimmedPath = path.trim();
    // Normalize bracket notation to dot notation: body[46] -> body.[46]
    const normalized = trimmedPath.replace(/\[/g, '.[');
    const parts = normalized.split('.');
    let value = data;
    for (const part of parts) {
      if (!part) continue;

      if (value === null || value === undefined) {
        return match; // Keep unresolved placeholders as-is
      }

      // Handle bare bracket notation: [46]
      const bareBracket = part.match(/^\[(\d+)\]$/);
      if (bareBracket) {
        const index = parseInt(bareBracket[1], 10);
        if (Array.isArray(value) && index >= 0 && index < value.length) {
          value = value[index];
          continue;
        }
        return match;
      }

      // Handle property with bracket accessor: body[46]
      const propBracket = part.match(/^([^\[]+)\[(\d+)\]$/);
      if (propBracket) {
        const prop = propBracket[1];
        const index = parseInt(propBracket[2], 10);
        if (value && typeof value === 'object' && prop in value) {
          const arr = value[prop];
          if (Array.isArray(arr) && index >= 0 && index < arr.length) {
            value = arr[index];
            continue;
          }
        }
        return match;
      }

      // Standard property access
      if (value && typeof value === 'object' && part in value) {
        value = value[part];
      } else {
        return match; // Keep unresolved placeholders as-is
      }
    }
    return value !== undefined && value !== null ? String(value) : match;
  });
}
