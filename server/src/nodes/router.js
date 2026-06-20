import { resolveTemplate } from '../utils.js';

/**
 * Router Node
 *
 * Evaluates conditions against input data and routes to matching output branches.
 * Each branch has a label, field expression, operator, and value.
 * Supports a fallback branch for unmatched data.
 *
 * Configuration:
 * - conditions: Array of branch configs [{ label, field, operator, value }]
 * - fallbackBranch: Whether to include a fallback output for unmatched data
 * - mode: 'firstMatch' (route to first matching) or 'allMatches' (route to all matching)
 */

const operators = {
  equals: (a, b) => String(a) === String(b),
  notEquals: (a, b) => String(a) !== String(b),
  contains: (a, b) => String(a ?? '').includes(String(b ?? '')),
  notContains: (a, b) => !String(a ?? '').includes(String(b ?? '')),
  startsWith: (a, b) => String(a ?? '').startsWith(String(b ?? '')),
  endsWith: (a, b) => String(a ?? '').endsWith(String(b ?? '')),
  greaterThan: (a, b) => Number(a) > Number(b),
  lessThan: (a, b) => Number(a) < Number(b),
  greaterEqual: (a, b) => Number(a) >= Number(b),
  lessEqual: (a, b) => Number(a) <= Number(b),
  isEmpty: (a) => a === undefined || a === null || a === '',
  isNotEmpty: (a) => a !== undefined && a !== null && a !== '',
  exists: (a) => a !== undefined && a !== null,
  regex: (a, b) => {
    try {
      return new RegExp(String(b ?? ''), 'i').test(String(a ?? ''));
    } catch {
      return false;
    }
  },
};

export const routerDefinition = {
  name: 'Router',
  type: 'router',
  category: 'flow',
  icon: 'GitBranch',
  description: 'Route data to different branches based on conditions',
  color: '#f59e0b',
  inputs: ['main'],
  outputs: [], // Dynamic - generated based on conditions
  defaults: {
    conditions: [
      { label: 'Branch 1', field: '', operator: 'equals', value: '' },
      { label: 'Branch 2', field: '', operator: 'equals', value: '' },
    ],
    fallbackBranch: true,
    mode: 'firstMatch',
  },
};

/**
 * Evaluate a single condition against the input data.
 */
function evaluateCondition(condition, inputData) {
  const { field, operator, value } = condition;

  // Resolve field and value templates
  const resolvedField = field ? resolveTemplate(field, inputData) : inputData;
  const resolvedValue = value ? resolveTemplate(value, inputData) : '';

  const evaluator = operators[operator];
  if (!evaluator) {
    return false;
  }

  // Operators that don't take a value argument (e.g., isEmpty, exists)
  const noValueOps = ['isEmpty', 'isNotEmpty', 'exists'];
  if (noValueOps.includes(operator)) {
    return evaluator(resolvedField);
  }

  return evaluator(resolvedField, resolvedValue);
}

/**
 * Execute the Router node.
 *
 * @param {Object} node - The node configuration
 * @param {Object} inputs - The incoming data from the previous node
 * @returns {Object} Result with matched branches
 */
export async function executeRouter(node, inputs) {
  const params = { ...routerDefinition.defaults, ...node.parameters };
  const { conditions, fallbackBranch, mode } = params;

  if (!conditions || conditions.length === 0) {
    return {
      data: { matchedBranches: [], matchedOutputs: [] },
      error: 'Router node has no conditions configured',
      success: false,
    };
  }

  const matchedOutputs = [];
  let anyMatched = false;

  for (let i = 0; i < conditions.length; i++) {
    const condition = conditions[i];
    if (!condition.field) continue;

    const isMatch = evaluateCondition(condition, inputs);

    if (isMatch) {
      matchedOutputs.push(i);
      anyMatched = true;
      if (mode === 'firstMatch') break;
    }
  }

  // If no branch matched and fallback is enabled, route to fallback
  if (!anyMatched && fallbackBranch) {
    matchedOutputs.push('fallback');
  }

  return {
    data: {
      matchedBranches: matchedOutputs.map(idx =>
        idx === 'fallback'
          ? { label: 'Fallback', outputIndex: 'fallback' }
          : { label: conditions[idx]?.label || `Branch ${idx + 1}`, outputIndex: idx }
      ),
      matchedOutputs,
      inputData: inputs,
      anyMatched,
    },
    success: true,
    error: null,
  };
}
