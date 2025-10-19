/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GoogleGenAI, Chat, FunctionDeclaration, Type } from '@google/genai';
import { marked } from 'marked';
import mermaid from 'mermaid';

// --- TYPE DEFINITIONS ---
type Message = {
    role: 'user' | 'model';
    parts: { text: string }[];
};

type Artifact = {
    id: string;
    title: string;
    type: 'code' | 'document' | 'plan' | 'mermaid';
    content: string;
    language?: string;
};

type Snapshot = {
    id: string;
    timestamp: number;
    messageCount: number;
    history: Message[];
    artifacts: Artifact[];
};

type Flow = {
    id: string;
    name: string;
    history: Message[];
    snapshots: Snapshot[];
    artifacts: Artifact[];
};

type Flows = {
    [key: string]: Flow;
};

interface AppState {
    isLoading: boolean;
    flows: Flows;
    activeFlowId: string | null;
    aiChat: Chat | null;
    activeArtifactId: string | null;
    historyStack: Flow[];
    redoStack: Flow[];
}

// --- DOM ELEMENT REFERENCES ---
const DOM = {
    mainLayout: document.getElementById('main-layout') as HTMLDivElement,
    leftSidebar: document.getElementById('left-sidebar') as HTMLElement,
    leftSidebarToggle: document.getElementById('left-sidebar-toggle') as HTMLButtonElement,
    chatHistoryEl: document.getElementById('chat-history') as HTMLDivElement,
    chatForm: document.getElementById('chat-form') as HTMLFormElement,
    chatInput: document.getElementById('chat-input') as HTMLTextAreaElement,
    sendButton: document.querySelector('#chat-form button') as HTMLButtonElement,
    loadingIndicator: document.getElementById('loading-indicator') as HTMLDivElement,
    chatContainer: document.getElementById('chat-container') as HTMLDivElement,
    catalystsContainer: document.getElementById('catalysts-container') as HTMLDivElement,
    modalBackdrop: document.getElementById('modal-backdrop') as HTMLDivElement,
    nexusModal: document.getElementById('nexus-modal') as HTMLDivElement,
    nexusInput: document.getElementById('nexus-input') as HTMLInputElement,
    nexusResults: document.getElementById('nexus-results') as HTMLDivElement,
    flowList: document.getElementById('flow-list') as HTMLDivElement,
    newFlowBtn: document.getElementById('new-flow-btn') as HTMLButtonElement,
    artifactViewer: document.getElementById('artifact-viewer') as HTMLElement,
    artifactTabs: document.getElementById('artifact-tabs') as HTMLDivElement,
    artifactContent: document.getElementById('artifact-content') as HTMLDivElement,
    artifactControls: document.getElementById('artifact-controls') as HTMLDivElement,
    artifactCloseBtn: document.getElementById('artifact-close-btn') as HTMLButtonElement,
    undoBtn: document.getElementById('undo-btn') as HTMLButtonElement,
    redoBtn: document.getElementById('redo-btn') as HTMLButtonElement,
    settingsBtn: document.getElementById('settings-btn') as HTMLButtonElement,
    accountBtn: document.getElementById('account-btn') as HTMLButtonElement,
};

// --- GEMINI API SETUP ---
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
    displayFatalError('API_KEY environment variable not set.');
    throw new Error('API_KEY environment variable not set');
}
const ai = new GoogleGenAI({ apiKey: API_KEY });

const SYSTEM_INSTRUCTION = `You are ~flow, an elite AI consultant specializing in system architecture, process optimization, and strategic planning. The user, 'sprite*', is your client. Your purpose is to act as a multiplier for their productivity and clarity of thought.

**// Core Mandate: From Idea to Execution //**

1.  **Deconstruct & Clarify:** When sprite* presents an idea, your first step is to deconstruct it into its fundamental components. Ask clarifying questions to eliminate ambiguity. Your goal is to achieve a crystal-clear understanding of the objective.
2.  **Architect & Visualize:** For any process or system, generate a visual representation using Mermaid.js syntax (\`\`\`mermaid\`). This is non-negotiable for system design tasks. Concurrently, produce a step-by-step strategic plan or document.
3.  **Generate & Implement:** Produce high-quality, production-ready code in any requested language. The code must be clean, well-commented, and efficient.
4.  **Manage & Prioritize:** Proactively identify actionable items from the conversation. Use your \`create_task_list\` function to structure these items. Always assign a priority (High, Medium, Low) based on the strategic importance of the task to the user's stated goals.
5.  **Think & Anticipate:** Do not be a passive tool. Act as a strategic partner. Analyze sprite*'s requests for underlying needs. Suggest optimizations, identify potential bottlenecks, and propose alternative strategies that might yield better results. Challenge assumptions if you identify a more efficient path.
6.  **Iterate & Refine:** Existing artifacts are not final. If sprite* requests a change to a document or code you've already created, use the \`modify_artifact\` function to update it in place. This is crucial for iterative development.

**// Tool Usage Protocol //**

*   \`present_artifact\`: MANDATORY for significant **new** outputs. Use this to present generated code, architectural documents, detailed plans, or Mermaid diagrams in the dedicated artifact viewer.
*   \`modify_artifact\`: Use this to update an **existing** artifact with new content based on user feedback.
*   \`create_task_list\`: Use this to formalize any set of actions or to-dos. This transforms discussion into a concrete, trackable plan.

**// Persona Protocol //**

*   **Identity:** ~flow
*   **Client:** sprite*
*   **Demeanor:** Professional, insightful, slightly futuristic. You are a high-end consultant; your communication should reflect that. Concise, precise, and always focused on delivering value.`;


const presentArtifactDeclaration: FunctionDeclaration = {
  name: 'present_artifact',
  description: 'Presents a significant piece of content (like a code block or document) in a dedicated side panel for better viewing.',
  parameters: {
    type: Type.OBJECT,
    properties: {
      title: { type: Type.STRING, description: 'A short, descriptive title for the artifact. E.g., "Python Data Scraper".' },
      type: { type: Type.STRING, description: 'The type of artifact. Common types are "code", "document", "plan", "mermaid".' },
      content: { type: Type.STRING, description: 'The full content of the artifact.' },
      language: { type: Type.STRING, description: 'If the type is "code", specify the programming language (e.g., "python", "javascript").' }
    },
    required: ['title', 'type', 'content']
  }
};

const createTaskListDeclaration: FunctionDeclaration = {
    name: 'create_task_list',
    description: 'Creates a formatted, interactive task list in the chat to track project progress.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            tasks: {
                type: Type.ARRAY,
                items: {
                    type: Type.OBJECT,
                    properties: {
                        title: { type: Type.STRING, description: 'The text of the task.' },
                        priority: { type: Type.STRING, description: 'Priority level: "High", "Medium", or "Low". Must be one of these exact values.' }
                    },
                    required: ['title', 'priority']
                }
            }
        },
        required: ['tasks']
    }
};

const modifyArtifactDeclaration: FunctionDeclaration = {
    name: 'modify_artifact',
    description: 'Modifies the content of an existing artifact based on user feedback or further instructions.',
    parameters: {
        type: Type.OBJECT,
        properties: {
            artifactId: { type: Type.STRING, description: 'The ID of the artifact to modify. Example: "artifact-1699902888812"' },
            newContent: { type: Type.STRING, description: 'The new, complete content for the artifact.' }
        },
        required: ['artifactId', 'newContent']
    }
};

const tools = [{ functionDeclarations: [presentArtifactDeclaration, createTaskListDeclaration, modifyArtifactDeclaration] }];

// --- STATE MANAGEMENT ---
let state: AppState = {
    isLoading: false,
    flows: {},
    activeFlowId: null,
    aiChat: null,
    activeArtifactId: null,
    historyStack: [],
    redoStack: [],
};

const CATALYSTS = [
    { name: "API Integration", prompt: "Design a process for integrating a new third-party REST API into our existing user management system, including error handling and data synchronization. Present the final plan as an artifact." },
    { name: "CI/CD Pipeline", prompt: "Create a CI/CD pipeline for a web application using a Mermaid diagram. Also, create a task list for the implementation steps." },
    { name: "Data Processing Script", prompt: "Generate a Python script to process a large CSV file: read the data, clean it by removing duplicates and handling missing values, and then save the result to a new file. Present the script as a code artifact." },
    { name: "Cloud Infrastructure Setup", prompt: "Outline the steps to set up a scalable cloud infrastructure on AWS for a new social media application, using services like EC2, RDS, and S3. Include a Mermaid diagram and present the full architecture document as an artifact." }
];

// --- CORE FUNCTIONS ---

function setLoading(isLoading: boolean) {
    state.isLoading = isLoading;
    DOM.loadingIndicator.classList.toggle('hidden', !isLoading);
    DOM.chatInput.disabled = isLoading;
    DOM.sendButton.disabled = isLoading;
    DOM.chatInput.placeholder = isLoading ? "~flow is thinking..." : "describe a process...";
    
    const formContainer = DOM.chatForm.parentElement;
    if (formContainer) {
        formContainer.classList.toggle('thinking', isLoading);
    }
    
    if (isLoading) {
        DOM.chatContainer.appendChild(DOM.loadingIndicator);
    }
    if (!isLoading) DOM.chatInput.focus();
}

async function appendMessage(role: 'user' | 'model', text: string, extraHtml: string = '') {
    const message: Message = { role, parts: [{ text }] };
    if (state.activeFlowId) {
        const activeFlow = state.flows[state.activeFlowId];
        activeFlow.history.push(message);
        saveFlows();
    }
    
    const messageEl = await createMessageElement(message);
    if (extraHtml) {
        const extraContent = document.createElement('div');
        extraContent.innerHTML = extraHtml;
        messageEl.appendChild(extraContent);
    }
    DOM.chatHistoryEl.appendChild(messageEl);
    DOM.chatContainer.scrollTop = DOM.chatContainer.scrollHeight;
}


async function createMessageElement(message: Message): Promise<HTMLDivElement> {
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${message.role}`;

    const parsedHtml = await marked.parse(message.parts[0].text, {
        async: true,
        highlight: (code, lang) => {
            const language = lang || 'plaintext';
            let highlighted = code.replace(/</g, '&lt;').replace(/>/g, '&gt;');
             if (language === 'javascript' || language === 'python' || language === 'typescript' || language === 'html' || language === 'css') {
                highlighted = highlighted.replace(/(#.*|\/\/.*)/g, '<span class="token comment">$&</span>');
                highlighted = highlighted.replace(/('.*?'|".*?"|`.*?`)/g, '<span class="token string">$&</span>');
                highlighted = highlighted.replace(/\b(const|let|var|function|return|if|else|for|while|import|from|def|class|async|await|try|except|finally|public|private|protected|static|new|switch|case|break|continue|type|interface)\b/g, '<span class="token keyword">$&</span>');
                highlighted = highlighted.replace(/\b(true|false|null|undefined|self|this)\b/g, '<span class="token boolean">$&</span>');
                highlighted = highlighted.replace(/\b(\d+(\.\d+)?)\b/g, '<span class="token number">$&</span>');
                highlighted = highlighted.replace(/([{}()[\],.;:?&|=<>!+-/*%^])/g, '<span class="token punctuation">$&</span>');
                highlighted = highlighted.replace(/@\w+/g, '<span class="token function">$&</span>');
             }
            return highlighted;
        },
        langPrefix: 'language-',
    });
    messageDiv.innerHTML = parsedHtml;

    // Enhance code blocks post-parsing
    messageDiv.querySelectorAll('pre').forEach(preEl => {
        const codeEl = preEl.querySelector('code');
        if (!codeEl || codeEl.classList.contains('language-mermaid')) return;

        const langClass = Array.from(codeEl.classList).find(cls => cls.startsWith('language-')) || 'language-plaintext';
        const language = langClass.replace('language-', '');

        const container = document.createElement('div');
        container.className = 'code-block-container';
        const header = document.createElement('div');
        header.className = 'code-block-header';
        const langSpan = document.createElement('span');
        langSpan.className = 'language-name';
        langSpan.textContent = language;
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-code-btn';
        copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Copy code</span>`;
        copyBtn.onclick = () => {
            navigator.clipboard.writeText(codeEl.textContent || '').then(() => {
                const btnSpan = copyBtn.querySelector('span');
                if (btnSpan) btnSpan.textContent = 'Copied!';
                setTimeout(() => { if (btnSpan) btnSpan.textContent = 'Copy code'; }, 2000);
            });
        };

        header.append(langSpan, copyBtn);
        container.append(header, preEl.cloneNode(true));
        preEl.replaceWith(container);
    });

    // Process Mermaid diagrams
    messageDiv.querySelectorAll('pre code.language-mermaid').forEach((el, index) => {
        const diagramId = `mermaid-${Date.now()}-${index}`;
        const container = document.createElement('div');
        container.className = 'mermaid';
        container.id = diagramId;
        const source = el.textContent || '';
        container.textContent = source;
        el.parentElement!.replaceWith(container);

        try {
           mermaid.render(diagramId, source, (svgCode) => {
               container.innerHTML = svgCode;
           });
        } catch (e) {
           container.innerHTML = "Error rendering diagram.";
           console.error("Mermaid render error:", e);
        }
    });

    return messageDiv;
}

async function handleFunctionCall(fc: any) {
    const { name, args } = fc;
    const activeFlow = state.flows[state.activeFlowId!];
    pushUndoState();

    switch (name) {
        case 'present_artifact':
            const newArtifact: Artifact = {
                id: `artifact-${Date.now()}`,
                ...args
            };
            activeFlow.artifacts.push(newArtifact);
            state.activeArtifactId = newArtifact.id;
            saveFlows();
            renderArtifactViewer();
            break;
        case 'create_task_list':
            const taskListHtml = renderTaskList(args.tasks);
            await appendMessage('model', 'I have created the following task list for you:', taskListHtml);
            break;
        case 'modify_artifact':
            const artifactToModify = activeFlow.artifacts.find(a => a.id === args.artifactId);
            if (artifactToModify) {
                artifactToModify.content = args.newContent;
                saveFlows();
                // If the modified artifact is the active one, re-render its content
                if (state.activeArtifactId === args.artifactId) {
                    await renderArtifactContent(artifactToModify);
                }
                // Optional: append a confirmation message
                await appendMessage('model', `I have updated the artifact: *${artifactToModify.title}*.`);
            } else {
                await appendMessage('model', `Apologies, I could not find an artifact with the ID ${args.artifactId}.`);
            }
            break;
    }
}

function renderTaskList(tasks: {title: string, priority: string}[]): string {
    let taskHtml = '<div class="task-list"><h3>Task List</h3>';
    tasks.forEach((task, index) => {
        const taskId = `task-${Date.now()}-${index}`;
        taskHtml += `
            <div class="task-item">
                <input type="checkbox" id="${taskId}" onchange="this.parentElement.classList.toggle('completed')">
                <label for="${taskId}">${task.title}</label>
                <span class="task-priority ${task.priority.toLowerCase()}">${task.priority}</span>
            </div>
        `;
    });
    taskHtml += '</div>';
    return taskHtml;
}


async function handleFormSubmit(e: Event) {
    e.preventDefault();
    if (state.isLoading) return;

    const userMessage = DOM.chatInput.value.trim();
    if (!userMessage) return;

    pushUndoState();
    DOM.catalystsContainer.classList.add('hidden');
    await appendMessage('user', userMessage);
    DOM.chatForm.reset();
    adjustTextareaHeight();
    setLoading(true);

    try {
        const response = await state.aiChat!.sendMessage(userMessage);
        
        const text = response.text;
        if (text) {
            await appendMessage('model', text);
        }

        const functionCalls = response.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
            for (const fc of functionCalls) {
                await handleFunctionCall(fc);
            }
        }

    } catch (error) {
        console.error(error);
        await appendMessage('model', 'apologies sprite*. an error occurred. please try again.');
    } finally {
        setLoading(false);
    }
}

// --- FLOW MANAGEMENT ---

function loadFlows() {
    try {
        const flows = localStorage.getItem('fluid_flows');
        state.flows = flows ? JSON.parse(flows) : {};
    } catch {
        state.flows = {};
    }

    if (Object.keys(state.flows).length === 0) {
        const id = `flow-${Date.now()}`;
        state.flows[id] = { id, name: "My First Flow", history: [], snapshots: [], artifacts: [] };
        state.activeFlowId = id;
    }
    
    const activeId = localStorage.getItem('fluid_active_flow_id');
    state.activeFlowId = activeId && state.flows[activeId] ? activeId : Object.keys(state.flows)[0];
}

function saveFlows() {
    localStorage.setItem('fluid_flows', JSON.stringify(state.flows));
    localStorage.setItem('fluid_active_flow_id', state.activeFlowId!);
}

function renderFlowList() {
    DOM.flowList.innerHTML = '';
    const frag = document.createDocumentFragment();
    Object.values(state.flows).forEach(flow => {
        const item = document.createElement('div');
        item.className = 'flow-item';
        item.dataset.id = flow.id;
        item.classList.toggle('active', flow.id === state.activeFlowId);

        item.innerHTML = `
            <span class="flow-item-name">${flow.name}</span>
            <div class="flow-item-actions">
                <button data-action="rename" title="Rename">✏️</button>
                <button data-action="delete" title="Delete">🗑️</button>
            </div>
        `;
        frag.appendChild(item);
    });
    DOM.flowList.appendChild(frag);
}

function handleFlowListClick(e: MouseEvent) {
    const target = e.target as HTMLElement;
    const flowItem = target.closest('.flow-item') as HTMLDivElement;
    if (!flowItem) return;

    const flowId = flowItem.dataset.id!;
    const action = target.dataset.action;

    if (action === 'rename') {
        renameFlow(flowId);
    } else if (action === 'delete') {
        deleteFlow(flowId);
    } else {
        switchFlow(flowId);
    }
}

async function switchFlow(id: string) {
    if (id === state.activeFlowId) return;
    state.activeFlowId = id;
    saveFlows();
    await initializeChat();
}

function createNewFlow() {
    pushUndoState();
    const id = `flow-${Date.now()}`;
    const count = Object.keys(state.flows).length + 1;
    state.flows[id] = { id, name: `New Flow ${count}`, history: [], snapshots: [], artifacts: [] };
    state.activeFlowId = id;
    saveFlows();
    initializeChat();
}

function renameFlow(id: string) {
    pushUndoState();
    const flow = state.flows[id];
    const newName = prompt("Enter new name for flow:", flow.name);
    if (newName && newName.trim() !== "") {
        flow.name = newName.trim();
        saveFlows();
        renderFlowList();
    }
}

function deleteFlow(id: string) {
    if (Object.keys(state.flows).length <= 1) {
        alert("Cannot delete the last flow.");
        return;
    }
    if (confirm(`Are you sure you want to delete "${state.flows[id].name}"?`)) {
        pushUndoState();
        delete state.flows[id];
        if (state.activeFlowId === id) {
            state.activeFlowId = Object.keys(state.flows)[0];
        }
        saveFlows();
        initializeChat();
    }
}

// --- ARTIFACT MANAGEMENT ---
function renderArtifactViewer() {
    const flow = state.flows[state.activeFlowId!];
    if (!flow || flow.artifacts.length === 0) {
        DOM.artifactViewer.classList.add('hidden');
        return;
    }

    DOM.artifactViewer.classList.remove('hidden');
    DOM.artifactTabs.innerHTML = '';

    flow.artifacts.forEach(artifact => {
        const tab = document.createElement('button');
        tab.className = 'artifact-tab';
        tab.textContent = artifact.title;
        tab.dataset.id = artifact.id;
        if (artifact.id === state.activeArtifactId) {
            tab.classList.add('active');
            renderArtifactContent(artifact);
        }
        tab.onclick = () => {
            state.activeArtifactId = artifact.id;
            saveFlows(); // Save active artifact
            document.querySelectorAll('.artifact-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            renderArtifactContent(artifact);
        };
        DOM.artifactTabs.appendChild(tab);
    });

    if (!state.activeArtifactId || !flow.artifacts.find(a => a.id === state.activeArtifactId)) {
        state.activeArtifactId = flow.artifacts[flow.artifacts.length - 1].id;
        renderArtifactViewer(); // Re-render to set active tab
    }
}

async function renderArtifactContent(artifact: Artifact) {
    DOM.artifactContent.innerHTML = '';
    DOM.artifactControls.innerHTML = '';

    const contentWrapper = document.createElement('div');
    contentWrapper.dataset.artifactId = artifact.id;

    if (artifact.type === 'code' || artifact.type === 'mermaid') {
        const lang = artifact.language || (artifact.type === 'mermaid' ? 'mermaid' : 'plaintext');
        const fakeMessage: Message = { role: 'model', parts: [{ text: `\`\`\`${lang}\n${artifact.content}\n\`\`\`` }] };
        const messageEl = await createMessageElement(fakeMessage);
        const codeBlock = messageEl.querySelector('.code-block-container, .mermaid');
        if (codeBlock) {
            contentWrapper.appendChild(codeBlock);
        }
    } else {
         const parsedHtml = await marked.parse(artifact.content, { async: true });
         contentWrapper.innerHTML = `<div class="prose">${parsedHtml}</div>`;
    }
    DOM.artifactContent.appendChild(contentWrapper);

    // Add Edit/Save controls
    const editBtn = document.createElement('button');
    editBtn.textContent = 'Edit';
    editBtn.className = 'artifact-control-btn';
    const saveBtn = document.createElement('button');
    saveBtn.textContent = 'Save';
    saveBtn.className = 'artifact-control-btn';
    saveBtn.style.display = 'none';

    editBtn.onclick = () => {
        const contentEl = DOM.artifactContent.querySelector('pre, .prose');
        if (contentEl) {
            contentEl.setAttribute('contenteditable', 'true');
            // FIX: Cast Element to HTMLElement to access the focus() method.
            (contentEl as HTMLElement).focus();
            editBtn.style.display = 'none';
            saveBtn.style.display = 'inline-block';
        }
    };

    saveBtn.onclick = () => {
        const contentEl = DOM.artifactContent.querySelector('[contenteditable="true"]');
        if (contentEl) {
            pushUndoState();
            contentEl.setAttribute('contenteditable', 'false');
            const activeArtifact = state.flows[state.activeFlowId!].artifacts.find(a => a.id === artifact.id);
            if (activeArtifact) {
                activeArtifact.content = (contentEl.textContent || '').trim();
                saveFlows();
            }
            editBtn.style.display = 'inline-block';
            saveBtn.style.display = 'none';
        }
    };

    DOM.artifactControls.append(editBtn, saveBtn);
}

// --- UNDO/REDO ---
function pushUndoState() {
    if (!state.activeFlowId) return;
    // Deep clone the current flow state
    const currentFlow = JSON.parse(JSON.stringify(state.flows[state.activeFlowId]));
    state.historyStack.push(currentFlow);
    state.redoStack = []; // Clear redo stack on new action
    updateUndoRedoButtons();
}

function handleUndo() {
    if (state.historyStack.length === 0) return;
    const currentFlow = JSON.parse(JSON.stringify(state.flows[state.activeFlowId!]));
    state.redoStack.push(currentFlow);
    const previousFlow = state.historyStack.pop()!;
    state.flows[state.activeFlowId!] = previousFlow;
    saveFlows();
    initializeChat(true); // Soft refresh
    updateUndoRedoButtons();
}

function handleRedo() {
    if (state.redoStack.length === 0) return;
    const currentFlow = JSON.parse(JSON.stringify(state.flows[state.activeFlowId!]));
    state.historyStack.push(currentFlow);
    const nextFlow = state.redoStack.pop()!;
    state.flows[state.activeFlowId!] = nextFlow;
    saveFlows();
    initializeChat(true); // Soft refresh
    updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
    DOM.undoBtn.disabled = state.historyStack.length === 0;
    DOM.redoBtn.disabled = state.redoStack.length === 0;
}


// --- UI & INITIALIZATION ---

function adjustTextareaHeight() {
    DOM.chatInput.style.height = 'auto';
    DOM.chatInput.style.height = `${DOM.chatInput.scrollHeight}px`;
}

function displayFatalError(message: string) {
    document.body.innerHTML = `<div style="color: red; padding: 2rem;">${message}</div>`;
}

async function initializeChat(softRefresh = false) {
    setLoading(true);
    DOM.chatHistoryEl.innerHTML = '';
    
    if (!softRefresh) {
        state.historyStack = [];
        state.redoStack = [];
        updateUndoRedoButtons();
    }

    const activeFlow = state.flows[state.activeFlowId!];

    if (!activeFlow) {
        console.error("No active flow found!");
        setLoading(false);
        return;
    }

    // For new flows, display a welcome message/tutorial that is NOT part of the official history.
    if (activeFlow.history.length === 0) {
        const welcomeMessageText = `Welcome to .fluid, sprite*. I am ~flow, your AI consultant.

**My Core Functions:**
*   **Process Design:** Describe a workflow, and I'll map it out, often with a Mermaid diagram.
*   **Code Generation:** Request code, and I'll generate production-ready snippets.
*   **Task Management:** I will identify action items and can create formal task lists for you.
*   **Artifacts:** Any significant outputs like code or documents will appear in a dedicated viewer on your right.

You can start by describing a process, or select a catalyst below to see me in action. How can I optimize your workflow today?`;
        const welcomeMessage: Message = { role: 'model', parts: [{ text: welcomeMessageText }] };
        const el = await createMessageElement(welcomeMessage);
        DOM.chatHistoryEl.appendChild(el);
    } else {
        // For existing flows, render the saved history
        const frag = document.createDocumentFragment();
        for (const message of activeFlow.history) {
            const el = await createMessageElement(message);
            frag.appendChild(el);
        }
        DOM.chatHistoryEl.appendChild(frag);
    }
    
    const history: { role: 'user' | 'model'; parts: { text: string }[] }[] = activeFlow.history.map(m => ({
        role: m.role,
        parts: m.parts
    }));

    state.aiChat = ai.chats.create({
        model: 'gemini-2.5-flash',
        systemInstruction: SYSTEM_INSTRUCTION,
        history: history,
        tools: tools,
    });

    DOM.chatContainer.scrollTop = DOM.chatContainer.scrollHeight;
    DOM.catalystsContainer.classList.toggle('hidden', activeFlow.history.length > 0);
    
    state.activeArtifactId = activeFlow.artifacts.length > 0 ? activeFlow.artifacts.find(a => a.id === state.activeArtifactId)?.id || activeFlow.artifacts[activeFlow.artifacts.length - 1].id : null;
    renderArtifactViewer();
    
    renderFlowList();
    setLoading(false);
}


async function init() {
    mermaid.initialize({ startOnLoad: false, theme: 'dark', darkMode: true, 
        themeVariables: {
            background: '#01121d',
            primaryColor: '#002e3c',
            primaryTextColor: '#f0f8ff',
            lineColor: '#00f6ff',
            textColor: '#f0f8ff',
            nodeBorder: '#00f6ff'
        }
    });

    DOM.chatForm.addEventListener('submit', handleFormSubmit);
    DOM.chatInput.addEventListener('input', adjustTextareaHeight);
    DOM.chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'z' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            if (e.shiftKey) {
                handleRedo();
            } else {
                handleUndo();
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            DOM.chatForm.requestSubmit();
        }
    });

    // Sidebar toggles
    DOM.leftSidebarToggle.addEventListener('click', () => {
        DOM.mainLayout.classList.toggle('left-collapsed');
        DOM.leftSidebar.classList.toggle('collapsed');
    });
    
    DOM.artifactCloseBtn.addEventListener('click', () => {
        DOM.artifactViewer.classList.add('hidden');
    });

    // Catalyst buttons
    CATALYSTS.forEach(catalyst => {
        const btn = document.createElement('button');
        btn.className = 'catalyst-btn';
        btn.textContent = catalyst.name;
        btn.onclick = () => {
            DOM.chatInput.value = catalyst.prompt;
            DOM.chatForm.requestSubmit();
        };
        DOM.catalystsContainer.appendChild(btn);
    });

    DOM.newFlowBtn.addEventListener('click', createNewFlow);
    DOM.flowList.addEventListener('click', handleFlowListClick);
    DOM.undoBtn.addEventListener('click', handleUndo);
    DOM.redoBtn.addEventListener('click', handleRedo);
    
    // Finalize placeholder buttons
    DOM.settingsBtn.addEventListener('click', () => alert('Settings panel is not yet implemented.'));
    DOM.accountBtn.addEventListener('click', () => alert('Account management is not yet implemented.'));


    loadFlows();
    await initializeChat();
}

document.addEventListener('DOMContentLoaded', init);