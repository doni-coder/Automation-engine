import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  Panel,
  useNodesState,
  useEdgesState,
  addEdge,
  MarkerType,
  Handle,
  Position,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { api } from './api/client.js';
import { NODE_TYPES as EMBEDDED_NODE_TYPES } from './node-types.js';
import { Icon } from './icons.jsx';

// ---- Custom Node Component ----
function WorkflowNode({ data, selected }) {
  const icon = data.icon || 'Zap';
  const color = data.color || '#6b7280';
  const isTrigger = data.type === 'webhookTrigger';
  const isRouter = data.type === 'router';
  const executionStatus = data.executionStatus || 'idle';

  // Compute outputs (dynamic for router)
  const outputs = data.outputs || ['main'];

  // Build node classes based on execution status
  const nodeClasses = [
    'workflow-node',
    selected ? 'selected' : '',
    executionStatus !== 'idle' ? `exec-${executionStatus}` : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={nodeClasses}
      style={{
        borderColor: color,
        '--node-color': color,
      }}
    >
      {executionStatus === 'running' && (
        <div className="execution-overlay running">
          <div className="exec-spinner"></div>
        </div>
      )}
      {executionStatus === 'success' && (
        <div className="execution-overlay success">✓</div>
      )}
      {executionStatus === 'error' && (
        <div className="execution-overlay error">✕</div>
      )}

      {!isTrigger && (
        <Handle
          type="target"
          position={Position.Top}
          style={{ background: color, width: 10, height: 10, border: '2px solid var(--handle-border)' }}
        />
      )}
      <div className="node-header" style={{ background: color }}>
        <span className="node-icon"><Icon name={icon} size={14} /></span>
        <span className="node-type-label">
          {isTrigger ? 'TRIGGER' : isRouter ? 'ROUTER' : 'ACTION'}
        </span>
      </div>
      <div className="node-body">
        <div className="node-name">{data.label || 'Node'}</div>
        <div className="node-type">{data.type}</div>
      </div>

      {/* Multiple source handles for Router nodes — arranged horizontally at the bottom */}
      {isRouter && outputs.length > 1 ? (
        <div className="router-outputs">
          {outputs.map((output, idx) => (
            <div key={idx} className="router-output-row">
              <Handle
                type="source"
                position={Position.Bottom}
                id={idx === outputs.length - 1 && output === 'Fallback' ? 'fallback' : `output_${idx}`}
                style={{
                  background: getOutputColor(idx, outputs.length),
                  width: 10,
                  height: 10,
                  border: '2px solid var(--handle-border)',
                }}
              />
              <span className="router-output-label">{output}</span>
            </div>
          ))}
        </div>
      ) : (
        <Handle
          type="source"
          position={Position.Bottom}
          style={{ background: color, width: 10, height: 10, border: '2px solid var(--handle-border)' }}
        />
      )}
    </div>
  );
}

function getOutputColor(index, total) {
  const colors = ['#f59e0b', '#22c55e', '#3b82f6', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];
  return colors[index % colors.length];
}

const nodeTypes = { workflowNode: WorkflowNode };

// ---- Helpers ----
function formatJsonParam(value, fallback) {
  if (value === undefined || value === null || value === '') return JSON.stringify(fallback, null, 2);
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  // If it's already a string, it might be valid JSON or just text
  try {
    const parsed = JSON.parse(value);
    return JSON.stringify(parsed, null, 2);
  } catch {
    return value;
  }
}

// ---- Chain constants ----
const CHAIN_STEP_X = 300;
const CHAIN_START_X = 100;
const CHAIN_Y = 250;

/**
 * Get the next position in the chain (right of the last node).
 * If no nodes exist, returns the start position.
 */
function getNextChainPosition(nodes) {
  if (nodes.length === 0) {
    return { x: CHAIN_START_X, y: CHAIN_Y };
  }
  const maxX = Math.max(...nodes.map(n => n.position.x || 0));
  return { x: maxX + CHAIN_STEP_X, y: CHAIN_Y };
}

/**
 * Compute default outputs for a node type (router has dynamic branches).
 */
function computeDefaultOutputs(type, defaults) {
  if (type === 'router') {
    const conditions = defaults.conditions || [];
    const labels = conditions.map(c => c.label || 'Branch');
    if (defaults.fallbackBranch !== false) {
      labels.push('Fallback');
    }
    return labels;
  }
  return ['main'];
}

export default function App() {
  const [workflows, setWorkflows] = useState([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState(null);
  const [nodeTypesMeta, setNodeTypesMeta] = useState(EMBEDDED_NODE_TYPES);
  const [executions, setExecutions] = useState([]);
  const [selectedExecutionId, setSelectedExecutionId] = useState(null);
  const [view, setView] = useState('editor'); // 'editor' | 'executions'
  const [showNewWorkflow, setShowNewWorkflow] = useState(false);
  const [newWorkflowName, setNewWorkflowName] = useState('');
  const [saving, setSaving] = useState(false);
  const [notification, setNotification] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const reactFlowWrapper = useRef(null);
  const [reactFlowInstance, setReactFlowInstance] = useState(null);

  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);

  // Live execution state
  const [isExecuting, setIsExecuting] = useState(false);
  const [executionNodeStatuses, setExecutionNodeStatuses] = useState({}); // nodeId -> 'running'|'success'|'error'
  const [executionProgress, setExecutionProgress] = useState({ completed: 0, total: 0 });
  const unsubSse = useRef(null);

  // Expression editor state
  const [expressionPanelOpen, setExpressionPanelOpen] = useState(false);
  const [activeExprField, setActiveExprField] = useState(null); // { nodeId, fieldKey, currentValue }
  const [nodeExecutionOutputs, setNodeExecutionOutputs] = useState({}); // nodeId -> { name, type, outputData, status }

  // Theme state
  const [theme, setTheme] = useState(() => localStorage.getItem('theme') || 'light');

  // Sync theme attribute to html element and persist
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  // Resizable panel widths
  const [leftPanelWidth, setLeftPanelWidth] = useState(230);
  const [rightPanelWidth, setRightPanelWidth] = useState(320);

  // Resize handlers
  const startResize = useCallback((panel, e) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = panel === 'left' ? leftPanelWidth : rightPanelWidth;

    const handleMouseMove = (e) => {
      const delta = e.clientX - startX;
      if (panel === 'left') {
        setLeftPanelWidth(Math.max(180, Math.min(400, startWidth + delta)));
      } else {
        setRightPanelWidth(Math.max(260, Math.min(500, startWidth - delta)));
      }
    };

    const handleMouseUp = () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, [leftPanelWidth, rightPanelWidth]);

  // Individual node test state
  const [testingNodeId, setTestingNodeId] = useState(null);
  const [nodeTestResults, setNodeTestResults] = useState({}); // nodeId -> { output, error, status }

  // Show notification
  const showNotification = useCallback((message, type = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  }, []);

  // ---- Load data ----
  const loadWorkflows = useCallback(async () => {
    try {
      const data = await api.listWorkflows();
      setWorkflows(data.workflows);
    } catch (err) {
      console.error('Failed to load workflows:', err);
    }
  }, []);

  const loadNodeTypes = useCallback(async () => {
    try {
      const data = await api.getNodeTypes();
      // Merge API node types on top of embedded ones (API can override)
      setNodeTypesMeta(prev => ({ ...prev, ...data.nodeTypes }));
    } catch (err) {
      // Embedded node types already loaded — API is only needed for execution
      console.log('Server not available — using embedded node types');
    }
  }, []);

  const loadExecutions = useCallback(async (workflowId) => {
    try {
      const data = await api.listExecutions(workflowId);
      setExecutions(data.executions);
    } catch (err) {
      console.error('Failed to load executions:', err);
    }
  }, []);

  useEffect(() => {
    loadWorkflows();
    loadNodeTypes();
  }, [loadWorkflows, loadNodeTypes]);

  // Load workflow nodes into React Flow
  const loadWorkflowIntoEditor = useCallback(async (workflowId) => {
    setSelectedNode(null);
    try {
      const data = await api.getWorkflow(workflowId);
      const workflow = data.workflow;
      setActiveWorkflowId(workflow.id);

      // Compute outputs for Router nodes
      const computeOutputs = (node) => {
        if (node.type === 'router') {
          const params = node.parameters || {};
          const conditions = params.conditions || [];
          const labels = conditions.map(c => c.label || 'Branch');
          if (params.fallbackBranch !== false) {
            labels.push('Fallback');
          }
          return labels;
        }
        return ['main'];
      };

      let savedNodes = workflow.nodes || [];

      // If no nodes exist, auto-create a webhook trigger
      if (savedNodes.length === 0) {
        const defaultTriggerId = `webhookTrigger_${Date.now()}`;
        savedNodes = [{
          id: defaultTriggerId,
          name: 'Webhook Trigger',
          type: 'webhookTrigger',
          position: { x: CHAIN_START_X, y: CHAIN_Y },
          parameters: { method: 'POST', responseStatusCode: 200, responseHeaders: { 'Content-Type': 'application/json' } },
        }];
        // Save the trigger to the server
        await api.updateWorkflow(workflowId, { nodes: savedNodes, edges: [] });
      }

      // Map stored nodes to React Flow format
      const flowNodes = savedNodes.map(node => ({
        id: node.id,
        type: 'workflowNode',
        position: node.position || { x: CHAIN_START_X, y: CHAIN_Y },
        data: {
          label: node.name || node.type,
          type: node.type,
          icon: nodeTypesMeta[node.type]?.definition?.icon || 'Zap',
          color: nodeTypesMeta[node.type]?.definition?.color || '#6b7280',
          parameters: node.parameters || {},
          outputs: computeOutputs(node),
          executionStatus: 'idle',
        },
      }));

      // Map stored edges to React Flow format
      const flowEdges = (workflow.edges || []).map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        type: 'smoothstep',
        animated: true,
        style: { stroke: 'var(--edge-color)', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge-color)' },
      }));

      setNodes(flowNodes);
      setEdges(flowEdges);
      loadExecutions(workflowId);
    } catch (err) {
      console.error('Failed to load workflow:', err);
      showNotification('Failed to load workflow', 'error');
    }
  }, [nodeTypesMeta, setNodes, setEdges, loadExecutions, showNotification]);

  // ---- Create workflow ----
  const createWorkflow = useCallback(async () => {
    if (!newWorkflowName.trim()) return;
    try {
      const data = await api.createWorkflow({ name: newWorkflowName.trim() });
      const workflowId = data.workflow.id;

      // Auto-add a webhook trigger node as the start of the chain
      const webhookNodeId = `webhookTrigger_${Date.now()}`;
      const triggerData = {
        nodes: [{
          id: webhookNodeId,
          name: 'Webhook Trigger',
          type: 'webhookTrigger',
          position: { x: CHAIN_START_X, y: CHAIN_Y },
          parameters: { method: 'POST', responseStatusCode: 200, responseHeaders: { 'Content-Type': 'application/json' } },
        }],
        edges: [],
      };
      await api.updateWorkflow(workflowId, triggerData);

      setWorkflows(prev => [...prev, { ...data.workflow, nodes: triggerData.nodes, edges: triggerData.edges }]);
      setNewWorkflowName('');
      setShowNewWorkflow(false);
      showNotification('Workflow created with trigger node!');
      loadWorkflowIntoEditor(workflowId);
    } catch (err) {
      showNotification('Failed to create workflow', 'error');
    }
  }, [newWorkflowName, loadWorkflowIntoEditor, showNotification]);

  // ---- Save workflow ----
  const saveWorkflow = useCallback(async () => {
    if (!activeWorkflowId) return;
    setSaving(true);
    try {
      const workflowData = {
        nodes: nodes.map(node => ({
          id: node.id,
          name: node.data.label,
          type: node.data.type,
          position: node.position,
          parameters: node.data.parameters || {},
        })),
        edges: edges.map(edge => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle || 'main',
          targetHandle: edge.targetHandle || 'main',
        })),
      };

      await api.updateWorkflow(activeWorkflowId, workflowData);
      showNotification('Workflow saved!');
      await loadWorkflows();
    } catch (err) {
      showNotification('Failed to save workflow', 'error');
    }
    setSaving(false);
  }, [activeWorkflowId, nodes, edges, loadWorkflows, showNotification]);

  // ---- Toggle active ----
  const toggleActive = useCallback(async (id, active) => {
    try {
      const data = await api.toggleWorkflow(id, active);
      setWorkflows(prev => prev.map(w => w.id === id ? data.workflow : w));
      showNotification(active ? 'Workflow activated!' : 'Workflow deactivated');
    } catch (err) {
      showNotification('Failed to toggle workflow', 'error');
    }
  }, [showNotification]);

  // ---- Delete workflow ----
  const deleteWorkflow = useCallback(async (id) => {
    try {
      await api.deleteWorkflow(id);
      setWorkflows(prev => prev.filter(w => w.id !== id));
      if (activeWorkflowId === id) {
        setActiveWorkflowId(null);
        setNodes([]);
        setEdges([]);
      }
      showNotification('Workflow deleted');
    } catch (err) {
      showNotification('Failed to delete workflow', 'error');
    }
  }, [activeWorkflowId, setNodes, setEdges, showNotification]);

  // ---- Expression editor handlers ----
  const openExpressionPanel = useCallback((nodeId, fieldKey, currentValue) => {
    setActiveExprField({ nodeId, fieldKey, currentValue });
    setExpressionPanelOpen(true);
  }, []);

  const closeExpressionPanel = useCallback(() => {
    setExpressionPanelOpen(false);
    setActiveExprField(null);
  }, []);

  // ---- Update node parameters ----
  const updateNodeParameters = useCallback((nodeId, parameters) => {
    setNodes(nds => nds.map(n => {
      if (n.id === nodeId) {
        // Recompute outputs for Router nodes when conditions change
        let outputs = n.data.outputs;
        if (n.data.type === 'router') {
          const mergedParams = { ...n.data.parameters, ...parameters };
          const conditions = mergedParams.conditions || [];
          const labels = conditions.map(c => c.label || 'Branch');
          if (mergedParams.fallbackBranch !== false) {
            labels.push('Fallback');
          }
          outputs = labels;
        }

        return {
          ...n,
          data: {
            ...n.data,
            parameters: { ...n.data.parameters, ...parameters },
            outputs,
          },
        };
      }
      return n;
    }));
    // Update selected node too
    setSelectedNode(prev => prev && prev.id === nodeId ? {
      ...prev,
      data: {
        ...prev.data,
        parameters: { ...prev.data.parameters, ...parameters },
        outputs: prev.data.type === 'router'
          ? (() => {
              const mergedParams = { ...prev.data.parameters, ...parameters };
              const conditions = mergedParams.conditions || [];
              const labels = conditions.map(c => c.label || 'Branch');
              if (mergedParams.fallbackBranch !== false) {
                labels.push('Fallback');
              }
              return labels;
            })()
          : prev.data.outputs,
      },
    } : prev);
  }, [setNodes]);

  const insertExpressionReference = useCallback((path) => {
    if (!activeExprField) return;
    // Insert the reference at cursor position or append
    const ref = `{{${path}}}`;
    updateNodeParameters(activeExprField.nodeId, {
      [activeExprField.fieldKey]: (activeExprField.currentValue || '') + ref,
    });
    setActiveExprField(prev => prev ? { ...prev, currentValue: (prev.currentValue || '') + ref } : null);
  }, [activeExprField, updateNodeParameters]);

  // ---- Individual node testing ----
  const testSingleNode = useCallback(async (nodeId) => {
    if (!activeWorkflowId) return;
    setTestingNodeId(nodeId);

    try {
      // Auto-save the workflow first so the server has the latest nodes
      const workflowData = {
        nodes: nodes.map(node => ({
          id: node.id,
          name: node.data.label,
          type: node.data.type,
          position: node.position,
          parameters: node.data.parameters || {},
        })),
        edges: edges.map(edge => ({
          id: edge.id,
          source: edge.source,
          target: edge.target,
          sourceHandle: edge.sourceHandle || 'main',
          targetHandle: edge.targetHandle || 'main',
        })),
      };
      await api.updateWorkflow(activeWorkflowId, workflowData);

      // Use the test-node endpoint which runs workflow up to this node
      const triggerData = { test: true, timestamp: new Date().toISOString(), message: 'Node test' };
      const data = await api.testNode(activeWorkflowId, nodeId, triggerData);

      // Store all node outputs for the expression editor
      if (data.allNodeOutputs) {
        setNodeExecutionOutputs(data.allNodeOutputs);
      }

      // Store this node's result
      if (data.nodeResult) {
        setNodeTestResults(prev => ({
          ...prev,
          [nodeId]: {
            output: data.nodeResult.outputData,
            status: data.nodeResult.status,
            error: data.nodeResult.error,
            inputData: data.nodeResult.inputData,
          },
        }));

        // Also show the execution panel for this node
        if (data.nodeResult.status === 'success') {
          showNotification(`✅ Node executed successfully`, 'success');
        } else {
          showNotification(`❌ Node error: ${data.nodeResult.error || 'Unknown error'}`, 'error');
        }
      } else {
        showNotification('⚠️ Node was not reached in execution (check upstream nodes)', 'error');
      }
    } catch (err) {
      showNotification(`Test failed: ${err.message}`, 'error');
    }

    setTestingNodeId(null);
  }, [activeWorkflowId, nodes, edges, showNotification]);

  // ---- Test run (live execution with SSE) ----
  const testRun = useCallback(async () => {
    if (!activeWorkflowId) return;

    // Clean up any previous subscription
    if (unsubSse.current) {
      unsubSse.current();
      unsubSse.current = null;
    }

    // Reset execution state
    setIsExecuting(true);
    setExecutionNodeStatuses({});
    setExecutionProgress({ completed: 0, total: 0 });

    // Start all nodes as idle by clearing statuses
    // Count total nodes
    setExecutionProgress({ completed: 0, total: nodes.length });

    try {
      const data = await api.testWorkflow(activeWorkflowId, {
        test: true,
        timestamp: new Date().toISOString(),
        message: 'Test execution',
      });

      const executionId = data.execution.id;

      // Subscribe to SSE for live updates
      unsubSse.current = api.subscribeToExecution(executionId, {
        onNodeStarted: (event) => {
          setExecutionNodeStatuses(prev => ({
            ...prev,
            [event.nodeId]: 'running',
          }));
        },
        onNodeSuccess: (event) => {
          setExecutionNodeStatuses(prev => ({
            ...prev,
            [event.nodeId]: 'success',
          }));
          setExecutionProgress(prev => ({
            ...prev,
            completed: prev.completed + 1,
          }));
        },
        onNodeError: (event) => {
          setExecutionNodeStatuses(prev => ({
            ...prev,
            [event.nodeId]: 'error',
          }));
          setExecutionProgress(prev => ({
            ...prev,
            completed: prev.completed + 1,
          }));
        },
        onNodeSkipped: (event) => {
          setExecutionProgress(prev => ({
            ...prev,
            completed: prev.completed + 1,
          }));
        },
        onCompleted: (execution) => {
          setIsExecuting(false);
          setSelectedExecutionId(execution.id);
          loadExecutions(activeWorkflowId);

          // Collect all node outputs for the expression editor
          if (execution.nodeResults && execution.nodeResults.length > 0) {
            const outputs = {};
            execution.nodeResults.forEach(r => {
              outputs[r.nodeId] = {
                name: r.nodeName,
                type: r.nodeType,
                outputData: r.outputData,
                status: r.status,
              };
            });
            setNodeExecutionOutputs(outputs);
          }

          showNotification(
            `Execution ${execution.status === 'success' ? 'completed' : 'failed'}!`,
            execution.status === 'success' ? 'success' : 'error'
          );
        },
        onError: (err) => {
          console.error('SSE error:', err);
          setIsExecuting(false);
        },
      });
    } catch (err) {
      setIsExecuting(false);
      showNotification(`Test failed: ${err.message}`, 'error');
    }
  }, [activeWorkflowId, nodes.length, loadExecutions, showNotification]);

  // Sync execution statuses to node data on the canvas
  useEffect(() => {
    setNodes(nds => nds.map(n => ({
      ...n,
      data: {
        ...n.data,
        executionStatus: executionNodeStatuses[n.id] || 'idle',
      },
    })));
  }, [executionNodeStatuses, setNodes]);

  // Cleanup SSE on unmount
  useEffect(() => {
    return () => {
      if (unsubSse.current) {
        unsubSse.current();
      }
    };
  }, []);

  // ---- Drag state ----
  let dragNodeTypeRef = useRef(null);

  const onDragStart = useCallback((event, nodeType) => {
    dragNodeTypeRef.current = nodeType;
    event.dataTransfer.effectAllowed = 'move';
  }, []);

  const onDragOver = useCallback((event) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  }, []);

  const onDrop = useCallback(
    (event) => {
      event.preventDefault();
      const draggedType = dragNodeTypeRef.current;
      if (!draggedType || !reactFlowInstance) return;

      const typeMeta = nodeTypesMeta[draggedType];
      if (!typeMeta) return;

      // Enforce single trigger
      if (draggedType === 'webhookTrigger') {
        const hasTrigger = nodes.some(n => n.data.type === 'webhookTrigger');
        if (hasTrigger) {
          showNotification('Only one trigger node is allowed', 'error');
          dragNodeTypeRef.current = null;
          return;
        }
      }

      const position = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      const defaults = { ...typeMeta.definition.defaults };
      const id = `${draggedType}_${Date.now()}`;

      const newNode = {
        id,
        type: 'workflowNode',
        position,
        data: {
          label: typeMeta.definition.name,
          type: draggedType,
          icon: typeMeta.definition.icon || 'Zap',
          color: typeMeta.definition.color || '#6b7280',
          parameters: defaults,
          outputs: computeDefaultOutputs(draggedType, defaults),
          executionStatus: 'idle',
        },
      };

      setNodes(nds => [...nds, newNode]);
      dragNodeTypeRef.current = null;
    },
    [reactFlowInstance, nodeTypesMeta, setNodes, showNotification, nodes]
  );

  /**
   * Add a new node downstream in the chain.
   * - Enforces only one webhook trigger
   * - Auto-positions to the right of the last node
   * - Auto-connects to the previous last node
   */
  const addNodeToChain = useCallback((nodeType) => {
    const typeMeta = nodeTypesMeta[nodeType];
    if (!typeMeta) return;

    // Enforce single trigger
    if (nodeType === 'webhookTrigger') {
      const hasTrigger = nodes.some(n => n.data.type === 'webhookTrigger');
      if (hasTrigger) {
        showNotification('Only one trigger node is allowed', 'error');
        return;
      }
    }

    const defaults = { ...typeMeta.definition.defaults };
    const position = getNextChainPosition(nodes);
    const id = `${nodeType}_${Date.now()}`;

    const newNode = {
      id,
      type: 'workflowNode',
      position,
      data: {
        label: typeMeta.definition.name,
        type: nodeType,
        icon: typeMeta.definition.icon || 'Zap',
        color: typeMeta.definition.color || '#6b7280',
        parameters: defaults,
        outputs: computeDefaultOutputs(nodeType, defaults),
        executionStatus: 'idle',
      },
    };

    // Auto-connect to the last node in the chain
    let newEdge = null;
    if (nodes.length > 0) {
      // Find the last node (rightmost) to connect from
      const lastNode = [...nodes].sort((a, b) => (b.position.x || 0) - (a.position.x || 0))[0];
      newEdge = {
        id: `edge_${lastNode.id}_${id}`,
        source: lastNode.id,
        target: id,
        sourceHandle: 'main',
        targetHandle: 'main',
        type: 'smoothstep',
        animated: true,
        style: { stroke: 'var(--edge-color)', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge-color)' },
      };
    }

    setNodes(nds => [...nds, newNode]);
    if (newEdge) {
      setEdges(eds => [...eds, newEdge]);
    }

    // Auto-select the new node for configuration
    setSelectedNode(newNode);
  }, [nodes, nodeTypesMeta, showNotification, setNodes, setEdges]);

  const onConnect = useCallback(
    (params) => {
      setEdges(eds => addEdge({
        ...params,
        type: 'smoothstep',
        animated: true,
        style: { stroke: 'var(--edge-color)', strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--edge-color)' },
      }, eds));
    },
    [setEdges]
  );

  const onNodeClick = useCallback((event, node) => {
    setSelectedNode(node);
    // Close expression panel when clicking a different node
    setActiveExprField(null);
    setExpressionPanelOpen(false);
  }, [setExpressionPanelOpen, setActiveExprField]);

  const onNodesDelete = useCallback((deletedNodes) => {
    // Remove edges connected to deleted nodes
    const deletedIds = new Set(deletedNodes.map(n => n.id));
    setEdges(eds => eds.filter(e => !deletedIds.has(e.source) && !deletedIds.has(e.target)));
  }, [setEdges]);

  const onPaneClick = useCallback(() => {
    setSelectedNode(null);
    // Close expression panel when clicking canvas background
    setActiveExprField(null);
    setExpressionPanelOpen(false);
  }, [setExpressionPanelOpen, setActiveExprField]);

  // Job view state
  const [workflowGraphNodes, setWorkflowGraphNodes] = useState([]);
  const [workflowGraphEdges, setWorkflowGraphEdges] = useState([]);
  const [jobViewTab, setJobViewTab] = useState('graph'); // 'graph' | 'list'
  const [selectedJobNodeId, setSelectedJobNodeId] = useState(null);

  // Load workflow graph data when execution changes
  const loadExecutionWorkflowGraph = useCallback(async (execution) => {
    if (!execution) {
      setWorkflowGraphNodes([]);
      setWorkflowGraphEdges([]);
      setSelectedJobNodeId(null);
      return;
    }
    try {
      const data = await api.getWorkflow(execution.workflowId);
      const workflow = data.workflow;

      // Build node status map from execution results
      const nodeStatusMap = {};
      if (execution.nodeResults) {
        execution.nodeResults.forEach(r => {
          nodeStatusMap[r.nodeId] = r.status;
        });
      }

      const computeOutputs = (node) => {
        if (node.type === 'router') {
          const params = node.parameters || {};
          const conditions = params.conditions || [];
          const labels = conditions.map(c => c.label || 'Branch');
          if (params.fallbackBranch !== false) labels.push('Fallback');
          return labels;
        }
        return ['main'];
      };

      const flowNodes = (workflow.nodes || []).map(node => ({
        id: node.id,
        type: 'workflowNode',
        position: node.position || { x: 250, y: 100 },
        data: {
          label: node.name || node.type,
          type: node.type,
          icon: nodeTypesMeta[node.type]?.definition?.icon || 'Zap',
          color: nodeTypesMeta[node.type]?.definition?.color || '#6b7280',
          parameters: node.parameters || {},
          outputs: computeOutputs(node),
          executionStatus: nodeStatusMap[node.id] || 'idle',
        },
      }));

      const flowEdges = (workflow.edges || []).map(edge => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        sourceHandle: edge.sourceHandle,
        targetHandle: edge.targetHandle,
        type: 'smoothstep',
        animated: true,
        style: {
          stroke: nodeStatusMap[edge.source] === 'success' ? '#16a34a' :
                  nodeStatusMap[edge.source] === 'error' ? '#dc2626' : '#6366f1',
          strokeWidth: 2,
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: nodeStatusMap[edge.source] === 'success' ? '#16a34a' :
                 nodeStatusMap[edge.source] === 'error' ? '#dc2626' : '#6366f1',
        },
      }));

      setWorkflowGraphNodes(flowNodes);
      setWorkflowGraphEdges(flowEdges);
      setSelectedJobNodeId(null);
    } catch (err) {
      console.error('Failed to load workflow for execution view:', err);
      setWorkflowGraphNodes([]);
      setWorkflowGraphEdges([]);
    }
  }, [nodeTypesMeta]);

  // ---- Get active workflow ----
  const activeWorkflow = workflows.find(w => w.id === activeWorkflowId);
  const selectedExecution = executions.find(e => e.id === selectedExecutionId);

  // Load workflow graph when execution selection changes
  useEffect(() => {
    loadExecutionWorkflowGraph(selectedExecution);
  }, [selectedExecution, loadExecutionWorkflowGraph]);

  return (
    <div className="app">
      {/* Notification */}
      {notification && (
        <div className={`notification ${notification.type}`}>
          {notification.message}
        </div>
      )}

      {/* Header */}
      <header className="app-header">
        <div className="header-left">
          <h1 className="app-logo"><Icon name="Zap" size={20} /> n8n-clone</h1>
        </div>
        <div className="header-center">
          {activeWorkflow && (
            <div className="workflow-tabs">
              <button
                className={`tab-btn ${view === 'editor' ? 'active' : ''}`}
                onClick={() => setView('editor')}
              >
                <span className="tab-icon"><Icon name="PenSquare" size={14} /></span> Editor
              </button>
              <button
                className={`tab-btn ${view === 'executions' ? 'active' : ''}`}
                onClick={() => setView('executions')}
              >
                <span className="tab-icon"><Icon name="ClipboardList" size={14} /></span> Executions
              </button>
            </div>
          )}
        </div>
        <div className="header-right">
          {activeWorkflow && (
            <>
              <span className="workflow-name-header">{activeWorkflow.name}</span>
              <label className="toggle-switch">
                <input
                  type="checkbox"
                  checked={activeWorkflow.active}
                  onChange={(e) => toggleActive(activeWorkflow.id, e.target.checked)}
                />
                <span className="toggle-slider"></span>
              </label>
              <span className="toggle-label">{activeWorkflow.active ? 'Active' : 'Inactive'}</span>
            </>
          )}
          <button
            className="theme-toggle"
            onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
            title={`Switch to ${theme === 'light' ? 'dark' : 'light'} mode`}
          >
            {theme === 'light' ? <Icon name="Moon" size={18} /> : <Icon name="Sun" size={18} />}
          </button>
        </div>
      </header>

      <div className="app-body">
        {/* Sidebar - Workflow list */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <h2>Workflows</h2>
            <button className="btn btn-primary btn-sm" onClick={() => setShowNewWorkflow(true)}>
              + New
            </button>
          </div>

          {showNewWorkflow && (
            <div className="new-workflow-form">
              <input
                type="text"
                placeholder="Workflow name..."
                value={newWorkflowName}
                onChange={(e) => setNewWorkflowName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && createWorkflow()}
                autoFocus
              />
              <div className="form-actions">
                <button className="btn btn-primary btn-sm" onClick={createWorkflow}>Create</button>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowNewWorkflow(false)}>Cancel</button>
              </div>
            </div>
          )}

          <div className="workflow-list">
            {workflows.length === 0 && (
              <div className="empty-state">
                <p>No workflows yet</p>
                <p className="hint">Create one to get started!</p>
              </div>
            )}
            {workflows.map(w => (
              <div
                key={w.id}
                className={`workflow-item ${w.id === activeWorkflowId ? 'active' : ''}`}
                onClick={() => loadWorkflowIntoEditor(w.id)}
              >
                <div className="workflow-item-info">
                  <span className="workflow-item-name">{w.name}</span>
                  <span className="workflow-item-meta">
                    {w.active ? '🟢 Active' : '⚪ Inactive'} · {w.nodes?.length || 0} nodes
                  </span>
                </div>
                <button
                  className="btn-icon delete-btn"
                  onClick={(e) => { e.stopPropagation(); deleteWorkflow(w.id); }}
                  title="Delete"
                >
                  <Icon name="Trash2" size={16} />
                </button>
              </div>
            ))}
          </div>
        </aside>

        {/* Main content area */}
        <main className="main-content">
          {!activeWorkflow ? (
            <div className="welcome-screen">
              <div className="welcome-icon"><Icon name="Zap" size={48} /></div>
              <h2>Welcome to n8n-clone</h2>
              <p>A minimal workflow automation system with Webhook, WhatsApp, and HTTP nodes</p>
              <div className="welcome-actions">
                <button className="btn btn-primary btn-lg" onClick={() => setShowNewWorkflow(true)}>
                  Create Your First Workflow
                </button>
              </div>
              <div className="welcome-nodes">
                <div className="welcome-node-card">
                  <span className="node-card-icon"><Icon name="Webhook" size={32} /></span>
                  <h3>Webhook Trigger</h3>
                  <p>Start workflows via HTTP requests</p>
                </div>
                <div className="welcome-node-card">
                  <span className="node-card-icon"><Icon name="MessageCircle" size={32} /></span>
                  <h3>WhatsApp</h3>
                  <p>Send messages via WhatsApp Business API</p>
                </div>
                <div className="welcome-node-card">
                  <span className="node-card-icon"><Icon name="Globe" size={32} /></span>
                  <h3>HTTP Request</h3>
                  <p>Make API calls to external services</p>
                </div>
              </div>
            </div>
          ) : view === 'editor' ? (
            <div className="editor-layout">
              {/* Resize handle between sidebar and canvas */}
              <div className="resize-handle" onMouseDown={(e) => startResize('left', e)}>
                <div className="resize-handle-line" />
              </div>

              {/* Left panel - Node palette */}
              <div className="node-palette" style={{ width: leftPanelWidth }}>
                <h3>Nodes</h3>
                {Object.entries(nodeTypesMeta).map(([key, meta]) => {
                  const isTrigger = key === 'webhookTrigger';
                  const isDisabled = isTrigger && nodes.some(n => n.data.type === 'webhookTrigger');
                  return (
                    <div
                      key={key}
                      className={`palette-node ${isDisabled ? 'disabled' : ''}`}
                      draggable={!isDisabled}
                      onDragStart={(e) => !isDisabled && onDragStart(e, key)}
                      onClick={() => !isDisabled && addNodeToChain(key)}
                      style={{ '--node-color': meta.definition.color || '#6b7280' }}
                      title={isDisabled ? 'Only one trigger node allowed' : 'Click to add downstream · Drag to place anywhere'}
                    >
                      <span className="palette-node-icon"><Icon name={meta.definition.icon} size={20} /></span>
                      <div className="palette-node-info">
                        <span className="palette-node-name">{meta.definition.name}</span>
                        <span className="palette-node-desc">{meta.definition.description}</span>
                      </div>
                      {!isTrigger && <span className="palette-add-badge">+</span>}
                      <span className="palette-drag-hint" title="Drag to canvas">↗</span>
                    </div>
                  );
                })}
                <div className="palette-hint">
                  Click a node to add it downstream in your workflow chain
                </div>
              </div>

              {/* Center - Canvas */}
              <div className="canvas-wrapper" ref={reactFlowWrapper}>
                {/* Resize handle between canvas and config panel */}
                <div className="resize-handle right" onMouseDown={(e) => startResize('right', e)}>
                  <div className="resize-handle-line" />
                </div>
                <ReactFlow
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={onNodesChange}
                  onEdgesChange={onEdgesChange}
                  onConnect={onConnect}
                  onInit={setReactFlowInstance}
                  onDrop={onDrop}
                  onDragOver={onDragOver}
                  onNodeClick={onNodeClick}
                  onNodesDelete={onNodesDelete}
                  onPaneClick={onPaneClick}
                  nodeTypes={nodeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.3 }}
                  deleteKeyCode={['Backspace', 'Delete']}
                  snapToGrid
                  snapGrid={[20, 20]}
                >
                  <Background color={theme === 'dark' ? '#282834' : '#d0d4e4'} gap={20} />
                  <Controls />
                  <MiniMap
                    style={{ background: theme === 'dark' ? '#1a1a22' : '#f0f2f8' }}
                    nodeColor={(n) => n.data?.color || '#6b7280'}
                    maskColor={theme === 'dark' ? 'rgba(0,0,0,0.6)' : 'rgba(0,0,0,0.1)'}
                  />
                  <Panel position="top-right">
                    <div className="canvas-toolbar">
                      {isExecuting && (
                        <div className="execution-progress">
                          <span className="progress-spinner"></span>
                          <span className="progress-text">
                            {executionProgress.completed}/{executionProgress.total} nodes
                          </span>
                        </div>
                      )}
                      <button className="btn btn-primary btn-sm" onClick={saveWorkflow} disabled={saving}>
                        {saving ? 'Saving...' : '💾 Save'}
                      </button>
                      <button
                        className={`btn btn-secondary btn-sm ${isExecuting ? 'executing' : ''}`}
                        onClick={testRun}
                        disabled={isExecuting}
                      >
                        {isExecuting ? '⏳ Running...' : '▶️ Test'}
                      </button>
                    </div>
                  </Panel>
                </ReactFlow>
              </div>

              {/* Right panel - Node config */}
              <div className="node-config-panel" style={{ width: rightPanelWidth }}>
                <h3>Configuration</h3>
                {selectedNode ? (
                  <NodeConfigPanel
                    node={selectedNode}
                    meta={nodeTypesMeta[selectedNode.data.type]}
                    onUpdate={updateNodeParameters}
                    onOpenExpression={openExpressionPanel}
                    onTestNode={testSingleNode}
                    isTestingNode={testingNodeId === selectedNode.id}
                    nodeTestResult={nodeTestResults[selectedNode.id]}
                    nodeExecutionOutputs={nodeExecutionOutputs}
                  />
                ) : (
                  <div className="config-empty">
                    <p>Select a node to configure its parameters</p>
                  </div>
                )}
              </div>

              {/* Expression editor panel */}
              {expressionPanelOpen && (
                <ExpressionEditorPanel
                  nodeExecutionOutputs={nodeExecutionOutputs}
                  onInsert={insertExpressionReference}
                  onClose={closeExpressionPanel}
                  activeField={activeExprField}
                />
              )}
            </div>
          ) : (
            // Executions view
            <div className="executions-view">
              <div className="executions-header">
                <h2>Execution History — {activeWorkflow?.name}</h2>
                <button className="btn btn-secondary btn-sm" onClick={() => setView('editor')}>
                  <Icon name="ArrowLeft" size={14} /> Back to Editor
                </button>
              </div>
              <div className="executions-layout">
                <div className="executions-list">
                  {executions.length === 0 && (
                    <div className="empty-state">
                      <p>No executions yet</p>
                      <p className="hint">Run a test to see execution results</p>
                    </div>
                  )}
                  {executions.map(ex => (
                    <div
                      key={ex.id}
                      className={`execution-item ${ex.id === selectedExecutionId ? 'active' : ''}`}
                      onClick={() => setSelectedExecutionId(ex.id)}
                    >
                      <div className="execution-item-header">
                        <span className={`execution-status status-${ex.status}`}>
                          {ex.status === 'success' ? '✅' : ex.status === 'error' ? '❌' : '🔄'}
                        </span>
                        <span className="execution-id">ID: {ex.id}</span>
                      </div>
                      <div className="execution-time">
                        {new Date(ex.startedAt).toLocaleString()}
                      </div>
                      <div className="execution-nodes">
                        {ex.nodeResults?.length || 0} node(s) executed
                      </div>
                    </div>
                  ))}
                </div>
                <div className="execution-detail">
                  {selectedExecution ? (
                    <ExecutionJobView
                      execution={selectedExecution}
                      graphNodes={workflowGraphNodes}
                      graphEdges={workflowGraphEdges}
                      tab={jobViewTab}
                      onTabChange={setJobViewTab}
                      selectedNodeId={selectedJobNodeId}
                      onNodeSelect={setSelectedJobNodeId}
                      theme={theme}
                    />
                  ) : (
                    <div className="empty-state">
                      <p>Select an execution to view details</p>
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// ---- NodeConfigPanel Component ----
function NodeConfigPanel({ node, meta, onUpdate, onOpenExpression, onTestNode, isTestingNode, nodeTestResult, nodeExecutionOutputs }) {
  const params = node.data.parameters || {};
  const definition = meta?.definition || {};
  const defaults = definition.defaults || {};

  const updateParam = (key, value) => {
    onUpdate(node.id, { [key]: value });
  };

  // Get the parameter fields based on node type
  const getFields = () => {
    switch (node.data.type) {
      case 'webhookTrigger':
        return (
          <>
            <ConfigField label="HTTP Method" type="select" value={params.method || defaults.method}
              options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE']}
              onChange={(v) => updateParam('method', v)} />
            <ConfigField label="Response Status" type="number" value={params.responseStatusCode || defaults.responseStatusCode}
              onChange={(v) => updateParam('responseStatusCode', parseInt(v) || 200)} />
            <ConfigField label="Response Body (JSON)" type="textarea" value={params.responseBody || defaults.responseBody}
              onChange={(v) => updateParam('responseBody', v)}
              placeholder='{"status": "received"}'
              nodeId={node.id} fieldKey="responseBody" onOpenExpression={onOpenExpression} />
            <div className="config-hint">
              💡 Use {'{{body.field}}'} to reference webhook data<br/>
              💡 Click <strong>fx</strong> next to fields to insert expressions from previous nodes
            </div>
          </>
        );

      case 'whatsapp':
        const showBody = (params.messageType || defaults.messageType) === 'text';
        const showTemplate = (params.messageType || defaults.messageType) === 'template';
        return (
          <>
            <ConfigField label="Access Token" type="password" value={params.accessToken || defaults.accessToken}
              onChange={(v) => updateParam('accessToken', v)} placeholder="WhatsApp Business API token" />
            <ConfigField label="Phone Number ID" type="text" value={params.phoneNumberId || defaults.phoneNumberId}
              onChange={(v) => updateParam('phoneNumberId', v)} placeholder="Your WhatsApp phone number ID" />
            <ConfigField label="Recipient (To)" type="text" value={params.to || defaults.to}
              onChange={(v) => updateParam('to', v)} placeholder="+1234567890"
              nodeId={node.id} fieldKey="to" onOpenExpression={onOpenExpression} />
            <ConfigField label="Message Type" type="select" value={params.messageType || defaults.messageType}
              options={['text', 'template']} onChange={(v) => updateParam('messageType', v)} />
            {showBody && (
              <ConfigField label="Message Body" type="textarea" value={params.messageBody || defaults.messageBody}
                onChange={(v) => updateParam('messageBody', v)}
                placeholder="Hello from n8n-clone!"
                nodeId={node.id} fieldKey="messageBody" onOpenExpression={onOpenExpression} />
            )}
            {showTemplate && (
              <>
                <ConfigField label="Template Name" type="text" value={params.templateName || defaults.templateName}
                  onChange={(v) => updateParam('templateName', v)} placeholder="hello_world" />
                <ConfigField label="Template Language" type="text" value={params.templateLanguage || defaults.templateLanguage}
                  onChange={(v) => updateParam('templateLanguage', v)} placeholder="en_US" />
                <ConfigField label="Template Params (JSON)" type="textarea" value={JSON.stringify(params.templateParameters || defaults.templateParameters, null, 2)}
                  onChange={(v) => { try { updateParam('templateParameters', JSON.parse(v)); } catch {} }}
                  placeholder='["value1", "value2"]' />
              </>
            )}
            <div className="config-hint">
              💡 Use {'{{$node.nodeId.body.field}}'} to reference any previous node's output<br/>
              💡 Click <strong>fx</strong> to browse available data from executed nodes
            </div>
          </>
        );

      case 'http':
        return (
          <>
            <ConfigField label="Method" type="select" value={params.method || defaults.method}
              options={['GET', 'POST', 'PUT', 'PATCH', 'DELETE']}
              onChange={(v) => updateParam('method', v)} />
            <ConfigField label="URL" type="text" value={params.url || defaults.url}
              onChange={(v) => updateParam('url', v)} placeholder="https://api.example.com/endpoint"
              nodeId={node.id} fieldKey="url" onOpenExpression={onOpenExpression} />
            <ConfigField label="Headers (JSON)" type="textarea"
              value={formatJsonParam(params.headers, defaults.headers)}
              onChange={(v) => { try { updateParam('headers', JSON.parse(v)); } catch {} }}
              placeholder='{"Authorization": "Bearer {{body.token}}"}'
              nodeId={node.id} fieldKey="headers" onOpenExpression={onOpenExpression} />
            <ConfigField label="Body" type="textarea" value={params.body || defaults.body}
              onChange={(v) => updateParam('body', v)}
              placeholder='{"message": "Hello"}'
              nodeId={node.id} fieldKey="body" onOpenExpression={onOpenExpression} />
            <ConfigField label="Authentication" type="select" value={params.authentication || defaults.authentication}
              options={['none', 'bearerToken', 'basicAuth']}
              onChange={(v) => updateParam('authentication', v)} />
            {params.authentication === 'bearerToken' && (
              <ConfigField label="Bearer Token" type="password" value={params.token || defaults.token}
                onChange={(v) => updateParam('token', v)} placeholder="Bearer token" />
            )}
            {params.authentication === 'basicAuth' && (
              <>
                <ConfigField label="Username" type="text" value={params.username || defaults.username}
                  onChange={(v) => updateParam('username', v)} />
                <ConfigField label="Password" type="password" value={params.password || defaults.password}
                  onChange={(v) => updateParam('password', v)} />
              </>
            )}
            <label className="config-checkbox">
              <input type="checkbox" checked={params.retryOnFail || false}
                onChange={(e) => updateParam('retryOnFail', e.target.checked)} />
              <span>Retry on failure</span>
            </label>
            {params.retryOnFail && (
              <ConfigField label="Max Retries" type="number" value={params.maxRetries || defaults.maxRetries}
                onChange={(v) => updateParam('maxRetries', parseInt(v) || 0)} />
            )}
            <div className="config-hint">
              💡 Use {'{{$node.nodeId.body.field}}'} to reference any previous node's output<br/>
              💡 Click <strong>fx</strong> to browse available data from executed nodes
            </div>
          </>
        );

      case 'aiModel':
        return (
          <>
            <ConfigField label="API Key" type="password" value={params.apiKey || defaults.apiKey}
              onChange={(v) => updateParam('apiKey', v)} placeholder="Your Google AI Studio API key" />
            <div className="config-field">
              <label>Model</label>
              <select value={params.model || defaults.model} onChange={(e) => updateParam('model', e.target.value)}>
                <option value="gemini-2.0-flash">Gemini 2.0 Flash (fast)</option>
                <option value="gemini-1.5-flash">Gemini 1.5 Flash</option>
                <option value="gemini-1.5-pro">Gemini 1.5 Pro</option>
                <option value="gemini-2.0-pro">Gemini 2.0 Pro (experimental)</option>
              </select>
            </div>
            <ConfigField label="System Prompt" type="textarea" value={params.systemPrompt || defaults.systemPrompt}
              onChange={(v) => updateParam('systemPrompt', v)}
              placeholder="You are a helpful assistant."
              nodeId={node.id} fieldKey="systemPrompt" onOpenExpression={onOpenExpression} />
            <ConfigField label="User Message" type="textarea" value={params.userMessage || defaults.userMessage}
              onChange={(v) => updateParam('userMessage', v)}
              placeholder="What would you like the AI to do? Use {{body.field}} for dynamic data."
              nodeId={node.id} fieldKey="userMessage" onOpenExpression={onOpenExpression} />
            <ConfigField label="Temperature" type="number" value={params.temperature ?? defaults.temperature}
              onChange={(v) => updateParam('temperature', parseFloat(v) || 0.7)}
              min={0} max={2} step={0.1} />
            <ConfigField label="Max Output Tokens" type="number" value={params.maxOutputTokens ?? defaults.maxOutputTokens}
              onChange={(v) => updateParam('maxOutputTokens', parseInt(v) || 2048)}
              min={1} max={8192} />
            <div className="config-hint">
              💡 Use {'{{body.field}}'} or {'{{$node.nodeId.body.field}}'} to reference data from previous nodes<br/>
              💡 Get your free API key at <strong>aistudio.google.com</strong> → Get API Key<br/>
              💡 The response text is available as <strong>output.text</strong> for downstream nodes
            </div>
          </>
        );

      case 'router':
        return <RouterConfig params={params} defaults={defaults} updateParam={updateParam} onOpenExpression={onOpenExpression} nodeId={node.id} />;

      default:
        return <p className="config-empty">Unknown node type</p>;
    }
  };

  // Test the node
  const handleTestNode = () => {
    onTestNode(node.id);
  };

  return (
    <div className="node-config-content">
      <div className="config-header" style={{ color: definition.color || '#6b7280' }}>
        <span className="config-icon">{definition.icon}</span>
        <span>{definition.name}</span>
      </div>

      {/* Node test output display */}
      {nodeTestResult && (
        <NodeOutputDisplay nodeTestResult={nodeTestResult} />
      )}

      {/* Test node button */}
      <button
        className={`test-node-btn ${isTestingNode ? 'testing' : ''}`}
        onClick={handleTestNode}
        disabled={isTestingNode}
      >
        {isTestingNode ? (
          <><span className="progress-spinner"></span> Executing...</>
        ) : (
          <>{'▶️'} Test this node</>
        )}
      </button>

      <div className="config-fields">
        {getFields()}
      </div>

      <div className="config-hint">
        💡 <strong>Test the node</strong> first to see its output data, then use <strong>fx</strong> to insert expressions from previous nodes
      </div>
    </div>
  );
}

// ---- JsonTreeView Component (collapsible parsed view) ----
function JsonTreeView({ data, depth = 0, collapsed = false }) {
  const [isCollapsed, setIsCollapsed] = useState(depth > 1 ? true : collapsed);
  const [collapsedChildren, setCollapsedChildren] = useState({});

  const toggle = () => setIsCollapsed(!isCollapsed);

  const toggleChild = (key) => {
    setCollapsedChildren(prev => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  if (data === null || data === undefined) {
    return <span className="jv-null">null</span>;
  }

  if (typeof data === 'string') {
    return <span className="jv-string">"{data}"</span>;
  }

  if (typeof data === 'number') {
    return <span className="jv-number">{data}</span>;
  }

  if (typeof data === 'boolean') {
    return <span className="jv-boolean">{data ? 'true' : 'false'}</span>;
  }

  if (Array.isArray(data)) {
    if (data.length === 0) {
      return <span className="jv-bracket">[]</span>;
    }
    return (
      <div className="jv-block">
        <span className="jv-toggle" onClick={toggle}>
          {isCollapsed ? '▶' : '▼'}
        </span>
        <span className="jv-bracket">[</span>
        <span className="jv-count">{data.length} items</span>
        {isCollapsed ? (
          <span className="jv-bracket" onClick={toggle} style={{cursor:'pointer'}}>]</span>
        ) : (
          <>
            <div className="jv-children">
              {data.map((item, idx) => {
                const isChildCollapsed = collapsedChildren[idx] !== undefined ? collapsedChildren[idx] : (typeof item === 'object' && item !== null);
                return (
                  <div key={idx} className="jv-row">
                    <span className="jv-key" onClick={() => toggleChild(idx)}>
                      <span className="jv-array-index">{idx}</span>
                    </span>
                    <span className="jv-colon">: </span>
                    {typeof item === 'object' && item !== null ? (
                      isChildCollapsed ? (
                        <span className="jv-collapsed" onClick={() => toggleChild(idx)}>
                          {Array.isArray(item) ? `[${item.length} items]` : `{${Object.keys(item).length} keys}`}
                        </span>
                      ) : (
                        <JsonTreeView data={item} depth={depth + 1} />
                      )
                    ) : (
                      <JsonTreeView data={item} depth={depth + 1} />
                    )}
                  </div>
                );
              })}
            </div>
            <span className="jv-bracket">]</span>
          </>
        )}
      </div>
    );
  }

  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return <span className="jv-bracket">{'{}'}</span>;
    }
    return (
      <div className="jv-block">
        <span className="jv-toggle" onClick={toggle}>
          {isCollapsed ? '▶' : '▼'}
        </span>
        <span className="jv-bracket">{'{'}</span>
        <span className="jv-count">{entries.length} keys</span>
        {isCollapsed ? (
          <span className="jv-bracket" onClick={toggle} style={{cursor:'pointer'}}>{'}'}</span>
        ) : (
          <>
            <div className="jv-children">
              {entries.map(([key, value]) => {
                const isChildCollapsed = collapsedChildren[key] !== undefined ? collapsedChildren[key] : (typeof value === 'object' && value !== null);
                return (
                  <div key={key} className="jv-row">
                    <span className="jv-key" onClick={() => toggleChild(key)}>
                      <span className="jv-key-name">{key}</span>
                    </span>
                    <span className="jv-colon">: </span>
                    {typeof value === 'object' && value !== null ? (
                      isChildCollapsed ? (
                        <span className="jv-collapsed" onClick={() => toggleChild(key)}>
                          {Array.isArray(value) ? `[${value.length} items]` : `{${Object.keys(value).length} keys}`}
                        </span>
                      ) : (
                        <JsonTreeView data={value} depth={depth + 1} />
                      )
                    ) : (
                      <JsonTreeView data={value} depth={depth + 1} />
                    )}
                  </div>
                );
              })}
            </div>
            <span className="jv-bracket">{'}'}</span>
          </>
        )}
      </div>
    );
  }

  return null;
}

// ---- NodeOutputDisplay Component ----
function NodeOutputDisplay({ nodeTestResult }) {
  const { output, status, error } = nodeTestResult;
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`node-output-section`}>
      <div className="node-output-header" onClick={() => setCollapsed(!collapsed)}>
        <span>{collapsed ? '▶' : '▼'} Node Output</span>
        <span className={`node-output-status ${status || ''}`}>
          {status === 'success' ? '✅ Success' : status === 'error' ? '❌ Error' : '⏳ Running'}
        </span>
      </div>
      {!collapsed && (
        <div className="node-output-body">
          {error && (
            <div className="node-output-json" style={{ color: 'var(--error)', fontFamily: 'inherit', fontSize: 13 }}>
              ⚠️ {error}
            </div>
          )}
          {output && (
            <div className="node-output-tree">
              <JsonTreeView data={output} />
            </div>
          )}
          {!output && !error && (
            <div className="node-output-json" style={{ color: 'var(--text-muted)', fontFamily: 'inherit' }}>
              No output data
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---- ConfigField Component ----
function ConfigField({ label, type, value, onChange, options, placeholder, nodeId, fieldKey, onOpenExpression }) {
  const id = `field-${label.toLowerCase().replace(/\s+/g, '-')}`;
  const showFx = onOpenExpression && fieldKey && nodeId && ['text', 'textarea', 'password'].includes(type);

  const handleFxClick = () => {
    if (onOpenExpression && nodeId && fieldKey) {
      onOpenExpression(nodeId, fieldKey, value);
    }
  };

  const renderInput = () => {
    if (type === 'select') {
      return (
        <select id={id} value={value} onChange={(e) => onChange(e.target.value)}>
          {options.map(opt => (
            <option key={opt} value={opt}>{opt}</option>
          ))}
        </select>
      );
    }

    const input = type === 'textarea' ? (
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        rows={3}
      />
    ) : type === 'password' ? (
      <input
        id={id}
        type="password"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    ) : type === 'number' ? (
      <input
        id={id}
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    ) : (
      <input
        id={id}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    );

    if (showFx) {
      return (
        <div className="field-input-wrapper">
          {input}
          <button className="fx-btn" onClick={handleFxClick} title="Insert expression from previous node">
            fx
          </button>
        </div>
      );
    }

    return input;
  };

  return (
    <div className="config-field">
      <label htmlFor={id}>{label}</label>
      {renderInput()}
    </div>
  );
}

// ---- RouterConfig Component ----
const OPERATORS = [
  { value: 'equals', label: 'Equals' },
  { value: 'notEquals', label: 'Not equals' },
  { value: 'contains', label: 'Contains' },
  { value: 'notContains', label: 'Not contains' },
  { value: 'startsWith', label: 'Starts with' },
  { value: 'endsWith', label: 'Ends with' },
  { value: 'greaterThan', label: 'Greater than' },
  { value: 'lessThan', label: 'Less than' },
  { value: 'greaterEqual', label: 'Greater or equal' },
  { value: 'lessEqual', label: 'Less or equal' },
  { value: 'isEmpty', label: 'Is empty' },
  { value: 'isNotEmpty', label: 'Is not empty' },
  { value: 'exists', label: 'Exists' },
  { value: 'regex', label: 'Regex match' },
];

function RouterConfig({ params, defaults, updateParam, onOpenExpression, nodeId }) {
  const conditions = params.conditions ?? defaults.conditions ?? [{ label: 'Branch 1', field: '', operator: 'equals', value: '' }];
  const fallbackBranch = params.fallbackBranch !== undefined ? params.fallbackBranch : defaults.fallbackBranch !== false;
  const mode = params.mode || defaults.mode || 'firstMatch';

  const updateConditions = (newConditions) => {
    updateParam('conditions', newConditions);
  };

  const addCondition = () => {
    const newConditions = [...conditions, { label: `Branch ${conditions.length + 1}`, field: '', operator: 'equals', value: '' }];
    updateConditions(newConditions);
  };

  const removeCondition = (index) => {
    const newConditions = conditions.filter((_, i) => i !== index);
    updateConditions(newConditions);
  };

  const updateCondition = (index, key, value) => {
    const newConditions = conditions.map((c, i) => i === index ? { ...c, [key]: value } : c);
    updateConditions(newConditions);
  };

  return (
    <div className="router-config">
      <div className="config-field">
        <label>Routing Mode</label>
        <select value={mode} onChange={(e) => updateParam('mode', e.target.value)}>
          <option value="firstMatch">First match only</option>
          <option value="allMatches">All matching branches</option>
        </select>
      </div>

      <label className="config-checkbox">
        <input type="checkbox" checked={fallbackBranch}
          onChange={(e) => updateParam('fallbackBranch', e.target.checked)} />
        <span>Fallback branch (catch unmatched)</span>
      </label>

      <div className="router-conditions-header">
        <span>Conditions</span>
        <button className="btn btn-primary btn-xs" onClick={addCondition}>+ Add</button>
      </div>

      {conditions.map((cond, idx) => (
        <div key={idx} className="router-condition-card">
          <div className="condition-header">
            <span className="condition-number">Branch {idx + 1}</span>
            <button className="btn-icon remove-btn" onClick={() => removeCondition(idx)} title="Remove"                >
                  <Icon name="X" size={14} />
                </button>
              </div>
          <div className="config-field">
            <label>Label</label>
            <input
              type="text"
              value={cond.label || ''}
              onChange={(e) => updateCondition(idx, 'label', e.target.value)}
              placeholder="Branch name"
            />
          </div>
          <ConfigField label="Field" type="text" value={cond.field || ''}
            onChange={(v) => updateCondition(idx, 'field', v)}
            placeholder={'{{body.field}}'}
            nodeId={nodeId} fieldKey={`conditions.${idx}.field`} onOpenExpression={onOpenExpression} />
          <div className="config-field">
            <label>Operator</label>
            <select value={cond.operator || 'equals'} onChange={(e) => updateCondition(idx, 'operator', e.target.value)}>
              {OPERATORS.map(op => (
                <option key={op.value} value={op.value}>{op.label}</option>
              ))}
            </select>
          </div>
          {!['isEmpty', 'isNotEmpty', 'exists'].includes(cond.operator) && (
            <ConfigField label="Value" type="text" value={cond.value || ''}
              onChange={(v) => updateCondition(idx, 'value', v)}
              placeholder="Value to compare"
              nodeId={nodeId} fieldKey={`conditions.${idx}.value`} onOpenExpression={onOpenExpression} />
          )}
        </div>
      ))}

      <div className="config-hint">
        💡 Connect edges from each branch output handle on the right side of the Router node.<br/>
        💡 Click <strong>fx</strong> to browse available data from executed nodes for field/value expressions
      </div>
    </div>
  );
}

// ---- ExpressionEditorPanel Component ----
function ExpressionEditorPanel({ nodeExecutionOutputs, onInsert, onClose, activeField }) {
  const [expandedNodes, setExpandedNodes] = useState({});

  const toggleNode = (nodeId) => {
    setExpandedNodes(prev => ({
      ...prev,
      [nodeId]: !prev[nodeId],
    }));
  };

  const nodeEntries = Object.entries(nodeExecutionOutputs);

  return (
    <div className="expression-panel">
      <div className="expression-panel-header">
        <h3>
          <Icon name="ClipboardList" size={16} style={{ marginRight: 6 }} />
          Expression Editor
        </h3>
        <button className="expression-panel-close" onClick={onClose} title="Close"><Icon name="X" size={14} /></button>
      </div>
      <div className="expression-panel-body">
        {activeField && (
          <div style={{
            fontSize: 11,
            color: 'var(--text-secondary)',
            padding: '8px 10px',
            marginBottom: 12,
            background: 'var(--accent-light)',
            borderRadius: 8,
            border: '1px solid var(--accent)',
            wordBreak: 'break-all',
          }}>
            <strong>Editing:</strong> {activeField.fieldKey}
            <div style={{ fontFamily: 'monospace', fontSize: 10, marginTop: 4, color: 'var(--text-muted)' }}>
              Click a value below to insert its reference
            </div>
          </div>
        )}

        {nodeEntries.length === 0 ? (
          <div className="expression-empty">
            <p>No node outputs available</p>
            <p className="expr-hint">
              Run a <strong>Test</strong> or click <strong>▶️ Test this node</strong> first to see output data here
            </p>
          </div>
        ) : (
          nodeEntries.map(([nodeId, nodeInfo]) => (
            <div key={nodeId} className="expr-node-group">
              <div
                className={`expr-node-header ${expandedNodes[nodeId] ? 'expanded' : ''}`}
                onClick={() => toggleNode(nodeId)}
              >
                <span className={`expr-node-toggle ${expandedNodes[nodeId] ? 'expanded' : ''}`}>▸</span>
                <span className="expr-node-icon">
                  {nodeInfo.status === 'success' ? '✅' : nodeInfo.status === 'error' ? '❌' : '⚪'}
                </span>
                <span className="expr-node-name">{nodeInfo.name || nodeInfo.type || nodeId}</span>
                <span style={{ fontSize: 10, color: 'var(--text-muted)', fontFamily: 'monospace' }}>
                  {nodeInfo.type}
                </span>
              </div>
              {expandedNodes[nodeId] && (
                <div className="expr-node-content">
                  {nodeInfo.outputData ? (
                    <ExpressionTreeViewWrapper
                      data={nodeInfo.outputData}
                      nodeId={nodeId}
                      onInsert={onInsert}
                    />
                  ) : (
                    <div style={{ padding: '8px 16px', color: 'var(--text-muted)', fontSize: 11 }}>
                      {nodeInfo.status === 'error' ? 'Node failed to execute' : 'No output data'}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))
        )}

        {/* Usage guide */}
        <div style={{
          marginTop: 16,
          padding: 12,
          background: 'var(--bg-primary)',
          borderRadius: 8,
          border: '1px dashed var(--border)',
          fontSize: 11,
          color: 'var(--text-muted)',
          lineHeight: 1.6,
        }}>
          <strong style={{ color: 'var(--text-secondary)' }}>How to use:</strong><br/>
          1. Expand a node to browse its output data<br/>
          2. Click a <strong>value</strong> (text, number, etc.) or the <strong>↗</strong> icon to insert its reference<br/>
          3. Click <strong>▶</strong>/<strong>▼</strong> to collapse/expand sections<br/>
          4. The reference <code style={{ color: 'var(--accent)' }}>{'{{$node.nodeId.path}}'}</code> is inserted into the active field<br/>
          <br/>
          <strong style={{ color: 'var(--text-secondary)' }}>Examples:</strong><br/>
          <code style={{ color: 'var(--accent)' }}>{'{{$node.webhookTrigger_123.body}}'}</code><br/>
          <code style={{ color: 'var(--accent)' }}>{'{{$node.http_123[0].id}}'}</code>
        </div>
      </div>
    </div>
  );
}

// ---- ExpressionTreeViewWrapper - passes onInsert down via closure ----
function ExpressionTreeViewWrapper({ data, nodeId, onInsert }) {
  const handleInsert = (path) => {
    const fullPath = `$node.${nodeId}.${path}`;
    onInsert(fullPath);
  };

  return <ExpressionTreeViewInternal data={data} nodeId={nodeId} basePath="" onInsert={handleInsert} />;
}

function ExpressionTreeViewInternal({ data, nodeId, basePath, onInsert }) {
  const [isCollapsed, setIsCollapsed] = useState(
    typeof data === 'object' && data !== null && !Array.isArray(data) && Object.keys(data).length > 5
  );
  const [collapsedChildren, setCollapsedChildren] = useState({});

  const toggle = () => setIsCollapsed(!isCollapsed);

  const toggleChild = (key) => {
    setCollapsedChildren(prev => ({
      ...prev,
      [key]: !prev[key],
    }));
  };

  // --- Leaf values ---
  if (data === null || data === undefined) {
    return (
      <span className="jv-expr-leaf" onClick={() => onInsert(basePath)} title={`Insert {{ $node.${nodeId}.${basePath} }}`}>
        <span className="jv-null">null</span>
        <span className="jv-expr-path">{basePath}</span>
      </span>
    );
  }

  if (typeof data === 'string') {
    const displayVal = data.length > 80 ? data.slice(0, 80) + '...' : data;
    return (
      <span className="jv-expr-leaf" onClick={() => onInsert(basePath)} title={`Insert {{ $node.${nodeId}.${basePath} }}`}>
        <span className="jv-string">"{displayVal}"</span>
        <span className="jv-expr-path">{basePath}</span>
      </span>
    );
  }

  if (typeof data === 'number') {
    return (
      <span className="jv-expr-leaf" onClick={() => onInsert(basePath)} title={`Insert {{ $node.${nodeId}.${basePath} }}`}>
        <span className="jv-number">{data}</span>
        <span className="jv-expr-path">{basePath}</span>
      </span>
    );
  }

  if (typeof data === 'boolean') {
    return (
      <span className="jv-expr-leaf" onClick={() => onInsert(basePath)} title={`Insert {{ $node.${nodeId}.${basePath} }}`}>
        <span className="jv-boolean">{data ? 'true' : 'false'}</span>
        <span className="jv-expr-path">{basePath}</span>
      </span>
    );
  }

  // --- Arrays ---
  if (Array.isArray(data)) {
    if (data.length === 0) {
      return (
        <span className="jv-expr-leaf" onClick={() => onInsert(basePath)} title={`Insert {{ $node.${nodeId}.${basePath} }}`}>
          <span className="jv-bracket">[]</span>
          <span className="jv-expr-path">{basePath}</span>
        </span>
      );
    }
    return (
      <div className="jv-block">
        <span className="jv-toggle" onClick={(e) => { e.stopPropagation(); toggle(); }}>
          {isCollapsed ? '▶' : '▼'}
        </span>
        <span className="jv-bracket" onClick={() => onInsert(basePath)}>[</span>
        <span className="jv-count">{data.length} items</span>
        <span className="jv-expr-hint" onClick={() => onInsert(basePath)} title="Insert this array reference">↗</span>
        {isCollapsed ? (
          <span className="jv-bracket" onClick={toggle} style={{cursor:'pointer'}}>]</span>
        ) : (
          <>
            <div className="jv-children">
              {data.map((item, idx) => {
                const childPath = `${basePath}[${idx}]`;
                const isChildObj = typeof item === 'object' && item !== null;
                const isChildCollapsed = collapsedChildren[idx] !== undefined ? collapsedChildren[idx] : (
                  isChildObj && (Array.isArray(item) ? item.length > 3 : Object.keys(item).length > 3)
                );
                return (
                  <div key={idx} className="jv-row">
                    <span className="jv-key" onClick={() => toggleChild(idx)}>
                      <span className="jv-array-index">{idx}</span>
                    </span>
                    <span className="jv-colon">: </span>
                    {isChildObj ? (
                      isChildCollapsed ? (
                        <span className="jv-collapsed" onClick={() => toggleChild(idx)}>
                          {Array.isArray(item) ? `[${item.length} items]` : `{${Object.keys(item).length} keys}`}
                        </span>
                      ) : (
                        <ExpressionTreeViewInternal data={item} nodeId={nodeId} basePath={childPath} onInsert={onInsert} />
                      )
                    ) : (
                      <ExpressionTreeViewInternal data={item} nodeId={nodeId} basePath={childPath} onInsert={onInsert} />
                    )}
                  </div>
                );
              })}
            </div>
            <span className="jv-bracket">]</span>
          </>
        )}
      </div>
    );
  }

  // --- Objects ---
  if (typeof data === 'object') {
    const entries = Object.entries(data);
    if (entries.length === 0) {
      return (
        <span className="jv-expr-leaf" onClick={() => onInsert(basePath)} title={`Insert {{ $node.${nodeId}.${basePath} }}`}>
          <span className="jv-bracket">{'{}'}</span>
          <span className="jv-expr-path">{basePath}</span>
        </span>
      );
    }
    return (
      <div className="jv-block">
        <span className="jv-toggle" onClick={(e) => { e.stopPropagation(); toggle(); }}>
          {isCollapsed ? '▶' : '▼'}
        </span>
        <span className="jv-bracket" onClick={() => onInsert(basePath)}>{'{'}</span>
        <span className="jv-count">{entries.length} keys</span>
        <span className="jv-expr-hint" onClick={() => onInsert(basePath)} title="Insert this object reference">↗</span>
        {isCollapsed ? (
          <span className="jv-bracket" onClick={toggle} style={{cursor:'pointer'}}>{'}'}</span>
        ) : (
          <>
            <div className="jv-children">
              {entries.map(([key, value]) => {
                const childPath = basePath ? `${basePath}.${key}` : key;
                const isChildObj = typeof value === 'object' && value !== null;
                const isChildCollapsed = collapsedChildren[key] !== undefined ? collapsedChildren[key] : (
                  isChildObj && (Array.isArray(value) ? value.length > 3 : Object.keys(value).length > 3)
                );
                return (
                  <div key={key} className="jv-row">
                    <span className="jv-key" onClick={() => toggleChild(key)}>
                      <span className="jv-key-name">{key}</span>
                    </span>
                    <span className="jv-colon">: </span>
                    {isChildObj ? (
                      isChildCollapsed ? (
                        <span className="jv-collapsed" onClick={() => toggleChild(key)}>
                          {Array.isArray(value) ? `[${value.length} items]` : `{${Object.keys(value).length} keys}`}
                        </span>
                      ) : (
                        <ExpressionTreeViewInternal data={value} nodeId={nodeId} basePath={childPath} onInsert={onInsert} />
                      )
                    ) : (
                      <ExpressionTreeViewInternal data={value} nodeId={nodeId} basePath={childPath} onInsert={onInsert} />
                    )}
                  </div>
                );
              })}
            </div>
            <span className="jv-bracket">{'}'}</span>
          </>
        )}
      </div>
    );
  }

  return null;
}

// ---- ExecutionJobView Component (graph + list for execution jobs) ----
function ExecutionJobView({ execution, graphNodes, graphEdges, tab, onTabChange, selectedNodeId, onNodeSelect, theme }) {
  const graphWrapperRef = useRef(null);

  // Find the currently selected node's result
  const selectedResult = selectedNodeId
    ? execution.nodeResults?.find(r => r.nodeId === selectedNodeId) || null
    : null;

  const handleNodeClick = useCallback((event, node) => {
    onNodeSelect(prev => prev === node.id ? null : node.id);
  }, [onNodeSelect]);

  const handlePaneClick = useCallback(() => {
    onNodeSelect(null);
  }, [onNodeSelect]);

  return (
    <div className="execution-job-view">
      {/* Job header */}
      <div className="job-header">
        <div className="job-header-left">
          <h3>
            Job{' '}
            <span className="job-id">{execution.id}</span>
          </h3>
          <span className={`execution-status-badge status-${execution.status}`}>
            {execution.status.toUpperCase()}
          </span>
        </div>
        <div className="job-header-meta">
          <span>Started: {new Date(execution.startedAt).toLocaleString()}</span>
          {execution.finishedAt && (
            <span>Finished: {new Date(execution.finishedAt).toLocaleString()}</span>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="job-tabs">
        <button
          className={`job-tab ${tab === 'graph' ? 'active' : ''}`}
          onClick={() => onTabChange('graph')}
        >
          <span className="job-tab-icon"><Icon name="GitBranch" size={14} /></span> Graph
        </button>
        <button
          className={`job-tab ${tab === 'list' ? 'active' : ''}`}
          onClick={() => onTabChange('list')}
        >
          <span className="job-tab-icon"><Icon name="ClipboardList" size={14} /></span> List
        </button>
      </div>

      {/* Error banner */}
      {execution.error && (
        <div className="job-error-banner">
          ⚠️ {execution.error}
        </div>
      )}

      {/* Main job content */}
      <div className="job-content">
        {tab === 'graph' ? (
          <div className="job-graph-layout">
            <div className="job-graph" ref={graphWrapperRef}>
              {graphNodes.length > 0 ? (
                <ReactFlow
                  nodes={graphNodes}
                  edges={graphEdges}
                  nodeTypes={nodeTypes}
                  fitView
                  fitViewOptions={{ padding: 0.2 }}
                  nodesDraggable={false}
                  nodesConnectable={false}
                  elementsSelectable={false}
                  onNodeClick={handleNodeClick}
                  onPaneClick={handlePaneClick}
                >
                  <Background color={theme === 'dark' ? '#282834' : '#d0d4e4'} gap={20} />
                  <Controls showInteractive={false} />
                </ReactFlow>
              ) : (
                <div className="empty-state">
                  <p>No workflow graph data available</p>
                </div>
              )}

              {/* Status legend */}
              <div className="job-graph-legend">
                <span className="legend-item">
                  <span className="legend-dot success"></span> Success
                </span>
                <span className="legend-item">
                  <span className="legend-dot error"></span> Error
                </span>
                <span className="legend-item">
                  <span className="legend-dot idle"></span> Not executed
                </span>
              </div>
            </div>

            {/* Node detail panel (shown when a node is selected in graph) */}
            <div className={`job-node-detail ${selectedResult ? 'visible' : ''}`}>
              {selectedResult ? (
                <div className="node-detail-content">
                  <div className="node-detail-header">
                    <span className="node-detail-name">
                      {selectedResult.nodeName}
                    </span>
                    <span className={`node-detail-status status-${selectedResult.status}`}>
                      {selectedResult.status === 'success' ? '✅' : '❌'} {selectedResult.status.toUpperCase()}
                    </span>
                    <button
                      className="node-detail-close"
                      onClick={() => onNodeSelect(null)}
                    >
                      <Icon name="X" size={14} />
                    </button>
                  </div>

                  {selectedResult.error && (
                    <div className="node-result-error">{selectedResult.error}</div>
                  )}

                  {selectedResult.outputData && (
                    <details open>
                      <summary>Output Data</summary>
                      <div className="job-node-tree">
                        <JsonTreeView data={selectedResult.outputData} />
                      </div>
                    </details>
                  )}

                  {selectedResult.inputData && (
                    <details>
                      <summary>Input Data</summary>
                      <div className="job-node-tree">
                        <JsonTreeView data={selectedResult.inputData} />
                      </div>
                    </details>
                  )}
                </div>
              ) : (
                <div className="node-detail-empty">
                  <p>Click a node in the graph to view its details</p>
                </div>
              )}
            </div>
          </div>
        ) : (
          /* List view */
          <ExecutionDetail execution={execution} />
        )}
      </div>
    </div>
  );
}

// ---- ExecutionDetail Component ----
function ExecutionDetail({ execution }) {
  return (
    <div className="execution-detail-content">
      <div className="detail-header">
        <h3>Execution: {execution.id}</h3>
        <span className={`execution-status-badge status-${execution.status}`}>
          {execution.status.toUpperCase()}
        </span>
      </div>
      <div className="detail-meta">
        <div className="meta-row">
          <span className="meta-label">Started:</span>
          <span>{new Date(execution.startedAt).toLocaleString()}</span>
        </div>
        <div className="meta-row">
          <span className="meta-label">Finished:</span>
          <span>{execution.finishedAt ? new Date(execution.finishedAt).toLocaleString() : '—'}</span>
        </div>
        {execution.error && (
          <div className="meta-row error">
            <span className="meta-label">Error:</span>
            <span>{execution.error}</span>
          </div>
        )}
      </div>
      <div className="detail-trigger">
        <h4>Trigger Data</h4>
        <pre className="json-display">{JSON.stringify(execution.triggerData, null, 2)}</pre>
      </div>
      <h4>Node Results ({execution.nodeResults?.length || 0})</h4>
      <div className="detail-nodes">
        {(execution.nodeResults || []).map((result, idx) => (
          <div key={idx} className={`node-result ${result.status}`}>
            <div className="node-result-header">
              <span className="node-result-status">
                {result.status === 'success' ? '✅' : result.status === 'error' ? '❌' : '⚠️'}
              </span>
              <span className="node-result-name">{result.nodeName}</span>
              <span className="node-result-type">{result.nodeType}</span>
            </div>
            {result.error && (
              <div className="node-result-error">{result.error}</div>
            )}
            {result.outputData && (
              <details open>
                <summary>Output Data</summary>
                <pre className="json-display">{JSON.stringify(result.outputData, null, 2)}</pre>
              </details>
            )}
            {result.inputData && (
              <details open>
                <summary>Input Data</summary>
                <pre className="json-display">{JSON.stringify(result.inputData, null, 2)}</pre>
              </details>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
