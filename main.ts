import {
	App,
	Editor,
	MarkdownView,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	TFile,
	TFolder,
	requestUrl,
	ItemView,
	WorkspaceLeaf,
	MarkdownRenderer,
	Component,
} from "obsidian";
import { LettaClient, LettaError } from "@letta-ai/letta-client";
import { LettaCodeBridge } from "./letta-code/bridge";
import { LettaCodeMessage } from "./letta-code/types";
import { BridgeToolRegistry } from "./letta-code/tools";

// Store original fetch for non-Letta requests
const originalFetch = window.fetch.bind(window);

// Custom fetch that uses Obsidian's requestUrl for Letta API calls (bypasses CORS)
function createObsidianFetch(lettaBaseUrl: string): typeof fetch {
	return async function obsidianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

		// Only intercept Letta API calls
		if (!url.includes('letta.com') && !url.startsWith(lettaBaseUrl)) {
			return originalFetch(input, init);
		}

		try {
			const headers: Record<string, string> = {};
			if (init?.headers) {
				if (init.headers instanceof Headers) {
					init.headers.forEach((value, key) => { headers[key] = value; });
				} else if (Array.isArray(init.headers)) {
					init.headers.forEach(([key, value]) => { headers[key] = value; });
				} else {
					Object.assign(headers, init.headers);
				}
			}

			const response = await requestUrl({
				url,
				method: (init?.method as string) || 'GET',
				headers,
				body: init?.body as string | undefined,
				throw: false,
			});

			// Create a Response-like object
			return new Response(response.text, {
				status: response.status,
				statusText: response.status === 200 ? 'OK' : 'Error',
				headers: new Headers(response.headers),
			});
		} catch (error) {
			console.error('[Letta Plugin] obsidianFetch error:', error);
			throw error;
		}
	};
}

export const LETTA_CHAT_VIEW_TYPE = "letta-chat-view";
export const LETTA_MEMORY_VIEW_TYPE = "letta-memory-view";

// Rate limit message constants
export const RATE_LIMIT_MESSAGE = {
	TITLE: "Rate Limit Exceeded - You've reached the rate limit for your account. Please wait a moment before sending another message.",
	UPGRADE_TEXT:
		"Need more? Letta Cloud offers Pro, Scale, and Enterprise plans:",
	BILLING_URL: "https://app.letta.com/settings/organization/billing",
	CUSTOM_KEYS_TEXT: "Or bring your own inference provider:",
	CUSTOM_KEYS_URL: "https://docs.letta.com/guides/cloud/custom-keys",

	// Helper function to create full message
	create: (reason: string) => `${RATE_LIMIT_MESSAGE.TITLE}

Reason: ${reason}

${RATE_LIMIT_MESSAGE.UPGRADE_TEXT}
${RATE_LIMIT_MESSAGE.BILLING_URL}

${RATE_LIMIT_MESSAGE.CUSTOM_KEYS_TEXT}
${RATE_LIMIT_MESSAGE.CUSTOM_KEYS_URL}`,
};

// Error handling interfaces
interface RateLimitError extends Error {
	isRateLimit: boolean;
	retryAfter: number | null;
}

interface EnhancedError extends Error {
	status: number;
	responseText: string;
	responseJson: any;
}

// Agent type definitions
type AgentType =
	| "memgpt_v2_agent"
	| "react_agent"
	| "workflow_agent"
	| "sleeptime_agent";

// Recent agent for quick switching
interface RecentAgent {
	id: string;
	name: string;
	projectSlug?: string;
	lastUsed: number; // timestamp
}

// Message cache for fast conversation loading
interface CachedMessage {
	id: string;
	created_at: number;  // Unix timestamp
	message_type: string;
	raw: any;  // Full message object for rendering
}

interface MessageCache {
	agentId: string;
	messages: CachedMessage[];
	lastMessageId: string | null;      // Most recent message ID (for incremental sync)
	oldestMessageId: string | null;    // Oldest loaded message ID (for pagination)
	lastSyncTimestamp: number;         // When cache was last synced
	hasMoreOlder: boolean;             // Whether more older messages exist
}

interface LettaPluginSettings {
	lettaApiKey: string;
	lettaBaseUrl: string;
	lettaProjectSlug: string;
	agentId: string;
	agentName: string; // Keep for display purposes, but use agentId for API calls
	engineMode: 'cloud' | 'local'; // Cloud (Letta API) or Local (Letta Code)
	autoConnect: boolean; // Control whether to auto-connect on startup
	showReasoning: boolean; // Control whether reasoning messages are visible
	enableStreaming: boolean; // Control whether to use streaming API responses
	useTokenStreaming: boolean; // Use token-level streaming (ChatGPT-like) vs step streaming (full messages)
	allowAgentCreation: boolean; // Control whether agent creation modal can be shown
	askBeforeToolRegistration: boolean; // Ask for consent before registering vault tools
	// Deprecated - use enableVaultTools instead
	enableCustomTools?: boolean;
	defaultNoteFolder: string; // Default folder for new notes created via custom tools
	focusMode: boolean; // Control whether to track and share the currently viewed note
	focusBlockCharLimit: number; // Character limit for the focus mode memory block
	// Multi-agent settings
	recentAgents: RecentAgent[]; // Recently used agents for quick switching
	loadHistoryOnSwitch: boolean; // Load conversation history when switching agents
	historyPageSize: number; // Number of messages to load at once
	// Vault tools settings
	enableVaultTools: boolean; // Master toggle for vault collaboration tools
	vaultToolsApprovedThisSession: boolean; // Session-based approval for write operations
	blockedFolders: string[]; // Folders agents cannot access
	// Message cache settings
	messageCache: Record<string, MessageCache>;  // Keyed by agent ID
	enableMessageCache: boolean;  // Enable/disable caching
	cacheMaxMessages: number;  // Max messages to cache per agent
	// Deprecated properties (kept for compatibility)
	sourceName?: string;
	autoSync?: boolean;
	syncOnStartup?: boolean;
	askBeforeFolderCreation?: boolean;
	askBeforeFolderAttachment?: boolean;
}

const DEFAULT_SETTINGS: LettaPluginSettings = {
	lettaApiKey: "",
	lettaBaseUrl: "https://api.letta.com",
	lettaProjectSlug: "", // No default project - will be determined by agent selection
	agentId: "",
	agentName: "Obsidian Assistant",
	engineMode: "cloud", // Default to cloud mode for compatibility
	autoConnect: false, // Default to not auto-connecting to avoid startup blocking
	showReasoning: true, // Default to showing reasoning messages in tool interactions
	enableStreaming: true, // Default to enabling streaming for real-time responses
	useTokenStreaming: true, // Default to token streaming for real-time ChatGPT-like experience
	allowAgentCreation: true, // Default to enabling agent creation modal
	askBeforeToolRegistration: true, // Default to asking before registering vault tools
	defaultNoteFolder: "lettamade", // Default folder for agent-created notes
	focusMode: true, // Default to enabling focus mode
	focusBlockCharLimit: 4000, // Default character limit for focus block
	// Multi-agent defaults
	recentAgents: [], // No recent agents initially
	loadHistoryOnSwitch: true, // Load history when switching agents
	historyPageSize: 50, // Load 50 messages at a time
	// Vault tools defaults
	enableVaultTools: true, // Enable vault collaboration tools
	vaultToolsApprovedThisSession: false, // Require approval on first use
	blockedFolders: [".obsidian", ".trash"], // Block system folders
	// Message cache defaults
	messageCache: {},  // Empty cache initially
	enableMessageCache: true,  // Enable caching by default
	cacheMaxMessages: 200,  // Cache up to 200 messages per agent
};

// File attachment types for chat
type AttachmentType = 'image' | 'text' | 'pdf' | 'office-doc' | 'office-sheet' | 'office-ppt';

interface PendingAttachment {
	file: File;
	type: AttachmentType;
	base64?: string;        // For images
	extractedText?: string; // For text/office files
	originalPath?: string;  // Path where original was saved in vault
	previewEl: HTMLElement;
	size: number;
}

// File processing utilities
class FileProcessor {
	/**
	 * Detect file type from extension and MIME type
	 */
	static detectFileType(file: File): AttachmentType {
		const ext = file.name.split('.').pop()?.toLowerCase() || '';
		const mimeType = file.type.toLowerCase();

		// Images
		if (mimeType.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(ext)) {
			return 'image';
		}

		// PDF
		if (ext === 'pdf' || mimeType === 'application/pdf') {
			return 'pdf';
		}

		// Office documents
		if (ext === 'docx' || mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
			return 'office-doc';
		}

		// Office spreadsheets
		if (['xlsx', 'xls', 'csv'].includes(ext) ||
			mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
			mimeType === 'text/csv') {
			return 'office-sheet';
		}

		// Office presentations
		if (ext === 'pptx' || mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') {
			return 'office-ppt';
		}

		// Default to text for txt, md, json and unknown
		return 'text';
	}

	/**
	 * Get file type icon for preview
	 */
	static getFileIcon(type: AttachmentType): string {
		switch (type) {
			case 'image': return '🖼️';
			case 'pdf': return '📄';
			case 'office-doc': return '📝';
			case 'office-sheet': return '📊';
			case 'office-ppt': return '📽️';
			case 'text': return '📃';
			default: return '📎';
		}
	}

	/**
	 * Format file size for display
	 */
	static formatFileSize(bytes: number): string {
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
	}

	/**
	 * Check if file type is supported
	 */
	static isSupportedType(file: File): boolean {
		const ext = file.name.split('.').pop()?.toLowerCase() || '';
		const supportedExtensions = [
			// Images
			'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
			// Documents
			'pdf', 'txt', 'md', 'json',
			// Office
			'docx', 'xlsx', 'xls', 'csv', 'pptx'
		];
		return supportedExtensions.includes(ext) || file.type.startsWith('image/');
	}

	/**
	 * Extract text from a file based on its type
	 */
	static async extractText(file: File, type: AttachmentType): Promise<string> {
		switch (type) {
			case 'text':
				return await FileProcessor.extractTextFile(file);
			case 'pdf':
				return await FileProcessor.extractPdf(file);
			case 'office-doc':
				return await FileProcessor.extractDocx(file);
			case 'office-sheet':
				return await FileProcessor.extractXlsx(file);
			case 'office-ppt':
				return await FileProcessor.extractPptx(file);
			default:
				return '';
		}
	}

	/**
	 * Extract text from plain text files (txt, md, json)
	 */
	static async extractTextFile(file: File): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => resolve(reader.result as string);
			reader.onerror = () => reject(new Error('Failed to read text file'));
			reader.readAsText(file);
		});
	}

	/**
	 * Extract text from DOCX files using mammoth
	 */
	static async extractDocx(file: File): Promise<string> {
		try {
			// Dynamic import to avoid loading if not needed
			const mammoth = await import('mammoth');
			const arrayBuffer = await file.arrayBuffer();
			const result = await mammoth.extractRawText({ arrayBuffer });
			return result.value;
		} catch (error) {
			console.error('[FileProcessor] Failed to extract DOCX:', error);
			return `[Error extracting ${file.name}: ${error.message}]`;
		}
	}

	/**
	 * Extract text from XLSX/CSV files using xlsx
	 */
	static async extractXlsx(file: File): Promise<string> {
		try {
			// Dynamic import to avoid loading if not needed
			const XLSX = await import('xlsx');
			const arrayBuffer = await file.arrayBuffer();

			// Check if it's a CSV file
			const ext = file.name.split('.').pop()?.toLowerCase();
			if (ext === 'csv') {
				// Read CSV as text first for better handling
				const text = await file.text();
				const workbook = XLSX.read(text, { type: 'string' });
				const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
				return XLSX.utils.sheet_to_csv(firstSheet);
			}

			const workbook = XLSX.read(arrayBuffer, { type: 'array' });
			const results: string[] = [];

			// Process each sheet
			for (const sheetName of workbook.SheetNames) {
				const sheet = workbook.Sheets[sheetName];
				const csv = XLSX.utils.sheet_to_csv(sheet);
				if (csv.trim()) {
					results.push(`## Sheet: ${sheetName}\n\n${csv}`);
				}
			}

			return results.join('\n\n---\n\n');
		} catch (error) {
			console.error('[FileProcessor] Failed to extract XLSX:', error);
			return `[Error extracting ${file.name}: ${error.message}]`;
		}
	}

	/**
	 * Extract text from PDF files using pdf.js
	 */
	static async extractPdf(file: File): Promise<string> {
		try {
			const pdfjsLib = await import('pdfjs-dist');

			const arrayBuffer = await file.arrayBuffer();
			const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

			const textParts: string[] = [];
			for (let i = 1; i <= pdf.numPages; i++) {
				const page = await pdf.getPage(i);
				const textContent = await page.getTextContent();
				const pageText = (textContent.items as any[])
					.map(item => item.str)
					.join(' ');
				if (pageText.trim()) {
					textParts.push(`[Page ${i}]\n${pageText}`);
				}
			}

			if (textParts.length === 0) {
				return `[PDF "${file.name}" appears to be image-based/scanned. No text could be extracted. Original saved to vault.]`;
			}

			return textParts.join('\n\n');
		} catch (error: any) {
			console.error('[FileProcessor] Failed to extract PDF:', error);
			return `[Error extracting PDF "${file.name}": ${error.message}]`;
		}
	}

	/**
	 * Extract text from PPTX files
	 * Note: PPTX parsing is limited - original file is saved to vault for custom tool access
	 */
	static async extractPptx(file: File): Promise<string> {
		// PPTX parsing requires specialized library (not included to keep bundle small)
		// Original file will be saved to vault for custom Letta tools to process
		return `[PowerPoint presentation: ${file.name}]\n[Note: Full PPTX parsing requires custom tools. Original file will be saved to vault for future access.]`;
	}
}

interface LettaAgent {
	id: string;
	name: string;
	llm_config?: {
		model: string;
		model_endpoint_type: string;
		provider_name: string;
		provider_category: "base" | "byok";
		temperature?: number;
		max_tokens?: number;
		context_window?: number;
	};
}

interface LettaModel {
	model: string;
	model_endpoint_type: string;
	provider_name: string;
	provider_category: "base" | "byok";
	context_window: number;
	model_endpoint?: string;
	model_wrapper?: string;
	temperature?: number;
	max_tokens?: number;
	handle?: string;
}

interface LettaSource {
	id: string;
	name: string;
}

interface ObsidianNoteProposal {
	action: "create_note";
	title: string;
	content: string;
	folder?: string;
	tags?: string[];
}

interface LettaMessage {
	message_type: string;
	content?: string;
	reasoning?: string;
	tool_call?: any;
	tool_return?: any;
}

interface AgentConfig {
	name: string;
	system?: string;
	agent_type?:
		| "memgpt_agent"
		| "memgpt_v2_agent"
		| "react_agent"
		| "workflow_agent"
		| "split_thread_agent"
		| "sleeptime_agent"
		| "voice_convo_agent"
		| "voice_sleeptime_agent";
	description?: string;
	model?: string;
	include_base_tools?: boolean;
	include_multi_agent_tools?: boolean;
	include_default_source?: boolean;
	tags?: string[];
	memory_blocks?: Array<{
		value: string;
		label: string;
		limit?: number;
		description?: string;
	}>;
}

/**
 * MessageCacheManager - Handles caching of conversation history for fast loading
 * Uses Obsidian's persistent storage and incremental sync with Letta API
 */
class MessageCacheManager {
	private plugin: any;  // LettaPlugin - using any to avoid circular reference

	constructor(plugin: any) {
		this.plugin = plugin;
	}

	// Get cache for specific agent
	getCache(agentId: string): MessageCache | null {
		return this.plugin.settings.messageCache?.[agentId] || null;
	}

	// Save cache to Obsidian's persistent storage
	async saveCache(agentId: string, cache: MessageCache): Promise<void> {
		if (!this.plugin.settings.messageCache) {
			this.plugin.settings.messageCache = {};
		}

		// Trim cache if too large
		const maxMessages = this.plugin.settings.cacheMaxMessages || 200;
		if (cache.messages.length > maxMessages) {
			// Keep most recent messages
			cache.messages = cache.messages.slice(-maxMessages);
			cache.oldestMessageId = cache.messages[0]?.id || null;
			cache.hasMoreOlder = true;
		}

		this.plugin.settings.messageCache[agentId] = cache;
		await this.plugin.saveSettings();
	}

	// Transform API message to cached format
	private transformMessage(msg: any): CachedMessage {
		return {
			id: msg.id,
			created_at: typeof msg.created_at === 'number'
				? msg.created_at
				: new Date(msg.date || msg.created_at || Date.now()).getTime() / 1000,
			message_type: msg.message_type || msg.type,
			raw: msg
		};
	}

	// Fetch only NEW messages since last sync (incremental)
	async fetchNewMessages(agentId: string): Promise<CachedMessage[]> {
		const cache = this.getCache(agentId);
		const newMessages: CachedMessage[] = [];

		if (!cache?.lastMessageId) {
			return newMessages;
		}

		try {
			// Use 'after' parameter to get only messages newer than lastMessageId
			const endpoint = `/v1/agents/${agentId}/messages?after=${cache.lastMessageId}&limit=100`;
			const response = await this.plugin.makeRequest(endpoint);

			if (response && Array.isArray(response) && response.length > 0) {
				for (const msg of response) {
					newMessages.push(this.transformMessage(msg));
				}
				console.log(`[Letta Cache] Fetched ${newMessages.length} new messages`);
			}
		} catch (error) {
			console.error("[Letta Cache] Error fetching new messages:", error);
		}

		return newMessages;
	}

	// Full sync - initial load or when cache is empty
	async fullSync(agentId: string, limit?: number): Promise<CachedMessage[]> {
		const pageSize = limit || this.plugin.settings.historyPageSize || 50;

		try {
			const endpoint = `/v1/agents/${agentId}/messages?limit=${pageSize}`;
			const response = await this.plugin.makeRequest(endpoint);

			if (!response || !Array.isArray(response) || response.length === 0) {
				console.log("[Letta Cache] No messages found for agent");
				return [];
			}

			// Transform messages
			const messages = response.map((msg: any) => this.transformMessage(msg));

			// Sort by created_at ascending (oldest first)
			messages.sort((a, b) => a.created_at - b.created_at);

			// Create new cache
			const cache: MessageCache = {
				agentId,
				messages,
				lastMessageId: messages[messages.length - 1]?.id || null,
				oldestMessageId: messages[0]?.id || null,
				lastSyncTimestamp: Date.now(),
				hasMoreOlder: response.length === pageSize
			};

			await this.saveCache(agentId, cache);
			console.log(`[Letta Cache] Full sync complete: ${messages.length} messages cached`);

			return messages;
		} catch (error) {
			console.error("[Letta Cache] Error during full sync:", error);
			return [];
		}
	}

	// Load older messages (pagination - for "Load More" button)
	async loadOlderMessages(agentId: string, limit?: number): Promise<CachedMessage[]> {
		const cache = this.getCache(agentId);
		const pageSize = limit || this.plugin.settings.historyPageSize || 50;

		if (!cache?.oldestMessageId || !cache.hasMoreOlder) {
			console.log("[Letta Cache] No more older messages to load");
			return [];
		}

		try {
			const endpoint = `/v1/agents/${agentId}/messages?before=${cache.oldestMessageId}&limit=${pageSize}`;
			const response = await this.plugin.makeRequest(endpoint);

			if (!response || !Array.isArray(response) || response.length === 0) {
				cache.hasMoreOlder = false;
				await this.saveCache(agentId, cache);
				return [];
			}

			const olderMessages = response.map((msg: any) => this.transformMessage(msg));

			// Sort ascending
			olderMessages.sort((a, b) => a.created_at - b.created_at);

			// Prepend to cache
			cache.messages = [...olderMessages, ...cache.messages];
			cache.oldestMessageId = olderMessages[0]?.id || cache.oldestMessageId;
			cache.hasMoreOlder = response.length === pageSize;

			await this.saveCache(agentId, cache);
			console.log(`[Letta Cache] Loaded ${olderMessages.length} older messages`);

			return olderMessages;
		} catch (error) {
			console.error("[Letta Cache] Error loading older messages:", error);
			return [];
		}
	}

	// Smart load - uses cache when available, fetches only what's needed
	async smartLoad(agentId: string, forceRefresh: boolean = false): Promise<CachedMessage[]> {
		if (!this.plugin.settings.enableMessageCache) {
			// Caching disabled - do full fetch
			return this.fullSync(agentId);
		}

		const cache = this.getCache(agentId);

		// No cache or force refresh - do full sync
		if (!cache || forceRefresh || cache.messages.length === 0) {
			console.log("[Letta Cache] Cache miss - performing full sync");
			return this.fullSync(agentId);
		}

		// Cache exists - fetch only new messages
		console.log(`[Letta Cache] Cache hit - ${cache.messages.length} messages, checking for new...`);
		const newMessages = await this.fetchNewMessages(agentId);

		if (newMessages.length > 0) {
			// Sort new messages and append
			newMessages.sort((a, b) => a.created_at - b.created_at);
			cache.messages = [...cache.messages, ...newMessages];
			cache.lastMessageId = newMessages[newMessages.length - 1].id;
			cache.lastSyncTimestamp = Date.now();
			await this.saveCache(agentId, cache);
		}

		return cache.messages;
	}

	// Add a sent/received message to cache
	async addMessage(agentId: string, message: any): Promise<void> {
		if (!this.plugin.settings.enableMessageCache) return;

		const cache = this.getCache(agentId);
		if (!cache) return;

		const cachedMsg = this.transformMessage(message);
		cache.messages.push(cachedMsg);
		cache.lastMessageId = cachedMsg.id;
		cache.lastSyncTimestamp = Date.now();

		await this.saveCache(agentId, cache);
	}

	// Clear cache for specific agent
	async clearCache(agentId: string): Promise<void> {
		if (this.plugin.settings.messageCache?.[agentId]) {
			delete this.plugin.settings.messageCache[agentId];
			await this.plugin.saveSettings();
			console.log(`[Letta Cache] Cleared cache for agent ${agentId}`);
		}
	}

	// Clear all caches
	async clearAllCaches(): Promise<void> {
		this.plugin.settings.messageCache = {};
		await this.plugin.saveSettings();
		console.log("[Letta Cache] Cleared all message caches");
	}
}

export default class LettaPlugin extends Plugin {
	settings: LettaPluginSettings;
	agent: LettaAgent | null = null;
	statusBarItem: HTMLElement | null = null;
	client: LettaClient | null = null;
	bridge: LettaCodeBridge | null = null; // Letta Code integration (active bridge)
	bridges: Map<string, LettaCodeBridge> = new Map(); // Map of agent ID -> bridge for multi-agent
	bridgeTools: BridgeToolRegistry | null = null; // Tool registry for bridge mode
	lastAuthError: string | null = null;
	focusBlockId: string | null = null;
	focusUpdateTimer: NodeJS.Timeout | null = null;
	lastFocusedFile: TFile | null = null;
	isConnecting: boolean = false;
	// RAINMAKER FIX: Connection promise for race condition prevention
	private connectionPromise: Promise<boolean> | null = null;
	// Track vault tools registration status
	vaultToolsRegistered: boolean = false;
	// Message cache manager for fast conversation loading
	cacheManager: MessageCacheManager;

	async onload() {
		await this.loadSettings();

		// Initialize cache manager
		this.cacheManager = new MessageCacheManager(this);

		// Patch global fetch to use Obsidian's requestUrl for Letta API calls (bypasses CORS)
		this.patchGlobalFetch();

		// Reset session-based approvals on plugin load
		this.resetSessionApprovals();

		// Register the chat view
		this.registerView(
			LETTA_CHAT_VIEW_TYPE,
			(leaf) => new LettaChatView(leaf, this),
		);

		this.registerView(
			LETTA_MEMORY_VIEW_TYPE,
			(leaf) => new LettaMemoryView(leaf, this),
		);

		// Add ribbon icons
		this.addRibbonIcon("bot", "Open Rainmaker Chat", (evt: MouseEvent) => {
			this.openChatView();
		});

		this.addRibbonIcon(
			"brain-circuit",
			"Open Rainmaker Memory Blocks",
			(evt: MouseEvent) => {
				this.openMemoryView();
			},
		);

		// Add status bar
		this.statusBarItem = this.addStatusBarItem();
		this.updateStatusBar("Disconnected");

		// Add commands
		this.addCommand({
			id: "open-letta-chat",
			name: "Open Chat",
			callback: () => {
				this.openChatView();
			},
		});

		this.addCommand({
			id: "open-letta-memory",
			name: "Open Memory Blocks",
			callback: () => {
				this.openMemoryView();
			},
		});



		this.addCommand({
			id: "open-block-folder",
			name: "Open Memory Blocks Folder",
			callback: async () => {
				const folder = this.app.vault.getAbstractFileByPath(
					"Letta Memory Blocks",
				);
				if (folder && folder instanceof TFolder) {
					// Focus the file explorer and reveal the folder
					this.app.workspace.leftSplit.expand();
					new Notice(
						"📁 Memory Blocks folder is now visible in the file explorer",
					);
				} else {
					new Notice(
						'Memory Blocks folder not found. Use "Open Memory Block Files" to create it.',
					);
				}
			},
		});

		this.addCommand({
			id: "connect-to-letta",
			name: "Connect",
			callback: async () => {
				if (this.agent) {
					new Notice("Already connected");
					return;
				}
				await this.connectToLetta();
			},
		});

		this.addCommand({
			id: "disconnect-from-letta",
			name: "Disconnect",
			callback: () => {
				this.agent = null;
				this.updateStatusBar("Disconnected");
				new Notice("Disconnected");
			},
		});

		this.addCommand({
			id: "letta-list-agent-tools",
			name: "List Agent Tools",
			callback: async () => {
				if (!this.client || !this.agent) {
					new Notice("No agent connected");
					return;
				}
				try {
					const agentDetails = await this.client.agents.retrieve(this.agent.id);
					const tools = agentDetails.tools || [];
					console.log("[Letta Plugin] Agent tools:", tools);
					const toolNames = tools.map((t: any) => typeof t === 'string' ? t : t.name).join(', ');
					new Notice(`Agent has ${tools.length} tools: ${toolNames}`);
				} catch (e) {
					console.error("[Letta Plugin] Failed to list tools:", e);
					new Notice("Failed to list tools - check console");
				}
			},
		});

		// Add settings tab
		this.addSettingTab(new LettaSettingTab(this.app, this));

		// Auto-connect on startup if configured (non-blocking)
		if (this.settings.lettaApiKey && this.settings.autoConnect) {
			this.connectToLetta().catch((error) => {
				console.error(
					"[Letta Plugin] Background connection failed:",
					error,
				);
				// Don't show notices for background connection failures during startup
			});
		}

		// Track active file changes for focus mode
		this.registerEvent(
			this.app.workspace.on("layout-change", () => {
				if (this.settings.focusMode && this.agent) {
					const activeFile = this.app.workspace.getActiveFile();
					if (activeFile !== this.lastFocusedFile) {
						this.lastFocusedFile = activeFile;
						this.scheduleFocusUpdate();
					}
				}
			}),
		);

	}

	async onunload() {
		if (this.focusUpdateTimer) {
			clearTimeout(this.focusUpdateTimer);
		}
		
		// Clean up all Letta Code bridges
		for (const [agentId, bridge] of this.bridges.entries()) {
			console.log(`[Letta Plugin] Stopping bridge for agent ${agentId}`);
			await bridge.stop();
		}
		this.bridges.clear();
		this.bridge = null;
		
		this.agent = null;

		// Restore original fetch when plugin unloads
		(window as any).fetch = originalFetch;
		console.log("[Letta Plugin] Restored original fetch");
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData(),
		);
		this.initializeClient();
	}

	async saveSettings() {
		await this.saveData(this.settings);
		this.initializeClient();
	}

	// Track recently used agents for quick switching
	async trackRecentAgent(agent: LettaAgent, projectSlug?: string): Promise<void> {
		const recent: RecentAgent = {
			id: agent.id,
			name: agent.name,
			projectSlug: projectSlug || this.settings.lettaProjectSlug,
			lastUsed: Date.now(),
		};

		// Remove if already in list
		this.settings.recentAgents = this.settings.recentAgents.filter(
			(a) => a.id !== agent.id
		);

		// Add to front, limit to 5
		this.settings.recentAgents.unshift(recent);
		this.settings.recentAgents = this.settings.recentAgents.slice(0, 5);

		await this.saveSettings();
	}

	// Reset session-based approvals (call on plugin load)
	resetSessionApprovals(): void {
		this.settings.vaultToolsApprovedThisSession = false;
	}

	// Check if a folder path is blocked
	isFolderBlocked(folderPath: string): boolean {
		// Always block hidden folders (starting with .)
		if (folderPath.startsWith(".") || folderPath.includes("/.")) {
			return true;
		}
		// Check against blocked folders list
		return this.settings.blockedFolders.some(
			(blocked) => folderPath === blocked || folderPath.startsWith(blocked + "/")
		);
	}

	// Patch global fetch to use Obsidian's requestUrl for Letta API calls
	// This is necessary because the LettaClient uses fetch internally,
	// and CORS blocks requests from app://obsidian.md to api.letta.com
	private patchGlobalFetch() {
		if (this.settings.lettaBaseUrl) {
			console.log("[Letta Plugin] Patching global fetch for CORS bypass");
			(window as any).fetch = createObsidianFetch(this.settings.lettaBaseUrl);
		}
	}

	private initializeClient() {
		try {
			// Only initialize if we have a base URL
			if (!this.settings.lettaBaseUrl) {
				this.client = null;
				return;
			}

			// Re-patch fetch in case base URL changed
			this.patchGlobalFetch();

			// Initialize with token and base URL from settings
			const config: any = {
				baseUrl: this.settings.lettaBaseUrl,
			};

			// Only add token if API key is provided (for self-hosted without auth)
			if (this.settings.lettaApiKey) {
				config.token = this.settings.lettaApiKey;
			}

			this.client = new LettaClient(config);
		} catch (error) {
			console.error("[Letta Plugin] Failed to initialize client:", error);
			this.client = null;
		}
	}

	// Get detailed connection status text
	getConnectionStatusText(): string {
		const isCloudInstance =
			this.settings.lettaBaseUrl.includes("api.letta.com");

		if (isCloudInstance) {
			const projectInfo = this.settings.lettaProjectSlug
				? ` • ${this.settings.lettaProjectSlug}`
				: "";
			return `Connected to Letta Cloud${projectInfo}`;
		} else {
			// Show base URL for local/custom instances
			return `Connected to ${this.settings.lettaBaseUrl}`;
		}
	}

	updateStatusBar(status: string) {
		if (this.statusBarItem) {
			// Only show sync-related status, hide connection details
			if (status === "Connected") {
				this.statusBarItem.setText("");
			} else {
				this.statusBarItem.setText(status);
			}
		}

		// Also update chat status if chat view is open
		const chatLeaf =
			this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE)[0];
		if (chatLeaf && chatLeaf.view instanceof LettaChatView) {
			// Don't await since updateStatusBar should be non-blocking
			(chatLeaf.view as LettaChatView).updateChatStatus();
		}
	}

	async makeRequest(path: string, options: any = {}): Promise<any> {
		return this.makeRequestWithRetry(path, options, 3);
	}

	async makeRequestWithRetry(
		path: string,
		options: any = {},
		maxRetries: number = 3,
	): Promise<any> {
		let lastError: any;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			try {
				return await this.executeSingleRequest(path, options);
			} catch (error: any) {
				lastError = error;

				// Only retry on rate limiting errors
				if (error.isRateLimit && attempt < maxRetries) {
					const waitTime = error.retryAfter
						? error.retryAfter * 1000
						: Math.pow(2, attempt) * 1000; // Exponential backoff
					// console.log(`[Letta Plugin] Rate limited, waiting ${waitTime}ms before retry ${attempt + 1}/${maxRetries}`);
					await new Promise((resolve) =>
						setTimeout(resolve, waitTime),
					);
					continue;
				}

				// For non-rate-limit errors or final attempt, throw immediately
				throw error;
			}
		}

		throw lastError;
	}

	async executeSingleRequest(path: string, options: any = {}): Promise<any> {
		const url = `${this.settings.lettaBaseUrl}${path}`;
		const headers: any = {
			...options.headers,
		};

		// Only add Authorization header if API key is provided
		if (this.settings.lettaApiKey) {
			headers["Authorization"] = `Bearer ${this.settings.lettaApiKey}`;
		}

		// Set content type unless it's a file upload
		if (!options.isFileUpload) {
			headers["Content-Type"] = "application/json";
		}

		// Debug logging
		// console.log(`[Letta Plugin] Making request to ${url}`);
		// console.log(`[Letta Plugin] Request headers:`, headers);
		// console.log(`[Letta Plugin] Request options:`, options);

		try {
			let requestBody;
			if (
				options.body &&
				typeof options.body === "string" &&
				headers["Content-Type"]?.includes("multipart/form-data")
			) {
				// Manual multipart form data
				requestBody = options.body;
			} else if (options.isFileUpload && options.formData) {
				requestBody = options.formData;
				// Remove Content-Type header to let browser set boundary
				delete headers["Content-Type"];
			} else if (options.body) {
				requestBody = JSON.stringify(options.body);
			}

			const response = await requestUrl({
				url,
				method: options.method || "GET",
				headers,
				body: requestBody,
				throw: false,
			});

			// Debug logging for response
			// Response details available for debugging if needed

			// Try to parse JSON, but handle cases where response isn't JSON
			let responseJson = null;
			try {
				if (
					response.text &&
					(response.text.trim().startsWith("{") ||
						response.text.trim().startsWith("[") ||
						response.text.trim().startsWith('"'))
				) {
					responseJson = JSON.parse(response.text);
					// console.log(`[Letta Plugin] Parsed JSON response:`, responseJson);
				} else {
					// console.log(`[Letta Plugin] Response is not JSON, raw text:`, response.text);
				}
			} catch (jsonError) {
				// Failed to parse JSON - continuing with text response
			}

			if (response.status >= 400) {
				let errorMessage = `HTTP ${response.status}: ${response.text}`;

				// Error details available for debugging if needed

				if (response.status === 404) {
					if (path === "/v1/agents") {
						errorMessage =
							"Cannot connect to Letta API. Please verify:\n• Base URL is correct\n• Letta service is running\n• Network connectivity is available";
					} else if (path.includes("/v1/folders")) {
						errorMessage =
							"Source not found. This may indicate:\n• Invalid project configuration\n• Missing permissions\n• Source was deleted externally";
					} else if (
						path === "/v1/agents" &&
						options.method === "POST"
					) {
						errorMessage =
							"Failed to create agent. This may indicate:\n• Invalid project ID\n• Missing permissions\n• API endpoint has changed\n• Server configuration issue";
					} else if (path.includes("/v1/agents")) {
						errorMessage =
							"Agent not found. This may indicate:\n• Invalid project configuration\n• Missing permissions\n• Agent was deleted externally";
					} else {
						errorMessage = `Endpoint not found (${path}). This may indicate:\n• Incorrect base URL configuration\n• Outdated plugin version\n• API endpoint has changed`;
					}
				} else if (response.status === 401) {
					const isCloudInstance =
						this.settings.lettaBaseUrl.includes("api.letta.com");
					if (isCloudInstance && !this.settings.lettaApiKey) {
						errorMessage =
							"Authentication required for Letta Cloud. Please provide an API key in settings.";
					} else if (!this.settings.lettaApiKey) {
						errorMessage =
							"Authentication failed. If using a self-hosted instance with auth enabled, please provide an API key in settings.";
					} else {
						errorMessage =
							"Authentication failed. Please verify your API key is correct and has proper permissions.";
					}
				} else if (response.status === 405) {
					errorMessage = `Method not allowed for ${path}. This may indicate:\n• Incorrect HTTP method\n• API endpoint has changed\n• Feature not supported in this Letta version`;
				} else if (response.status === 429) {
					// Handle rate limiting with retry logic
					const retryAfter =
						response.headers?.["retry-after"] ||
						response.headers?.["Retry-After"];
					const rateLimitReset =
						response.headers?.["x-ratelimit-reset"] ||
						response.headers?.["X-RateLimit-Reset"];

					// Create detailed error message
					errorMessage = `Rate limit exceeded. ${responseJson?.detail || response.text || "Please wait before making more requests."}`;

					if (retryAfter) {
						errorMessage += `\nRetry after: ${retryAfter} seconds`;
					}
					if (rateLimitReset) {
						try {
							const resetTime = new Date(
								parseInt(rateLimitReset) * 1000,
							);
							errorMessage += `\nRate limit resets at: ${resetTime.toLocaleTimeString()}`;
						} catch {
							errorMessage += `\nRate limit reset: ${rateLimitReset}`;
						}
					}

					// Create a special error type for rate limiting
					const rateLimitError = new Error(
						errorMessage,
					) as RateLimitError;
					rateLimitError.isRateLimit = true;
					rateLimitError.retryAfter = retryAfter
						? parseInt(retryAfter)
						: null;
					throw rateLimitError;
				}

				// Enhanced error message created with preserved response details
				const enhancedError = new Error(errorMessage) as EnhancedError;
				enhancedError.status = response.status;
				enhancedError.responseText = response.text;
				enhancedError.responseJson = responseJson;
				throw enhancedError;
			}

			return responseJson;
		} catch (error: any) {
			// Exception details available for debugging if needed
			console.error("[Letta Plugin] Letta API request failed:", {
				error: error.message,
				status: error.status,
				responseText: error.responseText,
				responseJson: error.responseJson,
				path,
				method: options.method || "GET",
				stack: error.stack,
			});

			// Check if this is a network/connection error that might indicate the same issues as a 404
			if (
				error.message &&
				(error.message.includes("fetch") ||
					error.message.includes("network") ||
					error.message.includes("ECONNREFUSED"))
			) {
				if (path === "/v1/agents") {
					const enhancedError = new Error(
						"Cannot connect to Letta API. Please verify:\n• Base URL is correct\n• Letta service is running\n• Network connectivity is available",
					);
					throw enhancedError;
				}
			}

			throw error;
		}
	}

	async getAgentCount(): Promise<number> {
		try {
			if (!this.client) return 0;
			// Get all agents across all projects (not filtered by current project)
			const agents = await this.client.agents.list();
			return agents ? agents.length : 0;
		} catch (error) {
			console.error("[Letta Plugin] Failed to get agent count:", error);
			return 0;
		}
	}

	async connectToLetta(attempt: number = 1, progressCallback?: (message: string) => void): Promise<boolean> {
		// RAINMAKER FIX: Prevent concurrent connection attempts
		if (attempt === 1 && this.connectionPromise) {
			console.log("[Letta Plugin] Connection already in progress, reusing existing promise");
			return this.connectionPromise;
		}

		const maxAttempts = 5;
		const isCloudInstance =
			this.settings.lettaBaseUrl.includes("api.letta.com");

		// Set connecting flag and promise on first attempt
		if (attempt === 1) {
			this.isConnecting = true;
			// Store the connection promise to prevent race conditions
			this.connectionPromise = this._executeConnection(attempt, maxAttempts, isCloudInstance, progressCallback);
			return this.connectionPromise;
		}

		// For retry attempts, execute directly
		return this._executeConnection(attempt, maxAttempts, isCloudInstance, progressCallback);
	}

	// RAINMAKER FIX: Extracted connection logic to separate method
	private async _executeConnection(
		attempt: number,
		maxAttempts: number,
		isCloudInstance: boolean,
		progressCallback?: (message: string) => void
	): Promise<boolean> {
		try {
			return await this._doConnect(attempt, maxAttempts, isCloudInstance, progressCallback);
		} finally {
			// Clear connection promise when done (success or failure)
			if (attempt === 1) {
				this.connectionPromise = null;
			}
		}
	}

	// RAINMAKER FIX: Actual connection implementation
	private async _doConnect(
		attempt: number,
		maxAttempts: number,
		isCloudInstance: boolean,
		progressCallback?: (message: string) => void
	): Promise<boolean> {

		console.log(`[Letta Plugin] connectToLetta called - attempt ${attempt}/${maxAttempts}`);
		console.log(`[Letta Plugin] Connection details:`, {
			baseUrl: this.settings.lettaBaseUrl,
			engineMode: this.settings.engineMode,
			isCloudInstance,
			hasApiKey: !!this.settings.lettaApiKey,
			hasClient: !!this.client,
			hasBridge: !!this.bridge,
			currentAgent: this.agent
		});

		// Handle local mode (Letta Code)
		if (this.settings.engineMode === 'local') {
			return this._connectLocal(attempt, maxAttempts, progressCallback);
		}

		// Connection attempt ${attempt}/${maxAttempts} to ${this.settings.lettaBaseUrl}

		// Validate URL format on first attempt
		if (attempt === 1) {
			try {
				new URL(this.settings.lettaBaseUrl);
			} catch (e) {
				new Notice(
					`Invalid Base URL format: ${this.settings.lettaBaseUrl}. Please check your settings.`,
				);
				this.updateStatusBar("Invalid URL");
				this.isConnecting = false;
				return false;
			}

			// Check for common typos
			if (this.settings.lettaBaseUrl.includes("locahost")) {
				new Notice(
					`Potential typo in Base URL: Did you mean "localhost"? Current: ${this.settings.lettaBaseUrl}`,
				);
				this.updateStatusBar("URL typo detected");
				this.isConnecting = false;
				return false;
			}
		}

		if (isCloudInstance && !this.settings.lettaApiKey) {
			new Notice(
				"API key required for Letta Cloud. Please configure it in settings.",
			);
			this.isConnecting = false;
			return false;
		}

		try {
			const progressMessage = attempt === 1
				? "Connecting to server..."
				: `Retrying connection... (${attempt}/${maxAttempts})`;
			
			this.updateStatusBar(progressMessage);
			progressCallback?.(progressMessage);

			// Test connection by trying to list agents (this endpoint should exist)
			// Use makeRequest instead of client.agents.list() to avoid CORS issues
			// (makeRequest uses Obsidian's requestUrl which bypasses CORS)
			console.log("[Letta Plugin] Testing connection by listing agents...");
			await this.makeRequest("/v1/agents/");
			console.log("[Letta Plugin] Connection test successful");

			// Try to setup agent if one is configured
			if (this.settings.agentId) {
				try {
					progressCallback?.("Loading agent configuration...");
					await this.setupAgent();

					// Setup focus block after agent is ready
					if (this.agent) {
						await this.ensureFocusBlock();
					}
				} catch (agentError) {
					console.error(
						"[Letta Plugin] Agent setup failed:",
						agentError,
					);
					// Clear invalid agent ID
					this.settings.agentId = "";
					this.settings.agentName = "";
					await this.saveSettings();
				}
			}

			this.updateStatusBar("Connected");
			progressCallback?.("Connection successful!");

			// Clear any previous auth errors on successful connection
			this.lastAuthError = null;

			// Only show success notice on first attempt or after retries
			if (attempt === 1) {
				new Notice("Successfully connected to Letta");
			} else {
				new Notice(`Connected to Letta after ${attempt} attempts`);
			}

			console.log("[Letta Plugin] connectToLetta completed successfully");
			console.log("[Letta Plugin] Final state:", {
				hasAgent: !!this.agent,
				agentId: this.agent?.id,
				agentName: this.agent?.name
			});

			// Ensure chat view UI is updated after connection, regardless of agent state
			this.updateStatusBar("Connected");
			this.isConnecting = false;
			const chatLeaf = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE)[0];
			if (chatLeaf && chatLeaf.view instanceof LettaChatView) {
				console.log("[Letta Plugin] Forcing chat status update after connection");
				(chatLeaf.view as LettaChatView).updateChatStatus();
			}

			return true;
		} catch (error: any) {
			console.error(
				`[Letta Plugin] Connection attempt ${attempt} failed:`,
				error,
			);
			console.error("[Letta Plugin] Error details:", {
				message: error.message,
				stack: error.stack,
				name: error.name,
			});

			// Clear client on authentication failures to ensure proper UI state
			if (error.message.includes("401") || error.message.includes("Unauthorized")) {
				console.log("[Letta Plugin] Authentication failed - clearing client");
				this.client = null;
				this.agent = null;
				this.lastAuthError = "Authentication failed. Please check your API key and base URL in the plugin settings.";

				// Show immediate notice for auth failures on first attempt
				if (attempt === 1) {
					new Notice("Authentication failed. Please check your API key in plugin settings.");
				}

				// Don't retry authentication errors - return failure immediately
				const failureMessage = "Authentication failed";
				this.updateStatusBar(failureMessage);
				progressCallback?.(failureMessage);
				this.isConnecting = false;
				return false;
			} else {
				// Clear auth error for other types of errors
				this.lastAuthError = null;
			}

			// Provide specific error messages based on error type
			if (error.message.includes("ERR_NAME_NOT_RESOLVED")) {
				if (attempt === 1) {
					new Notice(
						`Cannot resolve hostname. Please check your Base URL: ${this.settings.lettaBaseUrl}`,
					);
				}
			} else if (
				error.message.includes("ECONNREFUSED") ||
				error.message.includes("ERR_CONNECTION_REFUSED")
			) {
				if (attempt === 1) {
					new Notice(
						`Connection refused. Is your Letta server running on ${this.settings.lettaBaseUrl}?`,
					);
				}
			} else if (error.message.includes("ENOTFOUND")) {
				if (attempt === 1) {
					new Notice(
						`Host not found. Please verify the URL spelling: ${this.settings.lettaBaseUrl}`,
					);
				}
			}

			// If we haven't reached max attempts, try again with backoff
			if (attempt < maxAttempts) {
				const backoffMs = Math.min(
					1000 * Math.pow(2, attempt - 1),
					10000,
				); // Cap at 10 seconds

				// Update status to show retry countdown
				const retryMessage = `Retry in ${Math.ceil(backoffMs / 1000)}s...`;
				this.updateStatusBar(retryMessage);
				progressCallback?.(retryMessage);

				// Wait for backoff period
				await new Promise((resolve) => setTimeout(resolve, backoffMs));

				// Recursive retry
				return await this.connectToLetta(attempt + 1, progressCallback);
			} else {
				// All attempts failed
				const failureMessage = "Connection failed";
				this.updateStatusBar(failureMessage);
				progressCallback?.(failureMessage);
				this.isConnecting = false;
				new Notice(
					`Failed to connect to Letta after ${maxAttempts} attempts: ${error.message}`,
				);
				return false;
			}
		}
	}

	/**
	 * Connect to Letta Code (local mode)
	 */
	private async _connectLocal(
		attempt: number,
		maxAttempts: number,
		progressCallback?: (message: string) => void
	): Promise<boolean> {
		try {
			const progressMessage = attempt === 1
				? "Starting Letta Code..."
				: `Retrying Letta Code startup... (${attempt}/${maxAttempts})`;
			
			this.updateStatusBar(progressMessage);
			progressCallback?.(progressMessage);

			const agentId = this.settings.agentId || 'default-agent';

			// Check if bridge already exists for this agent
			let existingBridge = this.bridges.get(agentId);
			if (existingBridge && existingBridge.isConnected()) {
				console.log(`[Letta Plugin] Reusing existing bridge for agent ${agentId}`);
				this.bridge = existingBridge;
				this.updateStatusBar('Connected (Local)');
				this.isConnecting = false;
				return true;
			}

			// Stop existing bridge if any
			if (existingBridge) {
				await existingBridge.stop();
				this.bridges.delete(agentId);
			}

			// Create new bridge
			this.bridge = new LettaCodeBridge({
				workingDirectory: (this.app.vault.adapter as any).basePath || process.cwd(),
				debug: true,
				agentId: this.settings.agentId || undefined,
			});

			// Initialize tool registry
			this.bridgeTools = new BridgeToolRegistry({
				app: this.app,
				plugin: this,
			});

			// Setup event handlers
			this.bridge.on('message', async (message: LettaCodeMessage) => {
				console.log('[Letta Plugin] Received message from Letta Code:', message);
				
				// Handle tool calls
				if (message.message_type === 'function_call' && message.function_call) {
					await this.handleBridgeToolCall(message.function_call);
				}
				
				// Messages will be handled by the chat view via the callback
			});

			this.bridge.on('error', (error: Error) => {
				console.error('[Letta Plugin] Letta Code error:', error);
				new Notice(`Letta Code error: ${error.message}`);
			});

			this.bridge.on('ready', () => {
				console.log('[Letta Plugin] Letta Code bridge ready');
				new Notice('Connected to Letta Code');
			});

			this.bridge.on('closed', () => {
				console.log('[Letta Plugin] Letta Code bridge closed');
				this.updateStatusBar('Disconnected');
			});

			// Start the bridge
			await this.bridge.start(this.settings.agentId);

			// Store bridge in map
			this.bridges.set(agentId, this.bridge);

			// Update status
			this.updateStatusBar('Connected (Local)');
			this.isConnecting = false;

			// Set a mock agent for UI compatibility
			this.agent = {
				id: this.settings.agentId || 'local-agent',
				name: this.settings.agentName || 'Local Agent',
				created_at: Date.now(),
				llm_config: { model: 'local' },
				embedding_config: { embedding_model: 'local' },
			} as LettaAgent;

			console.log('[Letta Plugin] Successfully connected to Letta Code');
			return true;

		} catch (error: any) {
			console.error('[Letta Plugin] Failed to connect to Letta Code:', error);
			
			// Check if it's a "command not found" error
			if (error.message?.includes('ENOENT') || error.message?.includes('not found')) {
				new Notice(
					'Letta Code not found. Please install it: npm install -g @letta-ai/letta-code',
					10000
				);
				this.updateStatusBar('Letta Code not installed');
				this.isConnecting = false;
				return false;
			}

			// Retry logic
			if (attempt < maxAttempts) {
				const delay = 2000 * attempt;
				console.log(`[Letta Plugin] Retrying in ${delay}ms...`);
				await new Promise(resolve => setTimeout(resolve, delay));
				return this._connectLocal(attempt + 1, maxAttempts, progressCallback);
			}

			new Notice(`Failed to start Letta Code: ${error.message}`);
			this.updateStatusBar('Connection failed');
			this.isConnecting = false;
			return false;
		}
	}

	/**
	 * Handle tool call from Letta Code bridge
	 */
	private async handleBridgeToolCall(toolCall: { name: string; arguments: any }): Promise<void> {
		if (!this.bridgeTools) {
			console.error('[Letta Plugin] Tool registry not initialized');
			return;
		}

		console.log('[Letta Plugin] Handling tool call:', toolCall.name, toolCall.arguments);

		try {
			// Execute the tool
			const result = await this.bridgeTools.execute(toolCall.name, toolCall.arguments);

			// Send result back to Letta Code via bridge
			if (this.bridge && this.bridge.isConnected()) {
				await this.bridge.sendToolReturn(
					toolCall.name,
					result.success ? 'success' : 'error',
					result.success ? JSON.stringify(result.data) : (result.error || 'Unknown error')
				);
				console.log('[Letta Plugin] Tool result sent to bridge');
			}

		} catch (error: any) {
			console.error('[Letta Plugin] Tool execution error:', error);
			// Send error result back
			if (this.bridge && this.bridge.isConnected()) {
				await this.bridge.sendToolReturn(
					toolCall.name,
					'error',
					error.message || 'Tool execution failed'
				);
			}
		}
	}

	/**
	 * Switch to a different agent (local mode multi-agent support)
	 */
	async switchToAgent(agentId: string): Promise<boolean> {
		if (this.settings.engineMode !== 'local') {
			console.log('[Letta Plugin] Agent switching only available in local mode');
			return false;
		}

		// Check if bridge exists
		const existingBridge = this.bridges.get(agentId);
		if (existingBridge && existingBridge.isConnected()) {
			// Switch to existing bridge
			this.bridge = existingBridge;
			this.settings.agentId = agentId;
			await this.saveSettings();
			
			this.agent = {
				id: agentId,
				name: `Agent ${agentId}`,
				created_at: Date.now(),
				llm_config: { model: 'local' },
				embedding_config: { embedding_model: 'local' },
			} as LettaAgent;
			
			console.log(`[Letta Plugin] Switched to agent ${agentId}`);
			this.updateStatusBar(`Connected (Agent ${agentId})`);
			return true;
		} else {
			// Connect to new agent
			this.settings.agentId = agentId;
			await this.saveSettings();
			return await this.connectToLetta(1);
		}
	}

	/**
	 * Get list of active bridge connections
	 */
	getActiveBridges(): string[] {
		const active: string[] = [];
		for (const [agentId, bridge] of this.bridges.entries()) {
			if (bridge.isConnected()) {
				active.push(agentId);
			}
		}
		return active;
	}

	async setupAgent(): Promise<void> {

		// If no agent ID is configured, skip agent setup silently
		if (!this.settings.agentId) {
			// console.log('[Letta Plugin] No agent ID configured, skipping agent setup');
			return;
		}

		try {
			if (!this.client) throw new Error("Client not initialized");

			// Try to get the specific agent by ID
			const existingAgent = await this.client.agents.retrieve(
				this.settings.agentId,
			);

			if (existingAgent) {
				this.agent = { id: existingAgent.id, name: existingAgent.name };
				// Update agent name in settings in case it changed
				this.settings.agentName = existingAgent.name;
				await this.saveSettings();


				// Register vault tools after successful agent setup (if enabled)
				if (this.settings.enableVaultTools) {
					const toolsRegistered = await this.registerObsidianTools();
					this.vaultToolsRegistered = toolsRegistered;
					if (toolsRegistered) {
						console.log("[Letta Plugin] Vault tools registered successfully");
					} else {
						console.warn("[Letta Plugin] Vault tools registration failed or was skipped");
					}
				} else {
					this.vaultToolsRegistered = false;
					console.log("[Letta Plugin] Vault tools disabled in settings - skipping registration");
				}
				// Update any open chat views with vault tools status
				this.updateChatViewsVaultStatus();
			} else {
				// Agent with configured ID not found, clear the invalid ID
				console.log(
					`[Letta Plugin] Agent with ID ${this.settings.agentId} not found, clearing invalid ID`,
				);
				this.settings.agentId = "";
				this.settings.agentName = "";
				await this.saveSettings();
			}
		} catch (error) {
			console.error("Failed to setup agent:", error);
			// Clear invalid agent ID on error
			this.settings.agentId = "";
			this.settings.agentName = "";
			await this.saveSettings();
			// Don't throw error to prevent blocking startup
		}
	}

	// Helper to get short focus block label (must stay under 50 chars)
	getFocusBlockLabel(): string {
		if (!this.agent) return "focus-unknown";
		// Use last 12 chars of agent ID to stay under 50 char limit
		const shortId = this.agent.id.slice(-12);
		return `focus-${shortId}`;
	}

	// Focus Mode Methods
	async ensureFocusBlock(): Promise<void> {
		if (!this.agent || !this.client) return;

		const focusBlockLabel = this.getFocusBlockLabel();

		try {
			// Check if block exists
			const blocks = await this.client.blocks.list({ label: focusBlockLabel });

			if (blocks && blocks.length > 0) {
				// Block exists, store its ID
				this.focusBlockId = blocks[0].id || null;

				// Attach if focus mode is enabled
				if (this.settings.focusMode) {
					await this.attachFocusBlock();
				}
			} else {
				// Create the block
				const block = await this.client.blocks.create({
					label: focusBlockLabel,
					description: "The content of the Obsidian file that the user is currently viewing.",
					value: "The user is not currently viewing a note.",
					limit: this.settings.focusBlockCharLimit,
				});
				this.focusBlockId = block.id || null;

				// Attach if focus mode is enabled
				if (this.settings.focusMode) {
					await this.attachFocusBlock();
				}
			}

			// Update with current file if any
			if (this.settings.focusMode) {
				const activeFile = this.app.workspace.getActiveFile();
				if (activeFile) {
					await this.updateFocusBlock(activeFile);
				}
			}
		} catch (error) {
			console.error("[Letta Plugin] Failed to ensure focus block:", error);
		}
	}

	async attachFocusBlock(): Promise<void> {
		if (!this.agent || !this.client || !this.focusBlockId) return;

		try {
			await this.client.agents.blocks.attach(this.agent.id, this.focusBlockId);
			console.log("[Letta Plugin] Focus block attached successfully");
		} catch (error) {
			// Block might already be attached, that's okay
			console.log("[Letta Plugin] Focus block attach result:", error);
		}
	}

	async detachFocusBlock(): Promise<void> {
		if (!this.agent || !this.client || !this.focusBlockId) return;

		try {
			await this.client.agents.blocks.detach(this.agent.id, this.focusBlockId);
			console.log("[Letta Plugin] Focus block detached successfully");
		} catch (error) {
			console.error("[Letta Plugin] Failed to detach focus block:", error);
		}
	}

	async updateFocusBlock(file: TFile | null): Promise<void> {
		if (!this.agent || !this.client || !this.focusBlockId) return;

		try {
			let value: string;

			if (!file) {
				value = "The user is not currently viewing a note.";
			} else {
				const content = await this.app.vault.read(file);
				const title = file.basename;
				const path = file.path;

				// Extract metadata
				const metadata = this.extractNoteMetadata(file, content);
				
				// Build enhanced header with metadata
				let header = `NOTE TITLE: ${title}\nNOTE PATH: ${path}\n`;
				
				// Add file stats
				header += `CREATED: ${new Date(file.stat.ctime).toLocaleString()}\n`;
				header += `MODIFIED: ${new Date(file.stat.mtime).toLocaleString()}\n`;
				header += `SIZE: ${this.formatFileSize(file.stat.size)}\n`;
				
				// Add frontmatter properties if any
				if (metadata.frontmatter && Object.keys(metadata.frontmatter).length > 0) {
					header += `FRONTMATTER:\n`;
					for (const [key, value] of Object.entries(metadata.frontmatter)) {
						const valueStr = Array.isArray(value) ? value.join(', ') : String(value);
						header += `  ${key}: ${valueStr}\n`;
					}
				}
				
				// Add tags
				if (metadata.tags.length > 0) {
					header += `TAGS: ${metadata.tags.join(', ')}\n`;
				}
				
				// Add graph context
				const cache = this.app.metadataCache.getFileCache(file);
				const outlinks = cache?.links || [];
				const backlinksData = (this.app.metadataCache as any).getBacklinksForFile?.(file);
				const backlinksCount = backlinksData?.count?.() || 0;
				header += `BACKLINKS: ${backlinksCount} notes link to this\n`;
				header += `OUTLINKS: ${outlinks.length} links in this note\n`;
				
				// Add linked files (limit to 5 for brevity)
				if (outlinks.length > 0) {
					const linkedFiles = outlinks
						.map(link => link.link)
						.filter((link, index, self) => self.indexOf(link) === index)
						.slice(0, 5);
					header += `LINKED TO: ${linkedFiles.join(', ')}${outlinks.length > 5 ? ', ...' : ''}\n`;
				}
				
				// Add headings outline
				if (metadata.headings.length > 0) {
					header += `HEADINGS: ${metadata.headings.join(', ')}\n`;
				}
				
				header += `\nCONTENT:\n`;

				// Format the full content with enhanced metadata
				const formattedContent = header + content;

				// Check size limit
				if (formattedContent.length > this.settings.focusBlockCharLimit) {
					const availableSpace = this.settings.focusBlockCharLimit - header.length - 50;
					const truncatedContent = content.substring(0, availableSpace) + "\n\n[Note truncated - exceeds character limit]";
					value = header + truncatedContent;

					this.showSizeLimitWarning(file, content.length);
				} else {
					value = formattedContent;
				}
			}

			const focusBlockLabel = this.getFocusBlockLabel();
			await this.client.agents.blocks.modify(this.agent.id, focusBlockLabel, {
				value: value,
				limit: this.settings.focusBlockCharLimit,
			});

			console.log("[Letta Plugin] Focus block updated");
			
			this.refreshFocusIndicator();
		} catch (error) {
			console.error("[Letta Plugin] Failed to update focus block:", error);
		}
	}

	extractNoteMetadata(file: TFile, content: string): {
		frontmatter: Record<string, any>;
		tags: string[];
		headings: string[];
	} {
		const cache = this.app.metadataCache.getFileCache(file);
		
		const frontmatter: Record<string, any> = {};
		if (cache?.frontmatter) {
			for (const [key, value] of Object.entries(cache.frontmatter)) {
				if (key !== 'position') {
					frontmatter[key] = value;
				}
			}
		}
		
		const tags = new Set<string>();
		if (cache?.frontmatter?.tags) {
			const fmTags = Array.isArray(cache.frontmatter.tags) 
				? cache.frontmatter.tags 
				: [cache.frontmatter.tags];
			fmTags.forEach(tag => tags.add(String(tag)));
		}
		if (cache?.tags) {
			cache.tags.forEach(tagCache => tags.add(tagCache.tag));
		}
		
		const headings: string[] = [];
		if (cache?.headings) {
			headings.push(...cache.headings.map(h => h.heading));
		}
		
		return {
			frontmatter,
			tags: Array.from(tags),
			headings
		};
	}

	formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	refreshFocusIndicator(): void {
		const leaves = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);
		leaves.forEach(leaf => {
			const view = leaf.view as LettaChatView;
			if (view && view.updateFocusIndicator) {
				view.updateFocusIndicator();
			}
		});
	}

	scheduleFocusUpdate(): void {
		// Clear existing timer
		if (this.focusUpdateTimer) {
			clearTimeout(this.focusUpdateTimer);
		}

		// Schedule update in 5 seconds
		this.focusUpdateTimer = setTimeout(() => {
			this.updateFocusBlock(this.lastFocusedFile);
		}, 5000);
	}

	showSizeLimitWarning(file: TFile, actualSize: number): void {
		// Find open chat views and show warning
		const leaves = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);
		leaves.forEach(leaf => {
			const view = leaf.view as LettaChatView;
			if (view && view.showSizeLimitWarning) {
				view.showSizeLimitWarning(file, actualSize, this.settings.focusBlockCharLimit);
			}
		});
	}

	async openChatView(): Promise<void> {
		// console.log('[LETTA DEBUG] openChatView called');

		// Auto-connect if not connected to server
		if (!this.agent) {
			// console.log('[LETTA DEBUG] openChatView - connecting to Letta');
			new Notice("Connecting to agents...");
			const connected = await this.connectToLetta();
			if (!connected) {
				// console.log('[LETTA DEBUG] openChatView - failed to connect');
				return;
			}
		}

		const { workspace } = this.app;

		// Store the currently active file before opening chat
		const activeFileBeforeChat = workspace.getActiveFile();
		// console.log('[LETTA DEBUG] openChatView - activeFileBeforeChat:', activeFileBeforeChat?.path || 'null');

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			// console.log('[LETTA DEBUG] openChatView - using existing leaf');
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			// console.log('[LETTA DEBUG] openChatView - creating new leaf');
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: LETTA_CHAT_VIEW_TYPE,
					active: true,
				});
			}
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) {
			// console.log('[LETTA DEBUG] openChatView - revealing leaf');
			workspace.revealLeaf(leaf);
		}

	}

	// Update all open chat views with vault tools status
	updateChatViewsVaultStatus(): void {
		const leaves = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);
		for (const leaf of leaves) {
			const view = leaf.view as LettaChatView;
			if (view && view.updateVaultToolsIndicator) {
				view.updateVaultToolsIndicator();
			}
		}
	}

	async openMemoryView(): Promise<void> {
		// Auto-connect if not connected to server
		if (!this.agent) {
			new Notice("Connecting to agents...");
			const connected = await this.connectToLetta();
			if (!connected) {
				return;
			}
		}

		const { workspace } = this.app;

		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(LETTA_MEMORY_VIEW_TYPE);

		if (leaves.length > 0) {
			// A leaf with our view already exists, use that
			leaf = leaves[0];
		} else {
			// Our view could not be found in the workspace, create a new leaf
			// in the right sidebar for it
			leaf = workspace.getRightLeaf(false);
			if (leaf) {
				await leaf.setViewState({
					type: LETTA_MEMORY_VIEW_TYPE,
					active: true,
				});
			}
		}

		// "Reveal" the leaf in case it is in a collapsed sidebar
		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async sendMessageToAgent(
		message: string,
		images?: Array<{ base64: string; mediaType: string }>,
	): Promise<LettaMessage[]> {
		if (!this.agent) throw new Error("Agent not connected");
		if (!this.client) throw new Error("Client not initialized");

		console.log(
			"[Letta NonStream] Sending message to agent:",
			this.agent.id,
		);

		// Build content - use array format if images are present
		let content: any;
		if (images && images.length > 0) {
			content = [
				{ type: "text", text: `[Message from Obsidian chat interface]\n\n${message}` },
			];
			for (const img of images) {
				content.push({
					type: "image",
					source: {
						type: "base64",
						media_type: img.mediaType,
						data: img.base64,
					},
				});
			}
			console.log(`[Letta NonStream] Sending message with ${images.length} image(s)`);
		} else {
			content = `[Message from Obsidian chat interface]\n\n${message}`;
		}

		const response = await this.client.agents.messages.create(
			this.agent.id,
			{
				messages: [
					{
						role: "user",
						content,
					},
				],
			},
		);

		console.log("[Letta NonStream] Response received:", response);
		console.log("[Letta NonStream] Messages:", response.messages);
		return (response.messages || []) as any;
	}

	async sendMessageToAgentStream(
		message: string,
		images: Array<{ base64: string; mediaType: string }> | undefined,
		onMessage: (message: any) => void,
		onError: (error: Error) => void,
		onComplete: () => void,
		abortSignal?: AbortSignal,
	): Promise<void> {
		if (!this.agent) throw new Error("Agent not connected");
		
		// Route to bridge if in local mode
		if (this.settings.engineMode === 'local' && this.bridge) {
			return this.sendMessageToBridge(message, images, onMessage, onError, onComplete, abortSignal);
		}
		
		if (!this.client) throw new Error("Client not initialized");

		// Check if already aborted before starting
		if (abortSignal?.aborted) {
			console.log("[Letta Stream] Request aborted before starting");
			return;
		}

		// Retry configuration
		const maxRetries = 3;
		const backoffDelays = [1000, 2000, 4000]; // ms
		let lastError: Error | null = null;

		// Emit retry status via onMessage for UI updates
		const emitRetryStatus = (attempt: number, delay: number) => {
			onMessage({
				message_type: 'system_status',
				status: 'reconnecting',
				attempt,
				maxRetries,
				nextRetryMs: delay,
			});
		};

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			// Check if aborted before each attempt
			if (abortSignal?.aborted) {
				console.log("[Letta Stream] Request aborted during retry loop");
				return;
			}

			if (attempt > 0) {
				const delay = backoffDelays[attempt - 1] || backoffDelays[backoffDelays.length - 1];
				console.log(`[Letta Stream] Retry attempt ${attempt}/${maxRetries} after ${delay}ms`);
				emitRetryStatus(attempt, delay);
				await new Promise(resolve => setTimeout(resolve, delay));

				// Check again after delay
				if (abortSignal?.aborted) {
					console.log("[Letta Stream] Request aborted during retry delay");
					return;
				}
			}

			try {
				await this.executeStreamingRequest(message, images, onMessage, onComplete, abortSignal);
				return; // Success, exit retry loop
			} catch (error: any) {
				lastError = error;

				// Don't retry on abort errors
				if (error.name === 'AbortError' || abortSignal?.aborted) {
					onComplete();
					return;
				}

				// Only retry on transient network errors (not CORS, rate limits, etc.)
				const isRetryable = this.isRetryableError(error);

				if (attempt < maxRetries && isRetryable) {
					console.warn(`[Letta Stream] Retryable error on attempt ${attempt + 1}:`, error.message);
					continue; // Will retry
				}

				// Max retries reached or non-retryable error - call onError and throw
				console.error(`[Letta Stream] Non-retryable error or max retries reached:`, error);
				onError(error);
				throw error;
			}
		}

		// If we get here, all retries failed
		if (lastError) {
			onError(lastError);
			throw lastError;
		}
	}

	/**
	 * Check if an error is retryable (transient network issues)
	 */
	private isRetryableError(error: any): boolean {
		// Network errors
		if (error instanceof TypeError && (
			error.message.includes('NetworkError') ||
			error.message.includes('fetch') ||
			error.message.includes('Failed to fetch')
		)) {
			return true;
		}

		// Server errors (502, 503, 504)
		const statusCode = error.statusCode || error.status;
		if (statusCode === 502 || statusCode === 503 || statusCode === 504) {
			return true;
		}

		// Connection reset/timeout
		if (error.message?.includes('ECONNRESET') ||
			error.message?.includes('ETIMEDOUT') ||
			error.message?.includes('socket hang up')) {
			return true;
		}

		return false;
	}

	/**
	 * Send message through Letta Code bridge (local mode)
	 */
	private async sendMessageToBridge(
		message: string,
		images: Array<{ base64: string; mediaType: string }> | undefined,
		onMessage: (message: any) => void,
		onError: (error: Error) => void,
		onComplete: () => void,
		abortSignal?: AbortSignal,
	): Promise<void> {
		if (!this.bridge || !this.bridge.isConnected()) {
			onError(new Error("Bridge not connected"));
			return;
		}

		console.log('[Letta Plugin] Sending message via bridge:', message.substring(0, 100));

		let hasCompleted = false;
		const completeOnce = () => {
			if (!hasCompleted) {
				hasCompleted = true;
				onComplete();
			}
		};

		try {
			// Send message to bridge with callback for streaming responses
			await this.bridge.sendMessage(message, images, (lettaMessage: LettaCodeMessage) => {
				console.log('[Letta Plugin] Bridge message received:', lettaMessage);
				
				// Forward to chat view
				onMessage(lettaMessage);
				
				// Check if this is a completion message
				if (lettaMessage.message_type === 'assistant_message' || 
					lettaMessage.content === '[DONE]') {
					completeOnce();
				}
			});

			// Set a timeout in case we don't get a completion signal
			setTimeout(() => {
				completeOnce();
			}, 30000); // 30 second timeout

			// Handle abort signal
			if (abortSignal) {
				abortSignal.addEventListener('abort', () => {
					console.log('[Letta Plugin] Bridge message aborted');
					completeOnce();
				});
			}

		} catch (error: any) {
			console.error('[Letta Plugin] Bridge message error:', error);
			onError(error);
			completeOnce();
		}
	}

	/**
	 * Execute the actual streaming request (extracted for retry logic)
	 */
	private async executeStreamingRequest(
		message: string,
		images: Array<{ base64: string; mediaType: string }> | undefined,
		onMessage: (message: any) => void,
		onComplete: () => void,
		abortSignal?: AbortSignal,
	): Promise<void> {
		// These are checked in sendMessageToAgentStream but TypeScript needs them here too
		if (!this.agent) throw new Error("Agent not connected");
		if (!this.client) throw new Error("Client not initialized");

		try {
			// Build content - use array format if images are present
			let content: any;
			if (images && images.length > 0) {
				content = [
					{ type: "text", text: `[Message from Obsidian chat interface]\n\n${message}` },
				];
				for (const img of images) {
					content.push({
						type: "image",
						source: {
							type: "base64",
							media_type: img.mediaType,
							data: img.base64,
						},
					});
				}
				console.log(`[Letta Stream] Sending message with ${images.length} image(s)`);
			} else {
				content = `[Message from Obsidian chat interface]\n\n${message}`;
			}

			// Use the SDK's streaming API
			console.log(
				"[Letta Stream] Starting stream for agent:",
				this.agent.id,
			);
			const stream = await this.client.agents.messages.createStream(
				this.agent.id,
				{
					messages: [
						{
							role: "user",
							content,
						},
					],
					streamTokens: this.settings.useTokenStreaming,
				},
			);
			console.log("[Letta Stream] Stream created successfully:", stream);

			// Process the stream
			for await (const chunk of stream) {
				// RAINMAKER FIX: Check if stream was aborted
				if (abortSignal?.aborted) {
					console.log("[Letta Stream] Stream aborted mid-processing");
					onComplete(); // Still call onComplete to finalize UI with partial content
					return;
				}

				console.log("[Letta Stream] Chunk received:", chunk);
				console.log("[Letta Stream] Chunk type:", typeof chunk);

				// Check if this is the [DONE] signal
				if (
					(chunk as any) === "[DONE]" ||
					(typeof chunk === "string" &&
						(chunk as string).includes("[DONE]"))
				) {
					console.log("[Letta Stream] Received DONE signal");
					onComplete();
					return;
				}

				onMessage(chunk);
			}

			// Stream completed successfully (if we exit loop normally)
			console.log("[Letta Stream] Stream ended normally");
			onComplete();
		} catch (error: any) {
			// Handle abort errors gracefully - user intentionally stopped generation
			if (error.name === 'AbortError' || abortSignal?.aborted) {
				console.log("[Letta Stream] Stream aborted by user");
				throw error; // Let retry loop handle this
			}

			console.error("[Letta Stream] Stream error:", error);
			console.error("[Letta Stream] Error details:", {
				message: error.message,
				status: error.statusCode || error.status,
				name: error.name,
				stack: error.stack,
			});

			// Check if this is a CORS-related error and create appropriate error message
			if (
				error instanceof TypeError &&
				(error.message.includes("NetworkError") ||
					error.message.includes("fetch") ||
					error.message.includes("Failed to fetch") ||
					error.message.includes("CORS"))
			) {
				const corsError = new Error(
					"CORS_ERROR: Network request failed, likely due to CORS restrictions. Falling back to non-streaming API.",
				);
				throw corsError; // Throw to let retry logic decide
			} else if (error instanceof LettaError) {
				// Handle Letta SDK errors - check for rate limiting and CORS issues
				if (error.statusCode === 429) {
					// This is a genuine rate limit error - don't retry
					throw new Error(`HTTP 429: ${error.message}`);
				} else if (
					error.statusCode === 0 ||
					(error.statusCode === 429 &&
						!error.message.includes("rate"))
				) {
					// Likely a CORS error masquerading as another error
					const corsError = new Error(
						"CORS_ERROR: Cross-origin request blocked. Streaming not available from this origin. Falling back to non-streaming API.",
					);
					throw corsError;
				} else {
					throw error;
				}
			} else {
				throw error;
			}
		}
	}

	/**
	 * Get or create an upload folder for file attachments
	 * Note: Letta folder upload is disabled for now - PDF text is extracted client-side
	 */
	async getOrCreateUploadFolder(): Promise<string | null> {
		// Disabled for now - client-side extraction provides immediate access
		// Letta folder upload can be re-enabled in a future version
		console.log('[Letta] Folder upload disabled - using client-side extraction');
		return null;
	}

	/**
	 * Upload a file to Letta source/folder (async, fire-and-forget)
	 * Note: Disabled for now - PDF text is extracted client-side for immediate access
	 */
	async uploadFileToFolder(file: File, folderId: string): Promise<boolean> {
		// Disabled for now - client-side extraction provides immediate access
		console.log(`[Letta] File upload to folder disabled - ${file.name} text extracted client-side`);
		return false;
	}

	// Vault tool definitions
	private getVaultToolDefinitions(): { name: string; code: string; description: string; tags: string[] }[] {
		return [
			{
				name: "write_obsidian_note",
				description: "Write content to an Obsidian note file",
				tags: ["obsidian", "note-creation", "vault-write"],
				code: `
def write_obsidian_note(
    title: str,
    content: str,
    folder: str = ""
) -> str:
    """
    Write content to an Obsidian note file.

    Args:
        title: The title/filename for the note (without .md extension)
        content: The markdown content to write to the note
        folder: Optional folder path within the vault (e.g., 'journal' or 'projects/myproject')

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "write_file",
        "title": title,
        "content": content,
        "folder": folder
    })
`
			},
			{
				name: "obsidian_read_file",
				description: "Read the contents of an Obsidian note by file path",
				tags: ["obsidian", "vault-read"],
				code: `
def obsidian_read_file(
    file_path: str,
    include_metadata: bool = True
) -> str:
    """
    Read the contents of an Obsidian note.

    Args:
        file_path: Path to the file relative to vault root (e.g., 'folder/note.md')
        include_metadata: Whether to include frontmatter, tags, and link info

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "read_file",
        "file_path": file_path,
        "include_metadata": include_metadata
    })
`
			},
			{
				name: "obsidian_search_vault",
				description: "Search the Obsidian vault for files by name, content, or tags",
				tags: ["obsidian", "vault-search"],
				code: `
def obsidian_search_vault(
    query: str,
    search_type: str = "all",
    folder: str = "",
    limit: int = 20
) -> str:
    """
    Search the Obsidian vault for files matching criteria.

    Args:
        query: Search query string
        search_type: Where to search - "name", "content", "tags", "path", or "all"
        folder: Limit search to specific folder (optional)
        limit: Maximum number of results (default 20)

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "search_vault",
        "query": query,
        "search_type": search_type,
        "folder": folder,
        "limit": limit
    })
`
			},
			{
				name: "obsidian_list_files",
				description: "List files in an Obsidian vault folder",
				tags: ["obsidian", "vault-read"],
				code: `
def obsidian_list_files(
    folder: str = "",
    recursive: bool = False,
    limit: int = 50
) -> str:
    """
    List files in a vault folder.

    Args:
        folder: Folder path to list (empty string = vault root)
        recursive: Whether to include files in subfolders
        limit: Maximum number of files to return

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "list_files",
        "folder": folder,
        "recursive": recursive,
        "limit": limit
    })
`
			},
			{
				name: "obsidian_modify_file",
				description: "Modify an existing Obsidian note (append, prepend, or replace section)",
				tags: ["obsidian", "vault-write"],
				code: `
def obsidian_modify_file(
    file_path: str,
    operation: str,
    content: str,
    section_heading: str = ""
) -> str:
    """
    Modify an existing Obsidian note. Requires user approval.

    Args:
        file_path: Path to the file to modify
        operation: Type of modification - "append", "prepend", or "replace_section"
        content: Content to insert/append/replace with
        section_heading: Heading name for replace_section (e.g., "## Notes")

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "modify_file",
        "file_path": file_path,
        "operation": operation,
        "content": content,
        "section_heading": section_heading,
        "requires_approval": True
    })
`
			},
			{
				name: "obsidian_delete_file",
				description: "Delete an Obsidian note (requires user approval)",
				tags: ["obsidian", "vault-write"],
				code: `
def obsidian_delete_file(
    file_path: str,
    move_to_trash: bool = True
) -> str:
    """
    Delete an Obsidian note. Requires user approval.

    Args:
        file_path: Path to the file to delete
        move_to_trash: If true, moves to system trash; if false, permanently deletes

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "delete_file",
        "file_path": file_path,
        "move_to_trash": move_to_trash,
        "requires_approval": True
    })
`
			},
			{
				name: "obsidian_create_folder",
				description: "Create a new folder in the Obsidian vault",
				tags: ["obsidian", "vault-write"],
				code: `
def obsidian_create_folder(
    folder_path: str
) -> str:
    """
    Create a new folder in the vault.

    Args:
        folder_path: Path for the new folder (e.g., 'projects/myproject')

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "create_folder",
        "folder_path": folder_path
    })
`
			},
			{
				name: "obsidian_rename",
				description: "Rename a file or folder in the Obsidian vault (requires user approval)",
				tags: ["obsidian", "vault-write"],
				code: `
def obsidian_rename(
    old_path: str,
    new_name: str
) -> str:
    """
    Rename a file or folder. Requires user approval.

    Args:
        old_path: Current path of the file/folder
        new_name: New name (just the name, not full path)

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "rename",
        "old_path": old_path,
        "new_name": new_name,
        "requires_approval": True
    })
`
			},
			{
				name: "obsidian_move",
				description: "Move a file or folder to a different location (requires user approval)",
				tags: ["obsidian", "vault-write"],
				code: `
def obsidian_move(
    source_path: str,
    destination_folder: str
) -> str:
    """
    Move a file or folder to a new location. Requires user approval.

    Args:
        source_path: Current path of the file/folder
        destination_folder: Target folder path

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "move",
        "source_path": source_path,
        "destination_folder": destination_folder,
        "requires_approval": True
    })
`
			},
			{
				name: "obsidian_copy_file",
				description: "Copy a file to a new location in the vault",
				tags: ["obsidian", "vault-write"],
				code: `
def obsidian_copy_file(
    source_path: str,
    destination_path: str
) -> str:
    """
    Copy a file to a new location.

    Args:
        source_path: Path of the file to copy
        destination_path: Full path for the copy (including filename)

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "copy_file",
        "source_path": source_path,
        "destination_path": destination_path
    })
`
			},
			{
				name: "obsidian_get_metadata",
				description: "Get metadata for a file without reading full content",
				tags: ["obsidian", "vault-read"],
				code: `
def obsidian_get_metadata(
    file_path: str
) -> str:
    """
    Get file metadata (size, dates, tags, links) without reading full content.

    Args:
        file_path: Path to the file

    Returns:
        str: JSON with action details for the Obsidian plugin to execute
    """
    import json
    return json.dumps({
        "action": "get_metadata",
        "file_path": file_path
    })
`
			}
		];
	}

	async registerObsidianTools(): Promise<boolean> {
		// Register vault collaboration tools for agent-vault interaction
		console.log("[Letta Plugin] Starting vault tools registration...");

		if (!this.client) {
			console.error("[Letta Plugin] Cannot register tools: Letta client not initialized");
			new Notice("Cannot register vault tools: Not connected to Letta");
			return false;
		}

		if (!this.agent) {
			console.warn("[Letta Plugin] Cannot register tools: No agent attached");
			new Notice("Cannot register vault tools: No agent selected");
			return false;
		}

		// Check user consent if required (first time only)
		if (this.settings.askBeforeToolRegistration) {
			console.log("[Letta Plugin] User consent required - showing modal...");
			const consentModal = new ToolRegistrationConsentModal(this.app, this);
			const userConsent = await consentModal.show();
			if (!userConsent) {
				console.log("[Letta Plugin] User declined tool registration");
				new Notice("Vault tools not registered (user declined)");
				return false;
			}
			// Don't ask again this session
			this.settings.askBeforeToolRegistration = false;
			await this.saveSettings();
		}

		const toolDefinitions = this.getVaultToolDefinitions();
		console.log(`[Letta Plugin] Registering ${toolDefinitions.length} vault tools...`);
		let registeredCount = 0;

		for (const toolDef of toolDefinitions) {
			try {
				// Check if the tool already exists
				let existingTool: any = null;
				try {
					const tools = await this.client.tools.list({ name: toolDef.name });
					existingTool = tools.find((tool: any) => tool.name === toolDef.name);
				} catch (error) {
					console.error(`Failed to check existing tool '${toolDef.name}':`, error);
				}

				// Check if tool is already attached to agent
				if (existingTool) {
					try {
						const agentDetails = await this.client.agents.retrieve(this.agent.id);
						const currentTools = agentDetails.tools || [];
						const isToolAttached = currentTools.some((t: any) =>
							t.name === toolDef.name || t === toolDef.name ||
							(typeof t === 'object' && t.id === existingTool.id)
						);

						console.log(`[Letta Plugin] Tool '${toolDef.name}' status:`, {
						exists: !!existingTool,
						existingId: existingTool?.id,
						attached: isToolAttached,
						agentToolCount: currentTools.length
					});

					if (isToolAttached) {
							console.log(`[Letta Plugin] Tool '${toolDef.name}' already attached to agent`);
							registeredCount++;
							continue;
						}
					} catch (error) {
						console.error(`Failed to check agent tools for '${toolDef.name}':`, error);
					}
				}

				// Create or get the tool
				let tool = existingTool;
				if (!existingTool) {
					console.log(`[Letta Plugin] Creating new tool '${toolDef.name}'...`);
					tool = await this.client.tools.upsert({
						name: toolDef.name,
						sourceCode: toolDef.code,
						description: toolDef.description,
						tags: toolDef.tags,
					} as any);
					console.log(`[Letta Plugin] Successfully created tool '${toolDef.name}'`);
				}

				// Attach tool to agent
				if (tool && tool.id) {
					console.log(`[Letta Plugin] Attaching tool '${toolDef.name}' to agent...`);
					await this.client.agents.tools.attach(this.agent.id, tool.id);
					console.log(`[Letta Plugin] Successfully attached '${toolDef.name}' tool to agent`);
					registeredCount++;
				}
			} catch (error: any) {
				console.error(`Failed to register tool '${toolDef.name}':`, error);
			}
		}

		// Report results
		if (registeredCount === toolDefinitions.length) {
			console.log(`[Letta Plugin] Successfully registered all ${registeredCount} vault tools`);
			// Update agent's persona with tool instructions
			await this.updateAgentSystemWithToolInstructions();
			new Notice(`Vault tools ready (${registeredCount} tools)`);
			return true;
		} else if (registeredCount > 0) {
			console.warn(`[Letta Plugin] Partially registered vault tools: ${registeredCount}/${toolDefinitions.length}`);
			// Still update persona with available tools
			await this.updateAgentSystemWithToolInstructions();
			new Notice(`Vault tools partially ready (${registeredCount}/${toolDefinitions.length} tools)`);
			return true; // Partial success is still usable
		} else {
			console.error("[Letta Plugin] Failed to register any vault tools");
			new Notice("Failed to register vault tools - check console for details");
			return false;
		}
	}

	async updateAgentSystemWithToolInstructions(): Promise<void> {
		if (!this.client || !this.agent) return;

		const toolInstructions = `

## Available Vault Tools

You have the following tools to interact with the user's Obsidian vault. ALWAYS use these tools for vault operations - do NOT use external APIs or MCP servers.

### File Operations:
1. **write_obsidian_note(title, content, folder)** - Create or overwrite a note
2. **obsidian_read_file(file_path, include_metadata)** - Read a file's contents and metadata
3. **obsidian_modify_file(file_path, operation, content, section_heading)** - Modify existing file (append/prepend/replace_section)
4. **obsidian_delete_file(file_path, move_to_trash)** - Delete a file

### Search & Discovery:
5. **obsidian_search_vault(query, search_type, folder, limit)** - Search for files by name/content/tags/path
6. **obsidian_list_files(folder, recursive, limit)** - List files in a folder
7. **obsidian_get_metadata(file_path)** - Get file metadata without reading full content

### Organization:
8. **obsidian_create_folder(folder_path)** - Create a new folder
9. **obsidian_rename(old_path, new_name)** - Rename a file or folder
10. **obsidian_move(source_path, destination_folder)** - Move file/folder to new location
11. **obsidian_copy_file(source_path, destination_path)** - Copy a file

When the user asks to create, read, edit, search, or organize files in their vault, use these tools.
`;

		try {
			// Get current memory blocks
			const blocks = await this.client.agents.blocks.list(this.agent.id);
			const personaBlock = blocks.find((b: any) => b.label === 'persona');

			if (personaBlock && personaBlock.label && !personaBlock.value.includes('Available Vault Tools')) {
				console.log("[Letta Plugin] Updating agent persona with tool instructions...");
				await this.client.agents.blocks.modify(
					this.agent.id,
					personaBlock.label,
					{ value: personaBlock.value + toolInstructions }
				);
				console.log("[Letta Plugin] Successfully updated agent persona with tool instructions");
			} else if (!personaBlock) {
				console.log("[Letta Plugin] No persona block found - skipping tool instruction update");
			} else {
				console.log("[Letta Plugin] Tool instructions already present in persona block");
			}
		} catch (e) {
			console.error("[Letta Plugin] Failed to update agent persona with tool instructions:", e);
		}
	}

	/* ORIGINAL APPROVAL-BASED CODE - KEPT FOR REFERENCE
	async registerObsidianToolsWithApproval(): Promise<boolean> {
		// DISABLED: Approval-based tool registration is currently disabled due to upstream Letta API issues
		// with streaming approval flow. Re-enable once the API properly supports approval_request_message
		// during streaming (currently only sends stop_reason).
		if (!this.client) {
			console.error("Cannot register tools: Letta client not initialized");
			return false;
		}

		const toolName = "write_obsidian_note";

		// First check if the tool already exists
		console.log(`[Letta Plugin] Checking if tool '${toolName}' already exists...`);
		let existingTool: any = null;
		try {
			const tools = await this.client.tools.list({ name: toolName });
			existingTool = tools.find((tool: any) => tool.name === toolName);
			if (existingTool) {
				console.log(`[Letta Plugin] Tool '${toolName}' already exists with ID: ${existingTool.id}`);
			}
		} catch (error) {
			console.error("Failed to check existing tools:", error);
		}

		// If tool exists and we have an agent, check if it's already attached
		if (existingTool && this.agent) {
			console.log(`[Letta Plugin] Checking if tool is already attached to agent ${this.agent.id}...`);
			try {
				const agentDetails = await this.client.agents.retrieve(this.agent.id);
				const currentTools = agentDetails.tools || [];

				const isToolAttached = currentTools.some((t: any) =>
					t.name === toolName || t === toolName ||
					(typeof t === 'object' && t.id === existingTool.id)
				);

				if (isToolAttached) {
					console.log(`[Letta Plugin] Tool '${toolName}' already exists and is attached to agent. Ensuring approval requirement is set...`);

					// Even if tool is attached, ensure approval requirement is set (Method 3)
					try {
						console.log(`[Letta Plugin] Calling modifyApproval with agentId: ${this.agent.id}, toolName: ${toolName}, requiresApproval: true`);
						const approvalResult = await this.client.agents.tools.modifyApproval(
							this.agent.id,
							toolName,
							{ requiresApproval: true }
						);
						console.log(`[Letta Plugin] modifyApproval response:`, approvalResult);

						// Check tool rules in the agent state
						const toolRules = (approvalResult as any).toolRules || (approvalResult as any).tool_rules;
						console.log(`[Letta Plugin] Agent toolRules after modifyApproval:`, toolRules);
						const approvalRule = toolRules?.find((rule: any) =>
							rule.toolName === toolName || rule.tool_name === toolName
						);
						console.log(`[Letta Plugin] Approval rule for '${toolName}':`, approvalRule);

						// Verify the tool's approval status after setting it
						const agentTools = await this.client.agents.tools.list(this.agent.id);
						const toolInfo = agentTools.find((t: any) => t.name === toolName);
						console.log(`[Letta Plugin] Tool '${toolName}' info from tools list:`, toolInfo);
					} catch (approvalError: any) {
						console.error("Failed to set approval requirement:", approvalError);
						console.error("Error details:", approvalError.message, approvalError.stack);
					}

					return true; // Success - tool is already fully configured
				} else {
					console.log(`[Letta Plugin] Tool exists but not attached to agent. Will attach it.`);
				}
			} catch (error) {
				console.error("Failed to check agent tools:", error);
			}
		}

		const writeNoteToolCode = `
def write_obsidian_note(
    block_label: str,
    file_path: str
) -> str:
    """
    Request approval to write a memory block's content to an Obsidian note file.
    This tool requires human approval before execution.

    Args:
        block_label: The label of the memory block containing the content to write
        file_path: The path where the note should be created (e.g., 'journal/2024-10-01.md' or 'projects/my-project.md')
                  If a default note folder is configured, it will be automatically prepended to this path.

    Returns:
        str: Success message if approved and executed

    Note:
        This tool will pause and request approval from the user.
        The user can approve to create the note or deny with guidance.
    """
    return f"Requesting approval to write block '{block_label}' to {file_path}"
`;

		// Now check if user consent is required (only if we need to create or attach the tool)
		if (this.settings.askBeforeToolRegistration) {
			console.log("[Letta Plugin] User consent required - showing modal...");
			const consentModal = new ToolRegistrationConsentModal(this.app, this);
			const userConsent = await consentModal.show();
			if (!userConsent) {
				console.log("[Letta Plugin] User declined tool registration");
				return false;
			}
		}

		let tool = existingTool;
		
		try {
			if (!existingTool) {
				// Tool doesn't exist, create it with approval requirement
				console.log(`[Letta Plugin] Creating new tool '${toolName}' with approval requirement...`);
				tool = await this.client.tools.upsert({
					name: toolName,
					sourceCode: writeNoteToolCode,
					description: "Write a memory block's content to an Obsidian note file (requires approval)",
					tags: ["obsidian", "note-creation", "requires-approval"],
					default_requires_approval: true
				} as any);
				console.log("Successfully created Obsidian note creation tool with approval requirement:", tool);
			} else {
				console.log(`[Letta Plugin] Using existing tool '${toolName}' with ID: ${existingTool.id}`);
			}

			// Attach tool to current agent if available and not already attached
			if (this.agent && tool && tool.id) {
				try {
					// If we had an existing tool that was already attached, we would have returned early
					// So if we reach here, we need to attach the tool
					console.log(`[Letta Plugin] Attaching tool '${toolName}' to agent ${this.agent.id}...`);
					await this.client.agents.tools.attach(this.agent.id, tool.id);
					console.log(`[Letta Plugin] Successfully attached '${toolName}' tool to agent`);

					// Set approval requirement for this agent-tool relationship (Method 3)
					console.log(`[Letta Plugin] Setting approval requirement for '${toolName}' on agent ${this.agent.id}...`);
					try {
						console.log(`[Letta Plugin] Calling modifyApproval with agentId: ${this.agent.id}, toolName: ${toolName}, requiresApproval: true`);
						const approvalResult = await this.client.agents.tools.modifyApproval(
							this.agent.id,
							toolName,
							{ requiresApproval: true }
						);
						console.log(`[Letta Plugin] modifyApproval response:`, approvalResult);

						// Check tool rules in the agent state
						const toolRules = (approvalResult as any).toolRules || (approvalResult as any).tool_rules;
						console.log(`[Letta Plugin] Agent toolRules after modifyApproval:`, toolRules);
						const approvalRule = toolRules?.find((rule: any) =>
							rule.toolName === toolName || rule.tool_name === toolName
						);
						console.log(`[Letta Plugin] Approval rule for '${toolName}':`, approvalRule);

						// Verify the tool's approval status after setting it
						const agentTools = await this.client.agents.tools.list(this.agent.id);
						const toolInfo = agentTools.find((t: any) => t.name === toolName);
						console.log(`[Letta Plugin] Tool '${toolName}' info from tools list:`, toolInfo);
					} catch (approvalError: any) {
						console.error("Failed to set approval requirement:", approvalError);
						console.error("Error details:", approvalError.message, approvalError.stack);
						// Don't fail the whole operation if this fails
					}
				} catch (error) {
					console.error("Failed to attach tool to agent:", error);
					// Log more details for debugging
					console.error("Error details:", {
						agentId: this.agent.id,
						toolId: tool.id,
						errorMessage: error.message
					});
				}
			}

			const actionMessage = existingTool 
				? "Obsidian note creation tool attached successfully"
				: "Obsidian note creation tool registered successfully";
			new Notice(actionMessage);
			return true;
		} catch (error) {
			console.error("Failed to register Obsidian tools:", error);
			new Notice("Failed to register note creation tool");
			return false;
		}
	}
	END COMMENTED OUT SECTION - ORIGINAL APPROVAL-BASED CODE */

	async createNoteFromProposal(proposal: ObsidianNoteProposal): Promise<string> {
		// Sanitize the title to ensure it's a valid filename
		const sanitizedTitle = proposal.title.replace(/[\\/:*?"<>|]/g, "_");
		const fileName = `${sanitizedTitle}.md`;
		
		// Determine the full path
		const folder = proposal.folder?.trim() || this.settings.defaultNoteFolder;
		const fullPath = folder ? `${folder}/${fileName}` : fileName;
		
		try {
			// Create folder if needed and it doesn't exist
			if (folder) {
				const folderExists = this.app.vault.getAbstractFileByPath(folder);
				if (!folderExists) {
					await this.app.vault.createFolder(folder);
					console.log(`Created folder: ${folder}`);
				}
			}
			
			// Check if file already exists
			const existingFile = this.app.vault.getAbstractFileByPath(fullPath);
			if (existingFile) {
				// Handle duplicate filename
				const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
				const duplicatePath = folder 
					? `${folder}/${sanitizedTitle}_${timestamp}.md`
					: `${sanitizedTitle}_${timestamp}.md`;
				
				const file = await this.app.vault.create(duplicatePath, proposal.content);
				
				// Open the note in a new tab
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(file);
				
				new Notice(`Created note with unique name: ${file.basename}`);
				return file.path;
			} else {
				// Create the note
				const file = await this.app.vault.create(fullPath, proposal.content);
				
				// Open the note in a new tab
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(file);
				
				new Notice(`Created note: ${file.basename}`);
				return file.path;
			}
		} catch (error) {
			console.error("Failed to create note from proposal:", error);
			new Notice(`Failed to create note: ${error.message}`);
			throw error;
		}
	}
}

// Slash commands registry - easily extensible for future commands
interface SlashCommand {
	name: string;
	description: string;
	usage?: string;
}

const SLASH_COMMANDS: SlashCommand[] = [
	{ name: "vault", description: "Perform vault file operations", usage: "/vault <request>" },
	{ name: "focus", description: "Toggle focus mode on/off" },
	{ name: "clear", description: "Clear chat history display" },
	{ name: "help", description: "Show available commands" },
];

class LettaChatView extends ItemView {
	plugin: LettaPlugin;
	chatContainer: HTMLElement;
	typingIndicator: HTMLElement;
	sizeLimitWarning: HTMLElement;
	heartbeatTimeout: NodeJS.Timeout | null = null;
	header: HTMLElement;
	inputContainer: HTMLElement;
	messageInput: HTMLTextAreaElement;
	sendButton: HTMLButtonElement;
	agentNameElement: HTMLElement;
	statusDot: HTMLElement;
	statusText: HTMLElement;
	focusIndicator: HTMLElement | null = null;
	autocompleteDropdown: HTMLElement | null = null;
	mentionedFiles: Set<string> = new Set();
	selectedSuggestionIndex: number = -1;
	// Track autocomplete mode: 'file' for @mentions, 'command' for /commands
	autocompleteMode: 'file' | 'command' | null = null;
	// Agent dropdown for quick switching
	agentDropdownContent: HTMLElement | null = null;
	loadMoreButton: HTMLElement | null = null;
	// Vault tools status indicator
	vaultToolsIndicator: HTMLElement | null = null;
	// Focus mode toggle button
	focusToggle: HTMLButtonElement | null = null;
	// RAINMAKER FIX: AbortController for cleanup of event listeners
	private abortController: AbortController | null = null;
	// RAINMAKER FIX: Prevent concurrent message loads
	private isLoadingMessages: boolean = false;
	// File attachment support (images and documents)
	private pendingAttachments: PendingAttachment[] = [];
	private attachmentPreviewContainer: HTMLElement | null = null;
	private fileInput: HTMLInputElement | null = null;
	// Legacy image support (for backward compatibility)
	private pendingImages: Array<{
		blob: Blob;
		base64: string;
		mediaType: string;
		previewEl: HTMLElement;
	}> = [];
	private imagePreviewContainer: HTMLElement | null = null;
	// Agent switching state
	private isSwitchingAgent: boolean = false;
	private switchingToAgentName: string | null = null;
	private switchButton: HTMLElement | null = null;
	private agentAvatar: HTMLElement | null = null;
	// RAINMAKER FIX: Track streaming requests to abort on agent switch
	private streamAbortController: AbortController | null = null;
	private currentStreamingAgentId: string | null = null;
	// Streaming state for stop button and status indicators
	private isActivelyStreaming: boolean = false;
	private streamingPhase: 'idle' | 'reasoning' | 'generating' | 'tool_call' = 'idle';
	private currentToolCallNameForStatus: string = '';
	private streamingStepCount: number = 0;
	private streamingTokenEstimate: number = 0;
	private wasStreamingAborted: boolean = false;
	// Render batching state for smooth streaming
	private pendingRenderContent: string = '';
	private renderScheduled: boolean = false;
	private rafId: number | null = null;

	// Tab bar UI elements for quick agent switching
	private tabBar: HTMLElement | null = null;
	private tabContainer: HTMLElement | null = null;
	private agentTabs: Map<string, HTMLElement> = new Map();

	constructor(leaf: WorkspaceLeaf, plugin: LettaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return LETTA_CHAT_VIEW_TYPE;
	}

	getDisplayText() {
		return "Letta Chat";
	}

	getIcon() {
		return "bot";
	}

	async onOpen() {
		// RAINMAKER FIX: Create AbortController for cleanup
		this.abortController = new AbortController();
		const signal = this.abortController.signal;

		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("letta-chat-view");

		// Header with connection status
		this.header = container.createEl("div", { cls: "letta-chat-header" });

		// Top row: Avatar + Agent info + Menu
		const titleSection = this.header.createEl("div", {
			cls: "letta-chat-title-section",
		});

		// Agent avatar
		this.agentAvatar = titleSection.createEl("div", {
			cls: "letta-agent-avatar",
		});
		this.updateAgentAvatar();

		// Agent info container (name + switch button)
		const agentInfoContainer = titleSection.createEl("div", {
			cls: "letta-agent-info",
		});

		this.agentNameElement = agentInfoContainer.createEl("h3", {
			text: this.plugin.agent
				? this.plugin.settings.agentName
				: "No Agent",
			cls: this.plugin.agent
				? "letta-chat-title"
				: "letta-chat-title no-agent",
		});
		this.agentNameElement.addClass("letta-agent-name-clickable");
		this.agentNameElement.title = "Click to edit agent name";
		this.agentNameElement.addEventListener("click", () =>
			this.editAgentName(),
		{ signal });

		// Agent dropdown for quick switching (below agent name)
		const agentDropdown = agentInfoContainer.createEl("div", {
			cls: "letta-agent-dropdown",
		});

		this.switchButton = agentDropdown.createEl("span", {
			cls: "letta-switch-button",
		});
		this.switchButton.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M7 16V4m0 0L3 8m4-4l4 4m6 4v12m0 0l4-4m-4 4l-4-4"/></svg> Switch`;
		this.switchButton.title = "Switch to a different agent";

		this.agentDropdownContent = agentDropdown.createEl("div", {
			cls: "letta-agent-dropdown-content",
		});

		// Toggle dropdown on click
		this.switchButton.addEventListener("click", (e) => {
			e.stopPropagation();
			if (this.isSwitchingAgent) return; // Prevent switching while already switching
			if (this.agentDropdownContent) {
				const isVisible = this.agentDropdownContent.classList.contains("show");
				if (!isVisible) {
					this.populateAgentDropdown();
				}
				this.agentDropdownContent.classList.toggle("show");
			}
		}, { signal });

		// Close dropdown when clicking outside
		document.addEventListener("click", (e) => {
			if (this.agentDropdownContent && !agentDropdown.contains(e.target as Node)) {
				this.agentDropdownContent.classList.remove("show");
			}
		}, { signal });

		// Header buttons container (right side)
		const headerButtonContainer = titleSection.createEl("div", {
			cls: "letta-button-container",
		});

		// Overflow menu (⋮) for secondary actions
		const overflowMenu = headerButtonContainer.createEl("div", {
			cls: "letta-overflow-menu",
		});

		const overflowButton = overflowMenu.createEl("span", {
			text: "⋮",
		});
		overflowButton.title = "More options";
		overflowButton.addClass("letta-config-button");
		overflowButton.addClass("letta-overflow-button");

		const overflowContent = overflowMenu.createEl("div", {
			cls: "letta-overflow-content",
		});

		// Menu items
		const configItem = overflowContent.createEl("div", { cls: "letta-overflow-item" });
		configItem.textContent = "Agent Config";
		configItem.addEventListener("click", () => {
			overflowContent.classList.remove("show");
			this.openAgentConfig();
		}, { signal });

		const memoryItem = overflowContent.createEl("div", { cls: "letta-overflow-item" });
		memoryItem.textContent = "Memory Blocks";
		memoryItem.addEventListener("click", () => {
			overflowContent.classList.remove("show");
			this.plugin.openMemoryView();
		}, { signal });

		const adeItem = overflowContent.createEl("div", { cls: "letta-overflow-item" });
		adeItem.textContent = "Open in ADE";
		adeItem.addEventListener("click", () => {
			overflowContent.classList.remove("show");
			this.openInADE();
		}, { signal });

		// Toggle overflow menu
		overflowButton.addEventListener("click", (e) => {
			e.stopPropagation();
			overflowContent.classList.toggle("show");
		}, { signal });

		// Close overflow when clicking outside
		document.addEventListener("click", (e) => {
			if (!overflowMenu.contains(e.target as Node)) {
				overflowContent.classList.remove("show");
			}
		}, { signal });

		// Compact status line
		const statusLine = this.header.createEl("div", {
			cls: "letta-status-line",
		});

		// Connection status
		const connectionStatus = statusLine.createEl("span", {
			cls: "letta-connection-status",
		});
		this.statusDot = connectionStatus.createEl("span", {
			cls: "letta-status-dot",
		});
		this.statusText = connectionStatus.createEl("span", {
			cls: "letta-status-text",
		});

		// Vault tools status
		this.vaultToolsIndicator = statusLine.createEl("span", {
			cls: "letta-vault-status",
		});
		this.updateVaultToolsIndicator();

		// Focus mode toggle
		this.focusToggle = statusLine.createEl("button", {
			cls: "letta-focus-toggle",
		});
		this.focusToggle.addEventListener("click", async () => {
			this.plugin.settings.focusMode = !this.plugin.settings.focusMode;
			await this.plugin.saveSettings();
			this.updateFocusToggle();
		}, { signal });
		this.updateFocusToggle();

		// Tab bar for quick agent switching
		this.createTabBar(container as HTMLElement);

		// Initialize tabs from recent agents
		this.initializeRecentAgentTabs();

		// Chat container
		this.chatContainer = container.createEl("div", {
			cls: "letta-chat-container",
		});

		// Size limit warning (hidden by default)
		this.sizeLimitWarning = this.chatContainer.createEl("div", {
			cls: "letta-size-limit-warning",
		});
		this.sizeLimitWarning.style.display = "none";

		// Typing indicator
		this.typingIndicator = this.chatContainer.createEl("div", {
			cls: "letta-typing-indicator",
		});
		this.typingIndicator.addClass("letta-typing-hidden");

		const typingText = this.typingIndicator.createEl("span", {
			cls: "letta-typing-text",
			text: `${this.plugin.settings.agentName} is thinking`,
		});

		const typingDots = this.typingIndicator.createEl("span", {
			cls: "letta-typing-dots",
		});
		typingDots.createEl("span");
		typingDots.createEl("span");
		typingDots.createEl("span");

		// Now that chat container exists, update status to show disconnected message if needed
		this.updateChatStatus();

		// Attachment preview container (for files and images)
		this.attachmentPreviewContainer = container.createEl("div", {
			cls: "letta-attachment-preview-container",
		});
		// Legacy reference for backward compatibility
		this.imagePreviewContainer = this.attachmentPreviewContainer;

		// Input container
		this.inputContainer = container.createEl("div", {
			cls: "letta-input-container",
		});

		// Hidden file input for attachment button
		this.fileInput = this.inputContainer.createEl("input", {
			cls: "letta-file-input",
			attr: {
				type: "file",
				multiple: "true",
				accept: ".png,.jpg,.jpeg,.gif,.webp,.bmp,.svg,.pdf,.txt,.md,.json,.docx,.xlsx,.xls,.csv,.pptx",
				style: "display: none;",
			},
		}) as HTMLInputElement;

		// File input change handler
		this.fileInput.addEventListener("change", async () => {
			if (this.fileInput?.files) {
				for (const file of Array.from(this.fileInput.files)) {
					await this.addAttachment(file);
				}
				// Reset input so same file can be selected again
				this.fileInput.value = "";
			}
		}, { signal });

		this.messageInput = this.inputContainer.createEl("textarea", {
			cls: "letta-message-input",
			attr: {
				placeholder: "Ask about your vault...",
				rows: "2",
			},
		});

		const buttonContainer = this.inputContainer.createEl("div", {
			cls: "letta-button-container",
		});

		// Attachment button (📎)
		const attachButton = buttonContainer.createEl("button", {
			cls: "letta-attach-button",
			attr: {
				"aria-label": "Attach file",
				"title": "Attach files (images, PDFs, documents)",
			},
		});
		attachButton.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>`;
		attachButton.addEventListener("click", () => {
			this.fileInput?.click();
		}, { signal });

		this.sendButton = buttonContainer.createEl("button", {
			cls: "letta-send-button",
			attr: { "aria-label": "Send message" },
		});
		this.sendButton.createEl("span", { text: "Send" });

		// Event listeners - RAINMAKER FIX: Added signal for cleanup
		// Handle both send and stop actions based on streaming state
		this.sendButton.addEventListener("click", () => {
			if (this.isActivelyStreaming) {
				this.stopStreaming();
			} else {
				this.sendMessage();
			}
		}, { signal });

		// Update status now that all UI elements are created
		this.updateChatStatus();

		this.messageInput.addEventListener("keydown", (evt) => {
			// Handle autocomplete navigation
			if (this.autocompleteDropdown && this.autocompleteDropdown.style.display !== "none") {
				if (evt.key === "ArrowDown") {
					evt.preventDefault();
					this.navigateAutocomplete(1);
					return;
				} else if (evt.key === "ArrowUp") {
					evt.preventDefault();
					this.navigateAutocomplete(-1);
					return;
				} else if (evt.key === "Enter" && this.selectedSuggestionIndex >= 0) {
					evt.preventDefault();
					this.selectCurrentSuggestion();
					return;
				} else if (evt.key === "Escape") {
					evt.preventDefault();
					this.hideAutocomplete();
					return;
				}
			}

			if (evt.key === "Enter" && !evt.shiftKey) {
				evt.preventDefault();
				this.sendMessage();
			}
		}, { signal });

		// Auto-resize textarea and handle @-mentions and /commands
		this.messageInput.addEventListener("input", () => {
			this.messageInput.style.height = "auto";
			this.messageInput.style.height =
				Math.min(this.messageInput.scrollHeight, 80) + "px";

			this.handleAutocompleteInput();
		}, { signal });

		// Handle file paste (images and other files)
		this.messageInput.addEventListener("paste", async (evt) => {
			const clipboardData = evt.clipboardData;
			if (!clipboardData) return;

			const items = clipboardData.items;
			for (let i = 0; i < items.length; i++) {
				const file = items[i].getAsFile();
				if (file) {
					evt.preventDefault();
					await this.addAttachment(file);
				}
			}
		}, { signal });

		// Drag and drop support for the entire chat container
		const chatContainer = this.chatContainer;
		if (chatContainer) {
			// Drag over - show visual feedback
			chatContainer.addEventListener("dragover", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				chatContainer.addClass("letta-drag-over");
			}, { signal });

			// Drag leave - remove visual feedback
			chatContainer.addEventListener("dragleave", (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				// Only remove class if leaving the container (not entering a child)
				const relatedTarget = evt.relatedTarget as HTMLElement;
				if (!chatContainer.contains(relatedTarget)) {
					chatContainer.removeClass("letta-drag-over");
				}
			}, { signal });

			// Drop - handle dropped files
			chatContainer.addEventListener("drop", async (evt) => {
				evt.preventDefault();
				evt.stopPropagation();
				chatContainer.removeClass("letta-drag-over");

				const files = evt.dataTransfer?.files;
				if (files) {
					for (const file of Array.from(files)) {
						await this.addAttachment(file);
					}
				}
			}, { signal });
		}

		// Start with empty chat
	}

	async onClose() {
		// RAINMAKER FIX: Abort all event listeners to prevent memory leaks
		if (this.abortController) {
			this.abortController.abort();
			this.abortController = null;
		}

		// Clean up heartbeat timeout
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
			this.heartbeatTimeout = null;
		}

		// Clean up pending attachments and images
		this.clearPendingAttachments();
	}

	/**
	 * Add a pasted image to the pending images list and show preview
	 */
	async addPastedImage(blob: Blob) {
		const base64 = await this.blobToBase64(blob);
		const mediaType = blob.type; // e.g., "image/png"

		if (!this.imagePreviewContainer) return;

		// Create preview element
		const previewEl = this.imagePreviewContainer.createDiv({
			cls: "letta-image-preview",
		});

		const img = previewEl.createEl("img", {
			cls: "letta-preview-image",
			attr: { src: URL.createObjectURL(blob) },
		});

		const removeBtn = previewEl.createEl("button", {
			cls: "letta-image-remove",
			text: "×",
		});

		const imageData = { blob, base64, mediaType, previewEl };
		this.pendingImages.push(imageData);

		removeBtn.addEventListener("click", () => {
			// Revoke object URL to free memory
			URL.revokeObjectURL(img.src);
			this.pendingImages = this.pendingImages.filter(i => i !== imageData);
			previewEl.remove();
		});
	}

	/**
	 * Convert a Blob to base64 string (without data URL prefix)
	 */
	blobToBase64(blob: Blob): Promise<string> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onload = () => {
				const result = reader.result as string;
				// Remove data URL prefix: "data:image/png;base64,"
				resolve(result.split(",")[1]);
			};
			reader.onerror = reject;
			reader.readAsDataURL(blob);
		});
	}

	/**
	 * Clear all pending images and their previews
	 */
	clearPendingImages() {
		this.pendingImages.forEach(i => {
			// Revoke object URLs to free memory
			const img = i.previewEl.querySelector("img");
			if (img) URL.revokeObjectURL(img.src);
			i.previewEl.remove();
		});
		this.pendingImages = [];
	}

	/**
	 * Add a file attachment (image or document)
	 */
	async addAttachment(file: File) {
		// Check if file type is supported
		if (!FileProcessor.isSupportedType(file)) {
			new Notice(`Unsupported file type: ${file.name}`);
			return;
		}

		const type = FileProcessor.detectFileType(file);

		if (!this.attachmentPreviewContainer) return;

		// Create preview element
		const previewEl = this.attachmentPreviewContainer.createDiv({
			cls: "letta-attachment-preview",
		});

		const attachment: PendingAttachment = {
			file,
			type,
			size: file.size,
			previewEl,
		};

		// Handle based on type
		if (type === 'image') {
			// For images, show thumbnail preview
			const base64 = await this.blobToBase64(file);
			attachment.base64 = base64;

			const img = previewEl.createEl("img", {
				cls: "letta-preview-image",
				attr: { src: URL.createObjectURL(file) },
			});

			// Also add to legacy pendingImages for backward compatibility
			const legacyData = {
				blob: file,
				base64,
				mediaType: file.type,
				previewEl,
			};
			this.pendingImages.push(legacyData);

		} else {
			// For non-images, show file icon and name
			previewEl.addClass("letta-file-preview");

			const iconEl = previewEl.createEl("span", {
				cls: "letta-file-icon",
				text: FileProcessor.getFileIcon(type),
			});

			const infoEl = previewEl.createDiv({ cls: "letta-file-info" });
			infoEl.createEl("span", {
				cls: "letta-file-name",
				text: file.name.length > 20 ? file.name.substring(0, 17) + "..." : file.name,
				attr: { title: file.name },
			});
			infoEl.createEl("span", {
				cls: "letta-file-size",
				text: FileProcessor.formatFileSize(file.size),
			});

			// Show processing indicator
			const processingEl = previewEl.createEl("span", {
				cls: "letta-file-processing",
				text: "...",
			});

			// Extract text in background (including PDFs now!)
			try {
				attachment.extractedText = await FileProcessor.extractText(file, type);
				processingEl.setText("✓");
				processingEl.addClass("letta-file-ready");
			} catch (error) {
				console.error('[Letta] Failed to process file:', error);
				processingEl.setText("⚠");
				processingEl.addClass("letta-file-error");
				processingEl.title = `Error: ${error.message}`;
			}
		}

		// Add remove button
		const removeBtn = previewEl.createEl("button", {
			cls: "letta-attachment-remove",
			text: "×",
			attr: { "aria-label": "Remove attachment" },
		});

		this.pendingAttachments.push(attachment);

		removeBtn.addEventListener("click", () => {
			// Clean up
			const img = previewEl.querySelector("img");
			if (img) URL.revokeObjectURL(img.src);

			this.pendingAttachments = this.pendingAttachments.filter(a => a !== attachment);

			// Also remove from legacy pendingImages if it was an image
			if (type === 'image') {
				this.pendingImages = this.pendingImages.filter(i => i.previewEl !== previewEl);
			}

			previewEl.remove();
		});
	}

	/**
	 * Clear all pending attachments
	 */
	clearPendingAttachments() {
		this.pendingAttachments.forEach(a => {
			const img = a.previewEl.querySelector("img");
			if (img) URL.revokeObjectURL(img.src);
			a.previewEl.remove();
		});
		this.pendingAttachments = [];
		// Also clear legacy images
		this.pendingImages = [];
	}

	/**
	 * Save original file to vault for future custom tool access
	 */
	async saveOriginalToVault(file: File): Promise<string | null> {
		try {
			const folderPath = '_letta_attachments';

			// Ensure folder exists
			let folder = this.plugin.app.vault.getAbstractFileByPath(folderPath);
			if (!folder) {
				await this.plugin.app.vault.createFolder(folderPath);
			}

			// Create unique filename with timestamp
			const timestamp = Date.now();
			const filename = `${timestamp}_${file.name}`;
			const filePath = `${folderPath}/${filename}`;

			// Save file
			const arrayBuffer = await file.arrayBuffer();
			await this.plugin.app.vault.createBinary(filePath, new Uint8Array(arrayBuffer));

			console.log(`[Letta] Saved original file to: ${filePath}`);
			return filePath;
		} catch (error) {
			console.error('[Letta] Failed to save original file:', error);
			return null;
		}
	}

	/**
	 * Upload PDF to Letta folder in background for persistent archival_memory_search
	 * This is fire-and-forget - errors are logged but don't block the user
	 */
	uploadPdfToLettaBackground(file: File): void {
		// Run async but don't await - fire and forget
		(async () => {
			try {
				const folderId = await this.plugin.getOrCreateUploadFolder();
				if (folderId) {
					const success = await this.plugin.uploadFileToFolder(file, folderId);
					if (success) {
						console.log(`[Letta] PDF "${file.name}" uploaded to Letta folder for archival search`);
					}
				}
			} catch (error) {
				console.error('[Letta] Background PDF upload failed (non-blocking):', error);
			}
		})();
	}

	/**
	 * Build message content with attachments
	 */
	async buildMessageWithAttachments(text: string): Promise<{
		content: any[];
		images: Array<{ base64: string; mediaType: string }>;
	}> {
		const content: any[] = [{ type: "text", text }];
		const images: Array<{ base64: string; mediaType: string }> = [];
		const attachmentNotes: string[] = [];

		for (const attachment of this.pendingAttachments) {
			if (attachment.type === 'image' && attachment.base64) {
				// Images: add to multimodal content
				images.push({
					base64: attachment.base64,
					mediaType: attachment.file.type,
				});
			} else if (attachment.type === 'pdf' && attachment.extractedText) {
				// PDFs: use already-extracted text for IMMEDIATE agent access
				const savedPath = await this.saveOriginalToVault(attachment.file);

				// Upload to Letta folder in background (fire-and-forget) for future archival_memory_search
				this.uploadPdfToLettaBackground(attachment.file);

				const textLength = attachment.extractedText.length;
				if (textLength < 10000) {
					// Small PDFs: include full text inline
					attachmentNotes.push(
						`\n---\n**Attached PDF: ${attachment.file.name}**\n\`\`\`\n${attachment.extractedText}\n\`\`\``
					);
					if (savedPath) {
						attachmentNotes.push(`(Original saved at: ${savedPath})`);
					}
				} else {
					// Large PDFs: include excerpt
					attachmentNotes.push(
						`[PDF "${attachment.file.name}" is large (${FileProcessor.formatFileSize(textLength)}). ` +
						`Content excerpt (first 2000 chars):\n\`\`\`\n${attachment.extractedText.substring(0, 2000)}...\n\`\`\`]`
					);
					if (savedPath) {
						attachmentNotes.push(`(Full PDF saved at: ${savedPath})`);
					}
				}
			} else if (attachment.extractedText) {
				// Text/Office files with extracted content
				const textLength = attachment.extractedText.length;

				// Save original for office files
				if (attachment.type.startsWith('office-')) {
					attachment.originalPath = await this.saveOriginalToVault(attachment.file) || undefined;
				}

				if (textLength < 10000) {
					// Small files: include inline
					attachmentNotes.push(
						`\n---\n**Attached file: ${attachment.file.name}**\n\`\`\`\n${attachment.extractedText}\n\`\`\``
					);
					if (attachment.originalPath) {
						attachmentNotes.push(`(Original file saved at: ${attachment.originalPath})`);
					}
				} else {
					// Large files: just note the path
					attachmentNotes.push(
						`[File "${attachment.file.name}" is large (${FileProcessor.formatFileSize(textLength)}). ` +
						`Content excerpt (first 2000 chars):\n\`\`\`\n${attachment.extractedText.substring(0, 2000)}...\n\`\`\`]`
					);
					if (attachment.originalPath) {
						attachmentNotes.push(`(Full file saved at: ${attachment.originalPath} for tool access)`);
					}
				}
			}
		}

		// Append attachment notes to text content
		if (attachmentNotes.length > 0) {
			content[0].text += '\n' + attachmentNotes.join('\n');
		}

		return { content, images };
	}

	/**
	 * Safely render markdown content using Obsidian's built-in MarkdownRenderer
	 */
	async renderMarkdownContent(
		container: HTMLElement,
		content: string,
	): Promise<void> {
		// Clear existing content
		container.empty();

		try {
			// Use Obsidian's built-in markdown renderer
			await MarkdownRenderer.render(
				this.plugin.app,
				content,
				container,
				"", // sourcePath - empty for dynamic content
				new Component(), // Component for lifecycle management
			);
		} catch (error) {
			console.error("Error rendering markdown:", error);
			// Fallback to plain text if markdown rendering fails
			container.textContent = content;
		}
	}

	async addMessage(
		type: "user" | "assistant" | "reasoning" | "tool-call" | "tool-result",
		content: any,
		title?: string,
		reasoningContent?: string,
		images?: Array<{ base64: string; mediaType: string }>,
	) {
		// Adding message to chat interface

		// Extract text content from various possible formats
		let textContent: string = "";

		if (typeof content === "string") {
			textContent = content;
		} else if (Array.isArray(content)) {
			// Handle array content - extract text from array elements
			textContent = content
				.map((item) => {
					if (typeof item === "string") {
						return item;
					} else if (item && typeof item === "object") {
						return (
							item.text ||
							item.content ||
							item.message ||
							item.value ||
							JSON.stringify(item)
						);
					}
					return String(item);
				})
				.join("");
		} else if (content && typeof content === "object") {
			// Try to extract text from object structure
			textContent =
				content.text ||
				content.content ||
				content.message ||
				content.value ||
				"";

			// If still no text found, try JSON stringification as fallback
			if (!textContent && content) {
				console.warn(
					"[Letta Plugin] Content object has no recognizable text field, using JSON fallback:",
					Object.keys(content),
				);
				textContent = JSON.stringify(content, null, 2);
			}
		} else {
			// Last resort: convert to string
			textContent = String(content || "");
		}

		// Text content extracted for display

		// Ensure we have some content to display
		if (!textContent) {
			console.warn("[Letta Plugin] No content to display");
			return;
		}

		// Hide typing indicator when real content arrives
		this.hideTypingIndicator();

		// Clean up previous tool calls when starting a new assistant message
		if (type === "assistant") {
			this.cleanupPreviousToolCalls();
		}
		// Check if this is actually a system_alert that wasn't properly filtered
		if (textContent && textContent.includes('"type": "system_alert"')) {
			// Try to parse and handle as system message instead
			try {
				const parsed = JSON.parse(textContent);
				if (parsed.type === "system_alert") {
					this.addSystemMessage(parsed);
					return null;
				}
			} catch (e) {
				// If parsing fails, continue with regular message handling
				// but log this case for debugging
				console.debug(
					"[Letta Plugin] Failed to parse potential system_alert content:",
					e,
				);
			}
		}

		// Debug: Check for heartbeat content being added as regular message
		if (
			textContent &&
			(textContent.includes('"type": "heartbeat"') ||
				textContent.includes("automated system message") ||
				textContent.includes(
					"Function call failed, returning control",
				) ||
				textContent.includes("request_heartbeat=true"))
		) {
			// Blocked heartbeat content from being displayed
			// Don't add this message - it should have been filtered and handled by typing indicator
			return null;
		}
		// Generate a unique message ID for pagination tracking
		const messageId = `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

		const messageEl = this.chatContainer.createEl("div", {
			cls: `letta-message letta-message-${type}`,
			attr: {
				"data-message-id": messageId,
				"data-timestamp": new Date().toISOString(),
			},
		});

		// Create bubble wrapper
		const bubbleEl = messageEl.createEl("div", {
			cls: "letta-message-bubble",
		});

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});

		// Skip tool messages - they're now handled by addToolInteractionMessage
		if (type === "tool-call" || type === "tool-result") {
			return;
		} else if (type === "reasoning") {
			// Skip standalone reasoning messages - they should be part of assistant messages
			return;
		} else {
			// Regular messages (user/assistant)
			if (title && type !== "user") {
				const headerEl = bubbleEl.createEl("div", {
					cls: "letta-message-header",
				});

				// Left side: title and timestamp
				const leftSide = headerEl.createEl("div", {
					cls: "letta-message-header-left",
				});

				// Remove emojis from titles
				let cleanTitle = title.replace(/🤖|👤|🚨|✅|❌|🔌/g, "").trim();
				leftSide.createEl("span", {
					cls: "letta-message-title",
					text: cleanTitle,
				});
				leftSide.createEl("span", {
					cls: "letta-message-timestamp",
					text: timestamp,
				});

				// Right side: reasoning button if reasoning content exists
				if (type === "assistant" && reasoningContent) {
					const reasoningBtn = headerEl.createEl("button", {
						cls: "letta-reasoning-btn letta-reasoning-collapsed",
						text: "⋯",
					});

					// Add click handler for reasoning toggle
					reasoningBtn.addEventListener("click", (e) => {
						e.stopPropagation();
						const isCollapsed = reasoningBtn.classList.contains(
							"letta-reasoning-collapsed",
						);
						if (isCollapsed) {
							reasoningBtn.removeClass(
								"letta-reasoning-collapsed",
							);
							reasoningBtn.addClass("letta-reasoning-expanded");
						} else {
							reasoningBtn.addClass("letta-reasoning-collapsed");
							reasoningBtn.removeClass(
								"letta-reasoning-expanded",
							);
						}

						// Toggle reasoning content visibility
						const reasoningEl = bubbleEl.querySelector(
							".letta-reasoning-content",
						);
						if (reasoningEl) {
							reasoningEl.classList.toggle(
								"letta-reasoning-visible",
							);
						}
					});
				}
			}

			// Add reasoning content if provided (for assistant messages)
			if (type === "assistant" && reasoningContent) {
				const reasoningEl = bubbleEl.createEl("div", {
					cls: "letta-reasoning-content",
				});

				// Enhanced markdown-like formatting for reasoning
				let formattedReasoning = reasoningContent
					// Trim leading and trailing whitespace first
					.trim()
					// Normalize multiple consecutive newlines to double newlines
					.replace(/\n{3,}/g, "\n\n")
					// Handle headers (must be done before other formatting)
					.replace(/^### (.+)$/gm, "<h3>$1</h3>")
					.replace(/^## (.+)$/gm, "<h2>$1</h2>")
					.replace(/^# (.+)$/gm, "<h1>$1</h1>")
					// Handle bold and italic
					.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
					.replace(/\*(.*?)\*/g, "<em>$1</em>")
					.replace(/`([^`]+)`/g, "<code>$1</code>")
					// Handle numbered lists (1. 2. 3. etc.)
					.replace(
						/^(\d+)\.\s+(.+)$/gm,
						'<li class="numbered-list">$2</li>',
					)
					// Handle bullet lists (•, -, *)
					.replace(/^[•*-]\s+(.+)$/gm, "<li>$1</li>")
					// Handle double newlines as paragraph breaks first
					.replace(/\n\n/g, "</p><p>")
					// Convert remaining single newlines to <br> tags
					.replace(/\n/g, "<br>");

				// Wrap consecutive numbered list items in <ol> tags
				formattedReasoning = formattedReasoning.replace(
					/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g,
					(match) => {
						// Remove the <br> tags between numbered list items and wrap in <ol>
						const cleanMatch = match.replace(/<br>\s*/g, "");
						return "<ol>" + cleanMatch + "</ol>";
					},
				);

				// Wrap consecutive regular list items in <ul> tags
				formattedReasoning = formattedReasoning.replace(
					/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g,
					(match) => {
						// Remove the <br> tags between list items and wrap in <ul>
						const cleanMatch = match.replace(/<br>\s*/g, "");
						return "<ul>" + cleanMatch + "</ul>";
					},
				);

				// Wrap in paragraphs if needed
				if (
					formattedReasoning.includes("</p><p>") &&
					!formattedReasoning.startsWith("<")
				) {
					formattedReasoning = "<p>" + formattedReasoning + "</p>";
				}

				reasoningEl.innerHTML = formattedReasoning;
			}

			// Handle collapsible user messages
			if (type === "user" && textContent.length > 200) {
				// Create container for collapsible content
				const contentContainer = bubbleEl.createEl("div", {
					cls: "letta-user-message-container",
				});

				// Create preview content (first 200 characters)
				const previewContent =
					textContent.substring(0, 200).trim() + "...";
				const previewEl = contentContainer.createEl("div", {
					cls: "letta-message-content letta-user-message-preview",
				});
				previewEl.textContent = previewContent;

				// Create full content (initially hidden)
				const fullContentEl = contentContainer.createEl("div", {
					cls: "letta-message-content letta-user-message-full letta-user-message-collapsed",
				});
				// Use robust markdown rendering instead of innerHTML
				await this.renderMarkdownContent(fullContentEl, textContent);

				// Create expand/collapse button
				const expandBtn = contentContainer.createEl("button", {
					cls: "letta-user-message-toggle",
					text: "See more",
				});

				// Add click handler for expand/collapse
				expandBtn.addEventListener("click", (e) => {
					e.stopPropagation();
					const isCollapsed = fullContentEl.classList.contains(
						"letta-user-message-collapsed",
					);

					if (isCollapsed) {
						// Expand: hide preview, show full content
						previewEl.addClass("letta-user-message-preview-hidden");
						fullContentEl.removeClass(
							"letta-user-message-collapsed",
						);
						expandBtn.textContent = "See less";
					} else {
						// Collapse: show preview, hide full content
						previewEl.removeClass(
							"letta-user-message-preview-hidden",
						);
						fullContentEl.addClass("letta-user-message-collapsed");
						expandBtn.textContent = "See more";
					}
				});

				// Display attached images for user messages
				if (images && images.length > 0) {
					const imageContainer = contentContainer.createEl("div", {
						cls: "letta-message-images",
					});
					for (const img of images) {
						imageContainer.createEl("img", {
							cls: "letta-message-image",
							attr: { src: `data:${img.mediaType};base64,${img.base64}` },
						});
					}
				}
			} else {
				// Regular content for short messages or non-user messages
				const contentEl = bubbleEl.createEl("div", {
					cls: "letta-message-content",
				});
				// Use robust markdown rendering instead of innerHTML
				await this.renderMarkdownContent(contentEl, textContent);

				// Display attached images for user messages
				if (type === "user" && images && images.length > 0) {
					const imageContainer = bubbleEl.createEl("div", {
						cls: "letta-message-images",
					});
					for (const img of images) {
						imageContainer.createEl("img", {
							cls: "letta-message-image",
							attr: { src: `data:${img.mediaType};base64,${img.base64}` },
						});
					}
				}

				// Add action buttons for assistant messages (copy, feedback)
				if (type === "assistant") {
					const actionsEl = bubbleEl.createEl("div", {
						cls: "letta-message-actions",
					});

					// Copy button
					const copyBtn = actionsEl.createEl("button", {
						cls: "letta-action-btn letta-copy-btn",
						attr: { "aria-label": "Copy as markdown", "title": "Copy" },
					});
					copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;

					copyBtn.addEventListener("click", async (e) => {
						e.stopPropagation();
						try {
							await navigator.clipboard.writeText(textContent);
							copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>`;
							copyBtn.addClass("letta-action-success");
							setTimeout(() => {
								copyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
								copyBtn.removeClass("letta-action-success");
							}, 2000);
						} catch (err) {
							console.error("Failed to copy:", err);
							new Notice("Failed to copy to clipboard");
						}
					});

					// Thumbs up button
					const thumbsUpBtn = actionsEl.createEl("button", {
						cls: "letta-action-btn letta-feedback-btn",
						attr: { "aria-label": "Good response", "title": "Good response" },
					});
					thumbsUpBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path></svg>`;

					thumbsUpBtn.addEventListener("click", async (e) => {
						e.stopPropagation();
						if (thumbsUpBtn.classList.contains("letta-feedback-selected")) return;

						// Visual feedback
						thumbsUpBtn.addClass("letta-feedback-selected", "letta-feedback-positive");
						thumbsDownBtn.removeClass("letta-feedback-selected", "letta-feedback-negative");

						// Send feedback to agent
						await this.sendFeedbackToAgent("positive", textContent);
						new Notice("Thanks for the feedback!");
					});

					// Thumbs down button
					const thumbsDownBtn = actionsEl.createEl("button", {
						cls: "letta-action-btn letta-feedback-btn",
						attr: { "aria-label": "Poor response", "title": "Poor response" },
					});
					thumbsDownBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path></svg>`;

					thumbsDownBtn.addEventListener("click", async (e) => {
						e.stopPropagation();
						if (thumbsDownBtn.classList.contains("letta-feedback-selected")) return;

						// Visual feedback
						thumbsDownBtn.addClass("letta-feedback-selected", "letta-feedback-negative");
						thumbsUpBtn.removeClass("letta-feedback-selected", "letta-feedback-positive");

						// Send feedback to agent
						await this.sendFeedbackToAgent("negative", textContent);
						new Notice("Thanks for the feedback!");
					});
				}
			}
		}

		// Animate message appearance
		messageEl.addClass("letta-message-entering");
		setTimeout(() => {
			messageEl.removeClass("letta-message-entering");
			messageEl.addClass("letta-message-entered");
		}, 50);

		// Scroll to bottom with smooth animation
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 100);
	}

	async clearChat() {
		this.chatContainer.empty();
		// Update status to show disconnected message if not connected
		await this.updateChatStatus();
	}

	async loadHistoricalMessages(options?: { loadMore?: boolean; forceRefresh?: boolean }) {
		// RAINMAKER FIX: Prevent concurrent message loads
		if (this.isLoadingMessages) {
			console.log("[Letta Plugin] Message load already in progress, skipping");
			return;
		}

		// Only load if we're connected and chat container exists
		if (!this.plugin.agent || !this.chatContainer) {
			return;
		}

		const loadMore = options?.loadMore || false;
		const forceRefresh = options?.forceRefresh || false;

		// Check if we already have messages (don't reload on every status update, unless loading more or forcing refresh)
		if (!loadMore && !forceRefresh) {
			const existingMessages =
				this.chatContainer.querySelectorAll(".letta-message");
			if (existingMessages.length > 0) {
				return;
			}
		}

		// RAINMAKER FIX: Set loading flag
		this.isLoadingMessages = true;

		try {
			const agentId = this.plugin.agent.id;
			const cacheManager = this.plugin.cacheManager;

			if (loadMore) {
				// Load older messages using cache manager
				const olderMessages = await cacheManager.loadOlderMessages(agentId);

				if (olderMessages.length > 0) {
					// Extract raw messages and sort
					const rawMessages = olderMessages.map(m => m.raw);
					const sortedMessages = rawMessages.sort(
						(a: any, b: any) =>
							new Date(a.date).getTime() - new Date(b.date).getTime(),
					);
					await this.prependMessages(sortedMessages);
				}

				// Check if more older messages exist
				const cache = cacheManager.getCache(agentId);
				if (cache?.hasMoreOlder) {
					this.showLoadMoreButton();
				} else {
					this.removeLoadMoreButton();
				}
			} else {
				// Initial load or refresh - use smart caching
				const cachedMessages = await cacheManager.smartLoad(agentId, forceRefresh);

				if (!cachedMessages || cachedMessages.length === 0) {
					// Show welcome message for new conversations
					await this.addMessage(
						"assistant",
						`Ready to chat with **${this.plugin.agent.name}**. How can I help you today?`,
						"System",
					);
					return;
				}

				// Filter out any obviously malformed messages before processing
				const validMessages = cachedMessages.filter((msg: CachedMessage) => {
					if (!msg || !msg.raw) return false;
					const messageType = msg.message_type;
					if (!messageType) {
						console.warn(
							"[Letta Plugin] Message missing type field:",
							msg.raw,
						);
						return false;
					}
					return true;
				});

				if (validMessages.length === 0) {
					return;
				}

				// Extract raw messages (already sorted by cache manager)
				const rawMessages = validMessages.map(m => m.raw);

				// Process messages normally (append)
				await this.processMessagesInGroups(rawMessages);

				// Check if more older messages exist
				const cache = cacheManager.getCache(agentId);
				if (cache?.hasMoreOlder) {
					this.showLoadMoreButton();
				} else {
					this.removeLoadMoreButton();
				}
			}
		} catch (error: any) {
			console.error(
				"[Letta Plugin] Failed to load historical messages:",
				error,
			);
			// Show a minimal error message for malformed data issues
			if (
				error.message &&
				error.message.includes("missing message argument")
			) {
				await this.addMessage(
					"assistant",
					"Some messages in your conversation history could not be loaded due to data issues. New messages will work normally.",
					"System",
				);
			}
		} finally {
			// RAINMAKER FIX: Always reset loading flag
			this.isLoadingMessages = false;
		}
	}

	// Get the oldest message ID for pagination
	getOldestMessageId(): string | undefined {
		const messages = this.chatContainer.querySelectorAll("[data-message-id]");
		if (messages.length === 0) return undefined;
		return messages[0].getAttribute("data-message-id") || undefined;
	}

	// Show "Load Earlier Messages" button
	showLoadMoreButton(): void {
		if (this.loadMoreButton) return;

		this.loadMoreButton = document.createElement("div");
		this.loadMoreButton.className = "letta-load-more";

		const btn = document.createElement("button");
		btn.className = "letta-load-more-btn";
		btn.textContent = "Load Earlier Messages";
		btn.addEventListener("click", async () => {
			this.removeLoadMoreButton();
			await this.loadHistoricalMessages({ loadMore: true });
		});

		this.loadMoreButton.appendChild(btn);

		// Insert at top of chat container
		this.chatContainer.insertBefore(this.loadMoreButton, this.chatContainer.firstChild);
	}

	// Remove the load more button
	removeLoadMoreButton(): void {
		if (this.loadMoreButton) {
			this.loadMoreButton.remove();
			this.loadMoreButton = null;
		}
	}

	// Prepend older messages to the chat (for pagination)
	async prependMessages(messages: any[]): Promise<void> {
		// Save scroll position
		const scrollPos = this.chatContainer.scrollTop;
		const scrollHeight = this.chatContainer.scrollHeight;

		// Create a temporary container for the old messages
		const tempContainer = document.createElement("div");

		// Process messages into temp container
		for (const msg of messages) {
			const messageEl = await this.createMessageElement(msg);
			if (messageEl) {
				tempContainer.appendChild(messageEl);
			}
		}

		// Insert all prepended messages after the load more button (or at the start)
		const insertPoint = this.loadMoreButton?.nextSibling || this.chatContainer.firstChild;
		while (tempContainer.firstChild) {
			this.chatContainer.insertBefore(tempContainer.firstChild, insertPoint);
		}

		// Restore scroll position (keep user at same visual position)
		const newScrollHeight = this.chatContainer.scrollHeight;
		this.chatContainer.scrollTop = scrollPos + (newScrollHeight - scrollHeight);
	}

	// Create a single message element (for prepending)
	async createMessageElement(msg: any): Promise<HTMLElement | null> {
		const messageType = msg.message_type || msg.type;
		const messageId = msg.id || `msg-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

		// Skip system messages
		if (messageType === "system_message" || messageType === "system") {
			return null;
		}

		// Create wrapper element
		const wrapper = document.createElement("div");

		// Handle based on message type
		if (messageType === "user_message" || messageType === "user") {
			const content = msg.content || msg.message?.content || "";
			if (content.trim()) {
				const el = document.createElement("div");
				el.className = "letta-message letta-message-user";
				el.setAttribute("data-message-id", messageId);
				el.setAttribute("data-timestamp", msg.date || new Date().toISOString());

				const contentEl = document.createElement("div");
				contentEl.className = "letta-message-content";
				contentEl.textContent = content;
				el.appendChild(contentEl);

				wrapper.appendChild(el);
			}
		} else if (messageType === "assistant_message" || messageType === "assistant") {
			const content = msg.content || msg.message?.content || "";
			if (content.trim()) {
				const filteredContent = this.filterSystemPromptContent(content);
				if (filteredContent.trim()) {
					const el = document.createElement("div");
					el.className = "letta-message letta-message-assistant";
					el.setAttribute("data-message-id", messageId);
					el.setAttribute("data-timestamp", msg.date || new Date().toISOString());

					const contentEl = document.createElement("div");
					contentEl.className = "letta-message-content";
					await MarkdownRenderer.renderMarkdown(
						filteredContent,
						contentEl,
						"",
						new Component()
					);
					el.appendChild(contentEl);

					wrapper.appendChild(el);
				}
			}
		} else if (messageType === "reasoning_message" || messageType === "reasoning") {
			// Skip reasoning messages in prepended history for cleaner view
			// (they're shown in real-time streaming but not needed in history)
			return null;
		}

		return wrapper.children.length > 0 ? wrapper.firstChild as HTMLElement : null;
	}

	// Filter out system prompt content that shouldn't be shown to users
	filterSystemPromptContent(content: string): string {
		if (!content) return content;

		// Patterns that indicate system prompt leakage
		const systemPromptPatterns = [
			/<control_flow>/i,
			/<basic_functions>/i,
			/<context_instructions>/i,
			/<memory_editing>/i,
			/<memory_tools>/i,
			/program again after the function completes/i,
			/inner monologue.*private to you only/i,
			/Older AI models had no concept of persistent memory/i,
			/conversation with a user.*their.*acti/i,
			/active memory/i,
			/persistent memory/i,
			/context window/i,
			/overflow.*old messages.*permanently lost/i,
			/sentient being/i,
			/real-time.*conscious awareness/i,
			// File system information patterns
			/\*\*Currently Open Files.*Based on my current system access/i,
			/\*\*Available Directories:\*\*/i,
			/obsidian-vault-files.*directory structure preserved/i,
			/using folder paths/i,
			/\*\*File System Notes:\*\*/i,
			/I can open up to \d+ files/i,
			// Repeated content patterns
			/(.*)\1{2,}/s, // Catches content repeated 3+ times
		];

		// Check for repeated content blocks (specific to file system info spam)
		if (
			content.includes("**Currently Open Files") &&
			content.includes("Based on my current system access")
		) {
			const matches = content.match(
				/\*\*Currently Open Files.*?(?=\*\*Currently Open Files|\*\*Available Directories|$)/gs,
			);
			if (matches && matches.length > 1) {
				// Detected repeated file system information, filtering out
				return "I can see your vault files and am ready to help with your question.";
			}
		}

		// Check if content contains system prompt patterns
		const hasSystemContent = systemPromptPatterns.some((pattern) =>
			pattern.test(content),
		);

		if (hasSystemContent) {
			// Content contains system patterns, attempting selective filtering

			// Try more selective filtering - only remove lines that are clearly system instructions
			const lines = content.split("\n");
			const filteredLines = lines.filter((line) => {
				const trimmed = line.trim();
				if (!trimmed) return false; // Remove empty lines

				// Only remove lines that match very specific system patterns
				const isSystemLine = systemPromptPatterns.some((pattern) => {
					const match = pattern.test(trimmed);
					if (match) {
						// console.log('[Letta Plugin] Filtering system line:', trimmed);
					}
					return match;
				});

				// Keep lines that don't match system patterns and don't look like XML tags
				return (
					!isSystemLine &&
					!trimmed.includes("<") &&
					!trimmed.includes(">")
				);
			});

			const filtered = filteredLines.join("\n").trim();

			// Only use fallback if we have very little content left (less than 10 characters)
			if (!filtered || filtered.length < 10) {
				// Minimal content after filtering, using original response
				// Return original content instead of placeholder
				// Comprehensive escape handling
				return this.processEscapeSequences(content);
			}

			// Comprehensive escape handling
			return this.processEscapeSequences(filtered);
		}

		// Comprehensive escape handling
		return this.processEscapeSequences(content);
	}

	// Process common escape sequences in content
	processEscapeSequences(content: string): string {
		if (!content) return content;

		return content
			// Handle escaped newlines
			.replace(/\\n/g, "\n")
			// Handle newline-dash patterns (common in lists)
			.replace(/\\n-/g, "\n- ")
			// Handle escaped tabs
			.replace(/\\t/g, "\t")
			// Handle escaped quotes
			.replace(/\\"/g, '"')
			.replace(/\\'/g, "'")
			// Handle escaped backslashes
			.replace(/\\\\/g, "\\")
			// Handle literal \n- patterns that might appear in text
			.replace(/\\n\s*-/g, "\n- ")
			// Clean up any double newlines created
			.replace(/\n{3,}/g, "\n\n");
	}

	// Format tool results with JSON pretty-printing when possible
	formatToolResult(toolResult: string): string {
		if (!toolResult) return toolResult;

		try {
			// Try to parse as JSON first
			const parsed = JSON.parse(toolResult);
			// If successful, return pretty-printed JSON
			return JSON.stringify(parsed, null, 2);
		} catch (e) {
			// If not valid JSON, check if it's a repr-style string (quoted with escapes)
			let formatted = toolResult;

			// Check if it's wrapped in quotes like a Python repr string
			if (formatted.startsWith('"') && formatted.endsWith('"')) {
				try {
					// Try to parse it as a JSON string to handle escapes properly
					formatted = JSON.parse(formatted);
				} catch (parseError) {
					// If JSON parsing fails, manually remove outer quotes and process escapes
					formatted = formatted.slice(1, -1);

					// Handle escaped newlines
					formatted = formatted.replace(/\\n/g, "\n");

					// Handle escaped quotes
					formatted = formatted.replace(/\\"/g, '"');

					// Handle escaped backslashes
					formatted = formatted.replace(/\\\\/g, "\\");
				}
			} else {
				// Handle escaped sequences even without quotes
				formatted = formatted.replace(/\\n/g, "\n");
				formatted = formatted.replace(/\\"/g, '"');
				formatted = formatted.replace(/\\\\/g, "\\");
			}

			// Clean up extensive === separators - replace long chains with simple dividers
			formatted = formatted.replace(/={10,}/g, "---\n");

			// Clean up any remaining === separators at start/end
			formatted = formatted
				.replace(/^===+\s*/, "")
				.replace(/\s*===+$/, "");

			// Clean up multiple consecutive newlines
			formatted = formatted.replace(/\n{3,}/g, "\n\n");

			return formatted.trim();
		}
	}

	// Add a clean, centered rate limiting notification
	addRateLimitMessage(content: string) {
		// console.log('[Letta Plugin] Adding rate limit message:', content);
		const messageEl = this.chatContainer.createEl("div", {
			cls: "letta-rate-limit-message",
		});

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
		const timeEl = messageEl.createEl("div", {
			cls: "letta-rate-limit-timestamp",
			text: timestamp,
		});

		// Add content without markdown processing for clean display
		const contentEl = messageEl.createEl("div", {
			cls: "letta-rate-limit-content",
		});

		// Process the content to extract the main message and links
		const lines = content.split("\n");
		let mainMessage = "";
		let billingLink = "";
		let customKeysLink = "";

		for (const line of lines) {
			if (
				line.includes(
					"https://app.letta.com/settings/organization/billing",
				)
			) {
				billingLink = line.trim();
			} else if (
				line.includes("https://docs.letta.com/guides/cloud/custom-keys")
			) {
				customKeysLink = line.trim();
			} else if (
				line.trim() &&
				!line.includes("Need more?") &&
				!line.includes("Or bring your own")
			) {
				if (mainMessage) mainMessage += " ";
				mainMessage += line.replace(/[⚠️*]/g, "").trim();
			}
		}

		// Add main message
		if (mainMessage) {
			const msgEl = contentEl.createEl("div", {
				cls: "letta-rate-limit-main",
				text: mainMessage,
			});
		}

		// Add billing link if present
		if (billingLink) {
			const linkEl = contentEl.createEl("div", {
				cls: "letta-rate-limit-link",
			});
			const link = linkEl.createEl("a", {
				href: billingLink,
				text: "Upgrade to Pro, Scale, or Enterprise",
				cls: "letta-rate-limit-upgrade-link",
			});
			link.setAttribute("target", "_blank");
		}

		// Add "or" separator if both links are present
		if (billingLink && customKeysLink) {
			const orEl = contentEl.createEl("div", {
				cls: "letta-rate-limit-separator",
				text: "or",
			});
			orEl.style.cssText =
				"text-align: center; margin: 8px 0; color: var(--text-muted); font-size: 0.9em;";
		}

		// Add custom keys link if present
		if (customKeysLink) {
			const linkEl = contentEl.createEl("div", {
				cls: "letta-rate-limit-link",
			});
			const link = linkEl.createEl("a", {
				href: customKeysLink,
				text: "Learn about bringing your own inference provider",
				cls: "letta-rate-limit-upgrade-link",
			});
			link.setAttribute("target", "_blank");
		}

		// Scroll to bottom
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}

	async processMessagesInGroups(messages: any[]) {
		let currentReasoning = "";
		let currentToolCallMessage: HTMLElement | null = null;
		let currentToolName = "";
		let currentToolCallData: any = null;

		for (const message of messages) {
			try {
				// Skip system messages as they're internal
				if (
					message.message_type === "system_message" ||
					message.type === "system_message"
				) {
					continue;
				}

				// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
				if (
					message.type === "system_alert" ||
					(message.message &&
						typeof message.message === "string" &&
						message.message.includes(
							"prior messages have been hidden",
						))
				) {
					// Capturing historical system_alert message
					this.addSystemMessage(message);
					continue;
				}

				if (
					message.type === "heartbeat" ||
					message.message_type === "heartbeat"
				) {
					continue;
				}

				// Filter out login messages - check both direct type and content containing login JSON
				if (
					message.type === "login" ||
					message.message_type === "login"
				) {
					continue;
				}

				// Check if this is a user_message containing login JSON
				if (
					(message.message_type === "user_message" ||
						message.messageType === "user_message") &&
					message.content &&
					typeof message.content === "string"
				) {
					try {
						const parsedContent = JSON.parse(
							message.content.trim(),
						);
						if (parsedContent.type === "login") {
							continue;
						}
					} catch (e) {
						// Not JSON, continue processing normally
					}
				}

				const messageType = message.message_type || message.type;
				// Processing historical message

				// Validate message has required fields based on type
				if (!this.validateMessageStructure(message, messageType)) {
					console.warn(
						"[Letta Plugin] Skipping malformed message:",
						message,
					);
					await this.addErrorMessage(
						`Malformed ${messageType || "unknown"} message`,
						message,
					);
					continue;
				}

				switch (messageType) {
					case "user_message":
						if (message.content || message.text) {
							await this.addMessage(
								"user",
								message.text || message.content || "",
							);
						}
						break;

					case "reasoning_message":
						if (message.reasoning) {
							// Don't display reasoning as standalone message - only accumulate for next assistant message
							currentReasoning += message.reasoning;
						}
						break;

					case "tool_call_message":
						if (message.tool_call) {
							// Extract and store the tool name and data for later use with tool result
							currentToolName =
								message.tool_call.name ||
								(message.tool_call.function &&
									message.tool_call.function.name) ||
								"";
							currentToolCallData = message.tool_call;

							// Create tool interaction with reasoning and wait for tool result
							currentToolCallMessage =
								this.addToolInteractionMessage(
									currentReasoning,
									JSON.stringify(message.tool_call, null, 2),
								);
							// Clear reasoning after using it
							currentReasoning = "";
						}
						break;

					case "tool_return_message":
						if (message.tool_return && currentToolCallMessage) {
							// Add tool result to the existing tool interaction message with tool name and data
							await this.addToolResultToMessage(
								currentToolCallMessage,
								JSON.stringify(message.tool_return, null, 2),
								currentToolName,
								currentToolCallData,
							);
							// Clear the current tool call message reference, tool name, and data
							currentToolCallMessage = null;
							currentToolName = "";
							currentToolCallData = null;
						}
						break;

					case "assistant_message":
						if (message.content || message.text) {
							// Filter out system prompt content and use accumulated reasoning
							const rawContent =
								message.content || message.text || "";
							const filteredContent =
								this.filterSystemPromptContent(rawContent);
							await this.addMessage(
								"assistant",
								filteredContent,
								this.plugin.settings.agentName,
								currentReasoning || undefined,
							);
							// Clear reasoning after using it
							currentReasoning = "";
						}
						break;

					case "approval_request_message":
						// DISABLED: Approval handling commented out due to upstream API issues
						// console.log("[Letta Plugin] Found historical approval_request_message:", message);
						// await this.handleApprovalRequest(message);
						break;

					default:
					// Unknown historical message type
				}
			} catch (error) {
				console.error(
					"[Letta Plugin] Error processing message:",
					error,
					message,
				);
				await this.addErrorMessage(
					`Error processing ${message?.message_type || message?.type || "unknown"} message`,
					{ error: error.message, message },
				);
			}
		}
	}

	// Validate message structure based on type
	validateMessageStructure(message: any, messageType: string): boolean {
		if (!message) return false;

		switch (messageType) {
			case "user_message":
				return !!(message.content || message.text);
			case "assistant_message":
				return !!(message.content || message.text);
			case "reasoning_message":
				return !!message.reasoning;
			case "tool_call_message":
				return !!message.tool_call;
			case "tool_return_message":
				return !!message.tool_return;
			default:
				// For unknown types, just check if it's not null/undefined
				return true;
		}
	}

	// Add error message for malformed messages
	async addErrorMessage(title: string, data: any) {
		const errorContent = `${title} - This message had invalid data and was skipped.`;
		await this.addMessage("assistant", errorContent, "System");
	}

	async displayHistoricalMessage(message: any) {
		// Processing historical message

		// Handle system messages - capture system_alert for hidden viewing, skip heartbeats entirely
		// Check multiple possible properties where the type might be stored
		const messageType = message.type || message.message_type;
		const messageRole = message.role;
		const messageReason = message.reason || "";
		const hasHeartbeatContent =
			messageReason.includes("automated system message") ||
			messageReason.includes("Function call failed, returning control") ||
			messageReason.includes("request_heartbeat=true");

		// Store system_alert messages in hidden container for debugging
		if (
			messageType === "system_alert" ||
			(message.message &&
				typeof message.message === "string" &&
				message.message.includes("prior messages have been hidden"))
		) {
			// Capturing system_alert message
			this.addSystemMessage(message);
			return;
		}

		// Skip heartbeat messages entirely
		if (
			messageType === "heartbeat" ||
			message.message_type === "heartbeat" ||
			messageRole === "heartbeat" ||
			hasHeartbeatContent ||
			(message.content &&
				typeof message.content === "string" &&
				(message.content.includes("automated system message") ||
					message.content.includes(
						"Function call failed, returning control",
					) ||
					message.content.includes("request_heartbeat=true"))) ||
			(message.text &&
				typeof message.text === "string" &&
				(message.text.includes("automated system message") ||
					message.text.includes(
						"Function call failed, returning control",
					) ||
					message.text.includes("request_heartbeat=true")))
		) {
			// Skipping historical heartbeat message
			return;
		}

		// Filter out login messages - check both direct type and content containing login JSON
		if (
			messageType === "login" ||
			message.message_type === "login" ||
			messageRole === "login"
		) {
			return;
		}

		// Check if this is a user_message containing login JSON
		if (
			(message.message_type === "user_message" ||
				message.messageType === "user_message") &&
			message.content &&
			typeof message.content === "string"
		) {
			try {
				const parsedContent = JSON.parse(message.content.trim());
				if (parsedContent.type === "login") {
					return;
				}
			} catch (e) {
				// Not JSON, continue processing normally
			}
		}

		// Parse different message types based on Letta's message structure
		switch (message.message_type) {
			case "user_message":
				if (message.text || message.content) {
					await this.addMessage(
						"user",
						message.text || message.content || "",
					);
				}
				break;

			case "reasoning_message":
				// Reasoning messages are now handled by processMessagesInGroups
				break;

			case "tool_call_message":
				// Tool call messages are now handled by processMessagesInGroups
				break;

			case "tool_return_message":
				// Tool return messages are now handled by processMessagesInGroups
				break;

			case "assistant_message":
				if (message.content || message.text) {
					// Filter out system prompt content
					const rawContent = message.content || message.text || "";
					const filteredContent =
						this.filterSystemPromptContent(rawContent);
					await this.addMessage(
						"assistant",
						filteredContent,
						this.plugin.settings.agentName,
					);
				}
				break;

			case "system_message":
				// Skip system messages as they're internal
				break;

			case "heartbeat":
				// Handle heartbeat messages - show typing indicator
				this.handleHeartbeat();
				break;

			default:
				// Handle unrecognized message types - log and skip to prevent display
				// Unrecognized historical message type
				break;
		}
	}

	addMessageSeparator(text: string) {
		const separatorEl = this.chatContainer.createEl("div", {
			cls: "letta-message-separator",
		});
		separatorEl.createEl("span", { text, cls: "letta-separator-text" });
	}

	addSystemMessage(message: any) {
		// Create system message using the same separator style as "Previous conversation history"
		const separatorEl = this.chatContainer.createEl("div", {
			cls: "letta-message-separator letta-system-message-separator",
		});
		// Hidden by default - can be toggled via settings or UI control

		// Create clickable separator text
		const separatorText = separatorEl.createEl("span", {
			text: "memory update",
			cls: "letta-separator-text letta-system-separator-text",
		});
		separatorText.style.cursor = "pointer";
		separatorText.style.userSelect = "none";

		// Create expandable content container (hidden initially)
		const expandedContent = this.chatContainer.createEl("div", {
			cls: "letta-system-expanded-content",
		});
		expandedContent.style.cssText =
			"display: none; background: var(--background-secondary); border: 1px solid var(--background-modifier-border); border-radius: 4px; padding: 12px; margin: 8px 0; font-size: 12px; line-height: 1.4;";

		// For system_alert messages, show the readable content
		if (message.type === "system_alert" && message.message) {
			const messageEl = expandedContent.createEl("div", {
				text: message.message,
				cls: "letta-system-content",
			});
			messageEl.style.cssText =
				"color: var(--text-normal); white-space: pre-wrap; margin-bottom: 8px;";
		}

		// Add a subtle "click to collapse" hint when expanded
		const collapseHint = expandedContent.createEl("div", {
			text: 'Click "System Message" above to collapse',
			cls: "letta-system-collapse-hint",
		});
		collapseHint.style.cssText =
			"font-size: 10px; color: var(--text-muted); margin-top: 8px; font-style: italic;";

		// Toggle functionality
		let isExpanded = false;
		separatorText.addEventListener("click", () => {
			isExpanded = !isExpanded;
			expandedContent.style.display = isExpanded ? "block" : "none";

			if (isExpanded) {
				// Scroll to keep the expanded content visible
				expandedContent.scrollIntoView({
					behavior: "smooth",
					block: "nearest",
				});
			}
		});

		// Auto-scroll to show the new system message separator
		this.chatContainer.scrollTop = this.chatContainer.scrollHeight;
	}

	showTypingIndicator() {
		if (this.typingIndicator && this.chatContainer) {
			// Update text to reflect current agent name
			this.updateTypingIndicatorText();
			// Move typing indicator to end of chat container so it appears after messages
			this.chatContainer.appendChild(this.typingIndicator);
			this.typingIndicator.removeClass("letta-typing-hidden");
			this.typingIndicator.addClass("letta-typing-visible");
			// Scroll to bottom to show the typing indicator
			this.typingIndicator.scrollIntoView({ behavior: "smooth", block: "end" });
		}
	}

	hideTypingIndicator() {
		if (this.typingIndicator) {
			this.typingIndicator.removeClass("letta-typing-visible");
			this.typingIndicator.addClass("letta-typing-hidden");
		}
	}

	updateTypingIndicatorText() {
		if (this.typingIndicator) {
			const typingTextEl = this.typingIndicator.querySelector('.letta-typing-text');
			if (typingTextEl) {
				// Show contextual status based on streaming phase
				let statusText = `${this.plugin.settings.agentName} is thinking`;

				if (this.isActivelyStreaming) {
					switch (this.streamingPhase) {
						case 'reasoning':
							statusText = `${this.plugin.settings.agentName} is reasoning`;
							break;
						case 'generating':
							statusText = `${this.plugin.settings.agentName} is responding`;
							break;
						case 'tool_call':
							if (this.currentToolCallNameForStatus) {
								// Format tool name for display (e.g., search_vault -> "Search Vault")
								const toolDisplayName = this.currentToolCallNameForStatus
									.replace(/_/g, ' ')
									.replace(/\b\w/g, c => c.toUpperCase());
								statusText = `Running ${toolDisplayName}...`;
							} else {
								statusText = `${this.plugin.settings.agentName} is using a tool`;
							}
							break;
						default:
							statusText = `${this.plugin.settings.agentName} is thinking`;
					}

					// Add step and token info if available
					const stats: string[] = [];
					if (this.streamingStepCount > 0) {
						stats.push(`Step ${this.streamingStepCount}`);
					}
					if (this.streamingTokenEstimate > 0) {
						stats.push(`${this.streamingTokenEstimate} tokens`);
					}
					if (stats.length > 0) {
						statusText += ` (${stats.join(' · ')})`;
					}
				}

				typingTextEl.textContent = statusText;
			}
		}
	}

	// ========================================
	// Tab Bar UI Management (Visual Only)
	// ========================================

	/**
	 * Create the tab bar UI structure
	 */
	createTabBar(container: HTMLElement): void {
		this.tabBar = container.createEl('div', { cls: 'letta-tab-bar' });

		// Container for agent tabs
		this.tabContainer = this.tabBar.createEl('div', { cls: 'letta-tab-container' });

		// Add button for new agent conversation
		const addButton = this.tabBar.createEl('button', {
			cls: 'letta-tab-add',
			text: '+'
		});
		addButton.title = 'Start new agent conversation';
		addButton.addEventListener('click', () => {
			this.openAgentConfig();
		});
	}

	/**
	 * Create a tab for an agent (visual only - clicking triggers full agent switch)
	 */
	createAgentTab(agentId: string, agentName: string): HTMLElement {
		if (!this.tabContainer) return document.createElement('div');

		// Check if tab already exists
		if (this.agentTabs.has(agentId)) {
			return this.agentTabs.get(agentId)!;
		}

		const tab = this.tabContainer.createEl('div', {
			cls: 'letta-tab',
			attr: { 'data-agent-id': agentId }
		});

		// Avatar with initials
		const initials = this.getAgentInitials(agentName);
		tab.createEl('span', {
			cls: 'letta-tab-avatar',
			text: initials
		});

		// Agent name
		tab.createEl('span', {
			cls: 'letta-tab-name',
			text: agentName
		});

		// Close button
		const closeBtn = tab.createEl('button', {
			cls: 'letta-tab-close',
			text: '×'
		});
		closeBtn.title = 'Remove from recent agents';
		closeBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.closeAgentTab(agentId);
		});

		// Click to switch to this agent (full switch)
		tab.addEventListener('click', () => {
			// Don't switch if already active
			if (this.plugin.settings.agentId === agentId) return;

			// Find agent from recent agents and switch
			const recent = this.plugin.settings.recentAgents?.find((r: any) => r.id === agentId);
			if (recent) {
				this.switchToAgent({ id: recent.id, name: recent.name });
			}
		});

		this.agentTabs.set(agentId, tab);
		return tab;
	}

	/**
	 * Set the active tab visually
	 */
	setActiveTab(agentId: string): void {
		// Update tab active states
		this.agentTabs.forEach((tab, id) => {
			if (id === agentId) {
				tab.addClass('active');
			} else {
				tab.removeClass('active');
			}
		});
	}

	/**
	 * Close an agent's tab (removes from recent agents)
	 */
	closeAgentTab(agentId: string): void {
		// Don't allow closing if it's the only tab
		if (this.agentTabs.size <= 1) {
			new Notice('Cannot close the last conversation tab');
			return;
		}

		// Remove tab from DOM
		const tab = this.agentTabs.get(agentId);
		if (tab) {
			tab.remove();
			this.agentTabs.delete(agentId);
		}

		// Remove from recent agents
		if (this.plugin.settings.recentAgents) {
			this.plugin.settings.recentAgents = this.plugin.settings.recentAgents.filter(
				(r: any) => r.id !== agentId
			);
			this.plugin.saveSettings();
		}

		// If this was the current agent, switch to another
		if (this.plugin.settings.agentId === agentId) {
			const remainingAgentIds = Array.from(this.agentTabs.keys());
			if (remainingAgentIds.length > 0) {
				const nextAgentId = remainingAgentIds[0];
				const recent = this.plugin.settings.recentAgents?.find((r: any) => r.id === nextAgentId);
				if (recent) {
					this.switchToAgent({ id: recent.id, name: recent.name });
				}
			}
		}
	}

	/**
	 * Update the display of the active agent in the header
	 */
	updateAgentDisplay(agentName: string): void {
		if (this.agentNameElement) {
			this.agentNameElement.textContent = agentName;
			this.agentNameElement.removeClass('no-agent');
		}
		this.updateAgentAvatar();
		this.updateTypingIndicatorText();
	}

	/**
	 * Get initials from agent name (e.g., "Executive Assistant" -> "EA")
	 */
	getAgentInitials(name: string): string {
		if (!name) return '?';
		const words = name.trim().split(/\s+/);
		if (words.length === 1) {
			return words[0].substring(0, 2).toUpperCase();
		}
		return (words[0][0] + words[words.length - 1][0]).toUpperCase();
	}

	handleHeartbeat() {
		// Heartbeat received - showing typing indicator
		this.showTypingIndicator();

		// Clear existing timeout
		if (this.heartbeatTimeout) {
			clearTimeout(this.heartbeatTimeout);
		}

		// Hide typing indicator after 3 seconds of no heartbeats
		this.heartbeatTimeout = setTimeout(() => {
			// No heartbeat for 3s - hiding typing indicator
			this.hideTypingIndicator();
			this.heartbeatTimeout = null;
		}, 3000);
	}

	async updateChatStatus(loadHistoricalMessages = true, connectingMessage?: string) {
		console.log("[Letta Plugin] updateChatStatus called with loadHistoricalMessages:", loadHistoricalMessages, "connectingMessage:", connectingMessage);

		// If we have a connecting message, show connecting state
		if (connectingMessage) {
			console.log("[Letta Plugin] updateChatStatus: Taking CONNECTING branch -", connectingMessage);
			this.statusDot.className = "letta-status-dot letta-status-warning";
			this.statusText.textContent = connectingMessage;
			// Update agent name display to show "Connecting..."
			this.updateAgentNameDisplay(connectingMessage);
			// Show header but hide input when connecting
			if (this.header) {
				this.header.style.display = "flex";
			}
			if (this.inputContainer) {
				this.inputContainer.style.display = "none";
			}
			// Show connecting message in chat area
			this.removeDisconnectedMessage();
			this.removeNoAgentMessage();
			this.showConnectingMessage(connectingMessage);
			return;
		}

		// Determine connection status based on plugin state
		const isAgentAttached = !!this.plugin.agent;
		const isServerConnected = !!this.plugin.client;
		const isConnecting = this.plugin.isConnecting;

		console.log("[Letta Plugin] updateChatStatus state check:", {
			hasAgent: !!this.plugin.agent,
			agentId: this.plugin.agent?.id,
			agentName: this.plugin.agent?.name,
			isAgentAttached,
			isServerConnected,
			isConnecting
		});

		// If we're in the middle of connecting, show connecting state
		if (isConnecting) {
			console.log("[Letta Plugin] updateChatStatus: Taking CONNECTING branch - plugin is connecting");
			this.statusDot.className = "letta-status-dot letta-status-warning";
			this.statusText.textContent = "Connecting...";
			this.updateAgentNameDisplay("Connecting...");
			if (this.header) {
				this.header.style.display = "flex";
			}
			if (this.inputContainer) {
				this.inputContainer.style.display = "none";
			}
			this.removeDisconnectedMessage();
			this.removeNoAgentMessage();
			this.showConnectingMessage("Connecting to agents...");
			return;
		}

		if (isAgentAttached) {
			console.log("[Letta Plugin] updateChatStatus: Taking AGENT_ATTACHED branch - full connection");
			this.statusDot.className =
				"letta-status-dot letta-status-connected";

			// Use the plugin's helper method for consistent status text
			this.statusText.textContent = this.plugin.getConnectionStatusText();

			// Update agent name display
			this.updateAgentNameDisplay();

			// Show header and input when connected
			if (this.header) {
				this.header.style.display = "flex";
			}
			if (this.inputContainer) {
				this.inputContainer.style.display = "flex";
			}

			// Remove disconnected/no agent/connecting messages if they exist
			this.removeDisconnectedMessage();
			this.removeNoAgentMessage();
			this.removeConnectingMessage();

			// Conditionally load historical messages
			if (loadHistoricalMessages) {
				this.loadHistoricalMessages();
			}
		} else if (isServerConnected) {
			console.log("[Letta Plugin] updateChatStatus: Taking SERVER_CONNECTED branch - server connected but no agent");
			// Connected to server but no agent selected
			this.statusDot.className = "letta-status-dot letta-status-warning";
			this.statusText.textContent = this.plugin.getConnectionStatusText();

			// Update agent name display to show "No Agent Selected"
			this.updateAgentNameDisplay();

			// Show header but hide input when no agent
			if (this.header) {
				this.header.style.display = "flex";
			}
			if (this.inputContainer) {
				this.inputContainer.style.display = "none";
			}

			// Show no agent message in chat area
			this.removeDisconnectedMessage();
			this.removeConnectingMessage();
			this.showNoAgentMessage();
		} else {
			console.log("[Letta Plugin] updateChatStatus: Taking DISCONNECTED branch - no connection");
			// Not connected to server
			this.statusDot.className = "letta-status-dot";
			this.statusDot.style.backgroundColor = "var(--text-muted)";
			this.statusText.textContent = "Letta Disconnected";

			// Update agent name display to show "No Agent"
			this.updateAgentNameDisplay();

			// Hide header and input when disconnected
			if (this.header) {
				this.header.style.display = "none";
			}
			if (this.inputContainer) {
				this.inputContainer.style.display = "none";
			}

			// Show disconnected message in chat area
			this.removeNoAgentMessage();
			this.removeConnectingMessage();
			this.showDisconnectedMessage();
		}
	}

	updateAgentNameDisplay(connectingMessage?: string) {
		if (connectingMessage) {
			this.agentNameElement.textContent = "Connecting...";
			this.agentNameElement.className = "letta-chat-title connecting";
			return;
		}

		const isServerConnected = !!this.plugin.client;

		if (this.plugin.agent) {
			this.agentNameElement.textContent = this.plugin.settings.agentName;
			this.agentNameElement.className = "letta-chat-title";
		} else if (isServerConnected) {
			this.agentNameElement.textContent = "No Agent Selected";
			this.agentNameElement.className = "letta-chat-title no-agent-selected";
		} else {
			this.agentNameElement.textContent = "No Agent";
			this.agentNameElement.className = "letta-chat-title no-agent";
		}
	}

	updateFocusIndicator() {
		if (!this.focusIndicator) return;

		if (!this.plugin.settings.focusMode || !this.plugin.agent) {
			this.focusIndicator.style.display = "none";
			return;
		}

		const activeFile = this.plugin.app.workspace.getActiveFile();
		
		if (activeFile) {
			this.focusIndicator.style.display = "flex";
			this.focusIndicator.empty();
			
			const icon = this.focusIndicator.createEl("span", {
				cls: "letta-focus-icon",
				text: "👁️"
			});
			
			const fileInfo = this.focusIndicator.createEl("span", {
				cls: "letta-focus-text",
				text: `Focused: ${activeFile.basename}`
			});
			
			fileInfo.title = `Currently focused on: ${activeFile.path}`;
		} else {
			this.focusIndicator.style.display = "none";
		}
	}

	updateVaultToolsIndicator() {
		if (!this.vaultToolsIndicator) return;

		const enabled = this.plugin.settings.enableVaultTools;
		const registered = this.plugin.vaultToolsRegistered;

		this.vaultToolsIndicator.empty();

		if (!enabled) {
			this.vaultToolsIndicator.addClass("letta-vault-disabled");
			this.vaultToolsIndicator.removeClass("letta-vault-active");
			this.vaultToolsIndicator.textContent = "Vault: Off";
			this.vaultToolsIndicator.title = "Vault tools are disabled. Enable in settings to allow file operations.";
		} else if (registered) {
			this.vaultToolsIndicator.addClass("letta-vault-active");
			this.vaultToolsIndicator.removeClass("letta-vault-disabled");
			this.vaultToolsIndicator.textContent = "Vault: Active";
			this.vaultToolsIndicator.title = "Vault tools are active. Agent can read, write, and search files.";
		} else {
			this.vaultToolsIndicator.removeClass("letta-vault-active");
			this.vaultToolsIndicator.removeClass("letta-vault-disabled");
			this.vaultToolsIndicator.textContent = "Vault: Pending";
			this.vaultToolsIndicator.title = "Vault tools enabled but not yet registered with agent.";
		}
	}

	updateFocusToggle() {
		if (!this.focusToggle) return;

		const enabled = this.plugin.settings.focusMode;

		if (enabled) {
			this.focusToggle.addClass("letta-focus-active");
			this.focusToggle.textContent = "Focus: On";
			this.focusToggle.title = "Focus mode ON - Agent sees your current note. Click to disable.";
		} else {
			this.focusToggle.removeClass("letta-focus-active");
			this.focusToggle.textContent = "Focus: Off";
			this.focusToggle.title = "Focus mode OFF - Click to enable tracking of current note.";
		}
	}

	showDisconnectedMessage() {
		// Only show if chat container exists
		if (!this.chatContainer) {
			return;
		}

		// Remove any existing disconnected message
		this.removeDisconnectedMessage();

		// Create disconnected message container
		const disconnectedContainer = this.chatContainer.createEl("div", {
			cls: "letta-disconnected-container",
		});

		// Large disconnected message
		const disconnectedMessage = disconnectedContainer.createEl("div", {
			cls: "letta-disconnected-message",
		});

		disconnectedMessage.createEl("h2", {
			text: "You are not connected to Letta",
			cls: "letta-disconnected-title",
		});

		disconnectedMessage.createEl("p", {
			text: "A server connection is required to use your stateful agent",
			cls: "letta-disconnected-subtitle",
		});

		// Show authentication error message if available
		if (this.plugin.lastAuthError) {
			disconnectedMessage.createEl("p", {
				text: this.plugin.lastAuthError,
				cls: "letta-auth-error-text",
			});
		}

		// Connect button
		const connectButton = disconnectedMessage.createEl("button", {
			text: "Connect to Letta",
			cls: "letta-connect-button",
		});

		// Progress message element
		const progressMessage = disconnectedMessage.createEl("div", {
			cls: "letta-connect-progress hidden",
		});

		connectButton.addEventListener("click", async () => {
			console.log("[Letta Plugin] Connect button clicked - starting connection process");
			connectButton.disabled = true;

			// Clear existing content and add spinner
			connectButton.innerHTML = "";
			const spinner = connectButton.createEl("span", {
				cls: "letta-connect-spinner",
			});
			connectButton.appendChild(document.createTextNode("Connecting..."));

			// Show progress message
			progressMessage.classList.remove("hidden");
			progressMessage.classList.add("visible");

			try {
				console.log("[Letta Plugin] Calling connectToLetta from button click handler");
				const connected = await this.plugin.connectToLetta(1, (message: string) => {
					progressMessage.textContent = message;
				});

				console.log("[Letta Plugin] connectToLetta returned:", connected);

				if (connected) {
					console.log("[Letta Plugin] Connection successful - calling updateChatStatus to refresh UI");
					console.log("[Letta Plugin] Current plugin state before updateChatStatus:", {
						hasAgent: !!this.plugin.agent,
						agentId: this.plugin.agent?.id
					});
					// Connection successful - explicitly update chat status to refresh UI
					await this.updateChatStatus();
					console.log("[Letta Plugin] updateChatStatus completed");
				} else {
					console.log("[Letta Plugin] Connection failed - resetting connect button");
					// Connection failed - reset button
					this.resetConnectButton(connectButton, progressMessage);
				}
			} catch (error) {
				console.log("[Letta Plugin] Exception in connect button handler:", error);
				// Connection failed - reset button
				this.resetConnectButton(connectButton, progressMessage);
			}
		});
	}

	private resetConnectButton(connectButton: HTMLButtonElement, progressMessage: HTMLElement) {
		// Clear button content
		connectButton.innerHTML = "";
		connectButton.textContent = "Connect to Letta";
		connectButton.disabled = false;

		// Hide progress message
		progressMessage.classList.remove("visible");
		progressMessage.classList.add("hidden");
	}

	removeDisconnectedMessage() {
		if (!this.chatContainer) {
			return;
		}

		const existingMessage = this.chatContainer.querySelector(
			".letta-disconnected-container",
		);
		if (existingMessage) {
			existingMessage.remove();
		}
	}

	showConnectingMessage(message: string) {
		// Only show if chat container exists
		if (!this.chatContainer) {
			return;
		}

		// Remove any existing connecting message
		this.removeConnectingMessage();

		// Create connecting message container
		const connectingContainer = this.chatContainer.createEl("div", {
			cls: "letta-connecting-container",
		});

		// Large connecting message
		const connectingMessage = connectingContainer.createEl("div", {
			cls: "letta-connecting-message",
		});

		connectingMessage.createEl("h2", {
			text: message,
			cls: "letta-connecting-title",
		});

		connectingMessage.createEl("p", {
			text: "Establishing connection to Letta service...",
			cls: "letta-connecting-subtitle",
		});

		// Add animated dots
		const dots = connectingMessage.createEl("div", {
			cls: "letta-connecting-dots",
		});
		dots.createEl("span");
		dots.createEl("span");
		dots.createEl("span");
	}

	removeConnectingMessage() {
		if (!this.chatContainer) {
			return;
		}

		const existingMessage = this.chatContainer.querySelector(
			".letta-connecting-container",
		);
		if (existingMessage) {
			existingMessage.remove();
		}
	}

	async showNoAgentMessage() {
		if (!this.chatContainer) {
			return;
		}

		// Remove existing no agent message first
		this.removeNoAgentMessage();

		const messageContainer = this.chatContainer.createEl("div", {
			cls: "letta-no-agent-container",
		});

		const content = messageContainer.createEl("div", {
			cls: "letta-no-agent-content",
		});

		content.createEl("h3", {
			text: "No Agent Selected",
			cls: "letta-no-agent-title",
		});

		content.createEl("p", {
			text: "You are connected to Letta, but no agent is selected. Choose an agent to start chatting.",
			cls: "letta-no-agent-description",
		});

		const buttonContainer = content.createEl("div", {
			cls: "letta-no-agent-buttons",
		});

		// Check agent count to determine if Select Agent should be enabled
		const agentCount = await this.plugin.getAgentCount();

		const selectAgentButton = buttonContainer.createEl("button", {
			text: agentCount > 0 ? "Select Agent" : "No Agents Available",
			cls: "mod-cta letta-select-agent-button",
		});

		if (agentCount > 0) {
			selectAgentButton.addEventListener("click", async () => {
				// Open agent selector from settings
				const settingTab = new LettaSettingTab(this.app, this.plugin);
				await settingTab.showAgentSelector();
			});
		} else {
			selectAgentButton.disabled = true;
			selectAgentButton.style.opacity = "0.5";
			selectAgentButton.style.cursor = "not-allowed";
		}

		// Show the create agent button
		const createAgentButton = buttonContainer.createEl("button", {
			text: "Create New Agent",
			cls: "letta-create-agent-button",
		});

		// Make the button less prominent to prevent accidental clicks
		createAgentButton.style.cssText = "opacity: 0.7; font-size: 0.9em;";
		createAgentButton.addEventListener("mouseenter", () => {
			createAgentButton.style.opacity = "1";
		});
		createAgentButton.addEventListener("mouseleave", () => {
			createAgentButton.style.opacity = "0.7";
		});

		createAgentButton.addEventListener("click", async () => {
			// Show confirmation before opening agent creation modal
			const confirmModal = new Modal(this.app);
			confirmModal.titleEl.setText("Create New Agent");

			const content = confirmModal.contentEl;
			content.createEl("p", {
				text: "Are you sure you want to create a new agent? This will open the agent configuration modal.",
			});

			const buttonContainer = content.createEl("div", {
				cls: "modal-button-container",
			});
			buttonContainer.style.cssText =
				"display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;";

			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel",
			});
			cancelButton.addEventListener("click", () => confirmModal.close());

			const createButton = buttonContainer.createEl("button", {
				text: "Create Agent",
				cls: "mod-cta",
			});
			createButton.addEventListener("click", async () => {
				confirmModal.close();

				// Open agent creation modal after confirmation
				const configModal = new AgentConfigModal(this.app, this.plugin);
				const agentConfig = await configModal.showModal();

				if (agentConfig) {
					try {
						// Create the agent using the configuration
						await this.createAgentFromConfig(agentConfig);
						new Notice("Agent created successfully!");
						// Refresh the no-agent message to update button state
						await this.showNoAgentMessage();
					} catch (error) {
						console.error(
							"[Letta Plugin] Failed to create agent:",
							error,
						);
						new Notice(`Failed to create agent: ${error.message}`);
					}
				}
			});

			confirmModal.open();
		});
	}

	async createAgentFromConfig(agentConfig: AgentConfig): Promise<void> {

		// Creating new agent
		// console.log('[Letta Plugin] Starting agent creation with config:', agentConfig);

		// Check if this is a cloud instance and handle project selection
		const isCloudInstance =
			this.plugin.settings.lettaBaseUrl.includes("api.letta.com");
		let selectedProject: any = null;

		if (isCloudInstance) {
			console.log(
				"[Letta Plugin] Cloud instance detected, checking projects...",
			);
			try {
				const projectsResponse =
					await this.plugin.makeRequest("/v1/projects");
				console.log(
					"[Letta Plugin] Available projects response:",
					projectsResponse,
				);

				// Handle both direct array and nested response formats
				const projects = projectsResponse.projects || projectsResponse;
				console.log("[Letta Plugin] Projects array:", projects);

				// If we have a configured project slug, try to find it
				if (this.plugin.settings.lettaProjectSlug) {
					selectedProject = projects.find(
						(p: any) =>
							p.slug === this.plugin.settings.lettaProjectSlug,
					);
					if (!selectedProject) {
						console.warn(
							`[Letta Plugin] Configured project "${this.plugin.settings.lettaProjectSlug}" not found`,
						);
					}
				}

				// If no valid project is selected, use the first available project
				if (!selectedProject && projects.length > 0) {
					selectedProject = projects[0];
					console.log(
						"[Letta Plugin] Using first available project:",
						selectedProject,
					);
					console.log(
						"[Letta Plugin] Project fields available:",
						Object.keys(selectedProject),
					);
				}

				if (!selectedProject) {
					throw new Error(
						"No projects available. Please create a project first in your Letta instance.",
					);
				}
			} catch (error) {
				console.error("[Letta Plugin] Project setup failed:", error);
				throw new Error(`Failed to setup project: ${error.message}`);
			}
		}

		// Create new agent with user configuration and corrected defaults
		const agentBody: any = {
			name: agentConfig.name,
			agent_type: agentConfig.agent_type || "memgpt_v2_agent", // Use user selection or default to MemGPT v2
			description: agentConfig.description,
			model: agentConfig.model,
			include_base_tools: false, // Don't include base tools, use custom memory tools
			include_multi_agent_tools: agentConfig.include_multi_agent_tools,
			include_default_source: agentConfig.include_default_source,
			tags: agentConfig.tags,
			memory_blocks: agentConfig.memory_blocks,
			// source_ids removed - no longer using deprecated folder approach
			// Specify the correct memory tools
			tools: ["memory_replace", "memory_insert", "memory_rethink"],
		};

		// Only include project for cloud instances
		if (isCloudInstance && selectedProject) {
			// Try using slug instead of id since the API error suggests id is not found
			agentBody.project = selectedProject.slug;
			console.log(
				"[Letta Plugin] Using project for agent creation:",
				selectedProject.slug,
			);
		}

		// Remove undefined values to keep the request clean
		Object.keys(agentBody).forEach((key) => {
			if (agentBody[key] === undefined) {
				delete agentBody[key];
			}
		});

		console.log(
			"[Letta Plugin] Creating agent with config:",
			JSON.stringify(agentBody, null, 2),
		);

		let newAgent: any;
		try {
			if (!this.plugin.client) throw new Error("Client not initialized");
			newAgent = await this.plugin.client.agents.create(agentBody);
			console.log("[Letta Plugin] Agent created successfully:", newAgent);
		} catch (error: any) {
			console.error(
				"[Letta Plugin] Agent creation failed with error:",
				error,
			);
			console.error("[Letta Plugin] Error details:", {
				status: error.status,
				message: error.message,
				responseText: error.responseText,
				responseJson: error.responseJson,
				url: `${this.plugin.settings.lettaBaseUrl}/v1/agents`,
				method: "POST",
				body: agentBody,
			});
			throw error;
		}

		// Update plugin state with the new agent
		this.plugin.agent = { id: newAgent.id, name: newAgent.name };

		// Update settings with the new agent
		this.plugin.settings.agentId = newAgent.id;
		this.plugin.settings.agentName = agentConfig.name;

		// Update project settings if we selected a project
		if (selectedProject) {
			this.plugin.settings.lettaProjectSlug = selectedProject.slug;
			console.log(
				"[Letta Plugin] Updated project settings to:",
				selectedProject.slug,
			);
		}

		await this.plugin.saveSettings();
	}

	removeNoAgentMessage() {
		if (!this.chatContainer) {
			return;
		}

		const existingMessage = this.chatContainer.querySelector(
			".letta-no-agent-container",
		);
		if (existingMessage) {
			existingMessage.remove();
		}
	}

	openInADE() {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		// Construct the ADE URL for the current agent
		const adeUrl = `https://app.letta.com/agents/${this.plugin.agent?.id}`;

		// Open in external browser
		window.open(adeUrl, "_blank");

		new Notice("Opening agent in Letta ADE...");
	}


	async editAgentName() {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		const currentName = this.plugin.settings.agentName;
		const newName = await this.promptForAgentName(currentName);

		if (newName && newName !== currentName) {
			try {
				// Update agent name via API
				await this.plugin.makeRequest(
					`/v1/agents/${this.plugin.agent?.id}`,
					{
						method: "PATCH",
						body: { name: newName },
					},
				);

				// Update settings
				this.plugin.settings.agentName = newName;
				await this.plugin.saveSettings();

				// Update UI
				this.updateAgentNameDisplay();
				this.plugin.agent.name = newName;

				new Notice(`Agent name updated to: ${newName}`);
			} catch (error) {
				console.error("Failed to update agent name:", error);
				new Notice("Failed to update agent name. Please try again.");
			}
		}
	}

	private promptForAgentName(currentName: string): Promise<string | null> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle("Edit Agent Name");

			const { contentEl } = modal;
			contentEl.createEl("p", {
				text: "Enter a new name for your agent:",
			});

			const input = contentEl.createEl("input", {
				type: "text",
				value: currentName,
				cls: "config-input",
			});
			input.style.width = "100%";
			input.style.marginBottom = "16px";

			const buttonContainer = contentEl.createEl("div");
			buttonContainer.style.display = "flex";
			buttonContainer.style.gap = "8px";
			buttonContainer.style.justifyContent = "flex-end";

			const saveButton = buttonContainer.createEl("button", {
				text: "Save",
				cls: "mod-cta",
			});

			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel",
			});

			saveButton.addEventListener("click", () => {
				const newName = input.value.trim();
				if (newName) {
					resolve(newName);
					modal.close();
				}
			});

			cancelButton.addEventListener("click", () => {
				resolve(null);
				modal.close();
			});

			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					const newName = input.value.trim();
					if (newName) {
						resolve(newName);
						modal.close();
					}
				}
				if (e.key === "Escape") {
					resolve(null);
					modal.close();
				}
			});

			modal.open();
			input.focus();
			input.select();
		});
	}

	async openAgentConfig() {
		if (!this.plugin.agent) {
			// Try to connect first
			try {
				await this.plugin.connectToLetta();
				if (!this.plugin.agent) {
					new Notice("Please configure your Letta connection first");
					return;
				}
			} catch (error) {
				new Notice(
					"Failed to connect to Letta. Please check your settings.",
				);
				return;
			}
		}

		if (!this.plugin.client) throw new Error("Client not initialized");

		// Get current agent details and blocks
		const [agentDetails, blocks] = await Promise.all([
			this.plugin.makeRequest(`/v1/agents/${this.plugin.agent!.id}`),
			this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent!.id}/core-memory/blocks`,
			),
		]);

		const modal = new AgentPropertyModal(
			this.app,
			agentDetails,
			blocks,
			async (updatedConfig) => {
				try {
					// Extract block updates from config
					const { blockUpdates, ...agentConfig } = updatedConfig;

					// Update agent properties if any changed
					if (Object.keys(agentConfig).length > 0) {
						await this.plugin.makeRequest(
							`/v1/agents/${this.plugin.agent?.id}`,
							{
								method: "PATCH",
								body: agentConfig,
							},
						);
					}

					// Update blocks if any changed
					if (blockUpdates && blockUpdates.length > 0) {
						await Promise.all(
							blockUpdates.map(async (blockUpdate: any) => {
								await this.plugin.makeRequest(
									`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/${blockUpdate.label}`,
									{
										method: "PATCH",
										body: { value: blockUpdate.value },
									},
								);
							}),
						);
					}

					// Update local agent reference and settings
					if (
						agentConfig.name &&
						agentConfig.name !== this.plugin.settings.agentName
					) {
						this.plugin.settings.agentName = agentConfig.name;
						await this.plugin.saveSettings();
						this.updateAgentNameDisplay();
						if (this.plugin.agent) {
							this.plugin.agent.name = agentConfig.name;
						}
					}

					const hasAgentChanges = Object.keys(agentConfig).length > 0;
					const hasBlockChanges =
						blockUpdates && blockUpdates.length > 0;

					if (hasAgentChanges && hasBlockChanges) {
						new Notice(
							"Agent configuration and memory blocks updated successfully",
						);
					} else if (hasAgentChanges) {
						new Notice("Agent configuration updated successfully");
					} else if (hasBlockChanges) {
						new Notice("Memory blocks updated successfully");
					}
				} catch (error) {
					console.error(
						"Failed to update agent configuration:",
						error,
					);
					new Notice(
						"Failed to update agent configuration. Please try again.",
					);
				}
			},
		);

		modal.open();
	}

	showSizeLimitWarning(file: TFile, actualSize: number, limit: number): void {
		if (!this.sizeLimitWarning) return;

		const warningContent = `
			<div class="letta-size-warning-icon">⚠️</div>
			<div class="letta-size-warning-text">
				<strong>Note too large for agent to view</strong><br>
				File: ${file.basename}<br>
				Size: ${actualSize.toLocaleString()} characters (limit: ${limit.toLocaleString()})<br>
				<small>Increase the character limit in settings to view larger files</small>
			</div>
		`;

		this.sizeLimitWarning.innerHTML = warningContent;
		this.sizeLimitWarning.style.display = "block";

		// Auto-hide after 10 seconds
		setTimeout(() => {
			if (this.sizeLimitWarning) {
				this.sizeLimitWarning.style.display = "none";
			}
		}, 10000);
	}

	async sendFeedbackToAgent(feedbackType: "positive" | "negative", responseContent: string) {
		if (!this.plugin.client || !this.plugin.agent) {
			console.log("[Letta Plugin] Cannot send feedback: not connected");
			return;
		}

		try {
			// Create a truncated preview of the response for context
			const preview = responseContent.length > 200
				? responseContent.substring(0, 200) + "..."
				: responseContent;

			const feedbackMessage = feedbackType === "positive"
				? `[USER FEEDBACK: POSITIVE] The user liked your previous response. They gave it a thumbs up. This is helpful feedback for you to know what kind of responses work well. Response preview: "${preview}"`
				: `[USER FEEDBACK: NEGATIVE] The user did not find your previous response helpful. They gave it a thumbs down. Please consider how you might improve similar responses in the future. Response preview: "${preview}"`;

			// Send feedback as a system-style message (won't show in UI but agent will receive it)
			console.log(`[Letta Plugin] Sending ${feedbackType} feedback to agent`);

			await this.plugin.client.agents.messages.create(this.plugin.agent.id, {
				messages: [{
					role: "user",
					content: feedbackMessage
				}]
			});

			console.log(`[Letta Plugin] Feedback sent successfully`);
		} catch (error) {
			console.error("[Letta Plugin] Failed to send feedback:", error);
		}
	}

	async sendMessage() {
		let message = this.messageInput.value.trim();
		if (!message) return;

		// Handle /vault command - prepend instruction to use vault tools
		if (message.toLowerCase().startsWith('/vault ')) {
			const vaultMessage = message.slice(7).trim(); // Remove '/vault '
			if (!vaultMessage) {
				await this.addMessage(
					"assistant",
					"**Usage:** `/vault <your request>`\n\nExamples:\n- `/vault create a note called ideas.md`\n- `/vault read my daily notes`\n- `/vault search for project updates`",
					"System",
				);
				return;
			}
			// Prepend context telling agent to use vault tools
			message = `[VAULT OPERATION REQUESTED] Please use your Obsidian vault tools to: ${vaultMessage}`;
		}

		// Handle /focus command - toggle focus mode
		if (message.toLowerCase() === '/focus') {
			this.plugin.settings.focusMode = !this.plugin.settings.focusMode;
			await this.plugin.saveSettings();
			this.updateFocusToggle();
			const status = this.plugin.settings.focusMode ? "enabled" : "disabled";
			await this.addMessage(
				"assistant",
				`**Focus mode ${status}.**\n\n${this.plugin.settings.focusMode ? "The agent will now receive context about your currently open note." : "The agent will no longer track your current note."}`,
				"System",
			);
			this.messageInput.value = "";
			return;
		}

		// Handle /clear command - clear chat display
		if (message.toLowerCase() === '/clear') {
			if (this.chatContainer) {
				this.chatContainer.empty();
				// Re-add size limit warning (hidden by default)
				this.sizeLimitWarning = this.chatContainer.createEl("div", {
					cls: "letta-size-limit-warning",
				});
				this.sizeLimitWarning.style.display = "none";
			}
			await this.addMessage(
				"assistant",
				"**Chat display cleared.** Note: The agent's memory is not affected.",
				"System",
			);
			this.messageInput.value = "";
			return;
		}

		// Handle /help command - show available commands
		if (message.toLowerCase() === '/help') {
			const helpText = SLASH_COMMANDS.map(cmd =>
				`- **/${cmd.name}** - ${cmd.description}${cmd.usage ? ` (${cmd.usage})` : ''}`
			).join('\n');
			await this.addMessage(
				"assistant",
				`**Available Commands:**\n\n${helpText}\n\n**Tips:**\n- Use \`@\` to mention and include files\n- The agent remembers your conversation history`,
				"System",
			);
			this.messageInput.value = "";
			return;
		}

		// Extract mentioned files and include their content
		const mentionedFiles = this.extractMentionedFiles();
		if (mentionedFiles.length > 0) {
			const contextParts: string[] = [];

			for (const filePath of mentionedFiles) {
				const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
				if (file && file instanceof TFile) {
					try {
						const content = await this.plugin.app.vault.read(file);
						contextParts.push(`\n\n---\n**Context from ${file.path}:**\n\`\`\`\n${content}\n\`\`\``);
					} catch (error) {
						console.error(`Failed to read mentioned file ${filePath}:`, error);
					}
				}
			}

			if (contextParts.length > 0) {
				// Remove the @[[...]] mentions from the display message
				const cleanMessage = message.replace(/@\[\[([^\]]+)\]\]/g, '');
				// Append context to the actual message sent to the agent
				message = cleanMessage + contextParts.join('');
			}
		}

		// Check connection and auto-connect if needed
		if (!this.plugin.agent) {
			// Show connecting status in the chat view
			await this.updateChatStatus(false, "Connecting to agents...");

			const connected = await this.plugin.connectToLetta(1, (progressMessage) => {
				// Update the connecting status with progress messages
				this.updateChatStatus(false, progressMessage);
			});

			if (!connected) {
				// Connection failed, show no agent/disconnected state
				await this.updateChatStatus(false);
				await this.addMessage(
					"assistant",
					"**Connection failed**. Please check your settings and try again.",
					"Error",
				);
				return;
			} else {
				// Connection succeeded, update status to reflect current state
				await this.updateChatStatus(false);
			}
		}

		// Check if agent is attached after connection
		if (!this.plugin.agent) {
			await this.addMessage(
				"assistant",
				"**No agent selected**. Please select an agent to start chatting.",
				"System",
			);
			return;
		}

		// Process attachments (images and documents)
		let images: Array<{ base64: string; mediaType: string }> = [];
		let processedMessage = message;

		if (this.pendingAttachments.length > 0) {
			const result = await this.buildMessageWithAttachments(message);
			images = result.images;
			// Extract the text content which now includes attachment info
			processedMessage = result.content[0].text;
		} else {
			// Fallback to legacy image handling
			images = this.pendingImages.map(i => ({
				base64: i.base64,
				mediaType: i.mediaType,
			}));
		}

		// Clear all pending attachments
		this.clearPendingAttachments();

		// Disable input while processing
		this.messageInput.disabled = true;
		this.sendButton.disabled = true;
		this.sendButton.textContent = "Sending...";
		this.sendButton.addClass("letta-button-loading");

		// Add user message to chat (with images if any)
		await this.addMessage("user", processedMessage, undefined, undefined, images.length > 0 ? images : undefined);

		// Show typing indicator immediately after user message
		this.showTypingIndicator();

		// Clear and reset input
		this.messageInput.value = "";
		this.messageInput.style.height = "auto";

		try {
			if (this.plugin.settings.enableStreaming) {
				// Use streaming API for real-time responses
				// Sending message via streaming API

				// Complete any existing streaming message before starting new one
				if (this.currentAssistantMessageEl) {
					// Completing existing streaming message before new message
					this.markStreamingComplete();
					// Clear state but preserve DOM elements
					this.currentReasoningContent = "";
					this.assistantReasoningContent = "";
					this.currentAssistantContent = "";
					this.currentAssistantMessageEl = null;
					this.currentReasoningMessageEl = null;
					this.currentToolMessageEl = null;
					this.currentToolCallId = null;
					this.currentToolCallArgs = "";
					this.currentToolCallName = "";
					this.currentToolCallData = null;
					this.currentApprovalRequestId = null;
					this.currentApprovalArgs = "";
					this.currentApprovalToolName = "";
					this.hasCreatedApprovalUI = false;
				}

				// Reset streaming state (now safe since we completed above)
				this.resetStreamingState();

				// RAINMAKER FIX: Create abort controller and track current agent
				// Abort any previous controller first
				if (this.streamAbortController) {
					this.streamAbortController.abort();
				}
				this.streamAbortController = new AbortController();
				const currentAgentId = this.plugin.settings.agentId;
				this.currentStreamingAgentId = currentAgentId;

				// Show stop button now that streaming is starting
				this.showStopButton();
				this.streamingStepCount = 0;
				this.streamingTokenEstimate = 0;

				await this.plugin.sendMessageToAgentStream(
					processedMessage,
					images.length > 0 ? images : undefined,
					async (message) => {
						// RAINMAKER FIX: Check if still same agent before processing
						if (this.currentStreamingAgentId !== currentAgentId) {
							console.log("[Letta Plugin] Ignoring streaming message from stale agent");
							return;
						}
						// Handle each streaming message
						await this.processStreamingMessage(message);
					},
					async (error) => {
						// RAINMAKER FIX: Ignore errors from aborted/stale requests
						if (this.currentStreamingAgentId !== currentAgentId) {
							console.log("[Letta Plugin] Ignoring streaming error from stale agent");
							return;
						}
						// Handle streaming error
						console.error("Streaming error:", error);

						// Check if it's a CORS error and trigger fallback
						if (
							error.message &&
							error.message.includes("CORS_ERROR")
						) {
							console.log(
								"[Letta Plugin] CORS error detected, triggering fallback to non-streaming API",
							);
							// Don't show error message - let the fallback handle it
							throw error; // This will be caught by the outer catch block and trigger fallback
						}
						// Check if it's a rate limiting error and handle it specially
						else if (
							error.message &&
							error.message.includes("HTTP 429")
						) {
							console.log(
								"[Letta Plugin] Rate limit error detected, showing specialized message",
							);
							const rateLimitContent = RATE_LIMIT_MESSAGE.create(
								error.message,
							);
							console.log(
								"[Letta Plugin] Rate limit message content:",
								rateLimitContent,
							);
							// Create the proper rate limit message format that includes billing link
							this.addRateLimitMessage(rateLimitContent);
						} else {
							await this.addMessage(
								"assistant",
								`**Streaming Error**: ${error.message}`,
								"Error",
							);
						}
					},
					() => {
						// RAINMAKER FIX: Check if still same agent before completing
						if (this.currentStreamingAgentId !== currentAgentId) {
							console.log("[Letta Plugin] Ignoring streaming completion from stale agent");
							return;
						}
						// Handle streaming completion
						this.markStreamingComplete();
					},
					this.streamAbortController.signal,
				);
			} else {
				// Use non-streaming API for more stable responses
				// Sending message via non-streaming API
				const messages = await this.plugin.sendMessageToAgent(processedMessage, images.length > 0 ? images : undefined);
				await this.processNonStreamingMessages(messages);
			}
		} catch (error: any) {
			console.error("Failed to send message:", error);

			// Try fallback to non-streaming API if streaming was enabled and fails with CORS or network issues
			if (
				this.plugin.settings.enableStreaming &&
				(error.message.includes("CORS_ERROR") ||
					error.message.includes("stream") ||
					error.message.includes("fetch") ||
					error.message.includes("network"))
			) {
				if (error.message.includes("CORS_ERROR")) {
					console.log(
						"[Letta Plugin] Streaming blocked by CORS, falling back to non-streaming API",
					);
				} else {
					console.log(
						"[Letta Plugin] Streaming failed, trying non-streaming fallback",
					);
				}

				try {
					const messages =
						await this.plugin.sendMessageToAgent(processedMessage, images.length > 0 ? images : undefined);
					await this.processNonStreamingMessages(messages);
					return; // Success with fallback
				} catch (fallbackError: any) {
					console.error("Fallback also failed:", fallbackError);
					error = fallbackError; // Use the fallback error for error handling
				}
			}

			// Provide specific error messages for common issues
			let errorMessage = `**Error**: ${error.message}`;

			if (
				error.message.includes("429") ||
				error.message.includes("Rate limited")
			) {
				// Use the special rate limit message display instead of regular error message
				const reason = error.message.includes("model-unknown")
					? "Unknown model configuration"
					: "Too many requests";
				const rateLimitContent = RATE_LIMIT_MESSAGE.create(reason);
				console.log(
					"[Letta Plugin] Non-streaming rate limit message content:",
					rateLimitContent,
				);
				this.addRateLimitMessage(rateLimitContent);
				return; // Return early to avoid showing regular error message
			} else if (
				error.message.includes("401") ||
				error.message.includes("Unauthorized")
			) {
				errorMessage = `**Authentication Error**\n\nYour API key may be invalid or expired. Please check your settings.\n\n*${error.message}*`;
			} else if (
				error.message.includes("403") ||
				error.message.includes("Forbidden")
			) {
				errorMessage = `**Access Denied**\n\nYou don't have permission to access this resource. Please check your account permissions.\n\n*${error.message}*`;
			} else if (
				error.message.includes("500") ||
				error.message.includes("Internal Server Error")
			) {
				errorMessage = `**Server Error**\n\nLetta's servers are experiencing issues. Please try again in a few moments.\n\n*${error.message}*`;
			} else {
				errorMessage +=
					"\n\nPlease check your connection and try again.";
			}

			await this.addMessage("assistant", errorMessage, "Error");
		} finally {
			// Hide typing indicator
			this.hideTypingIndicator();

			// Re-enable input and reset button state
			this.messageInput.disabled = false;
			this.resetSendButton();
			this.messageInput.focus();
		}
	}

	handleAutocompleteInput() {
		const cursorPos = this.messageInput.selectionStart;
		const textBeforeCursor = this.messageInput.value.substring(0, cursorPos);

		// Check for /commands first (only at start of input)
		if (textBeforeCursor.startsWith("/")) {
			const commandText = textBeforeCursor.substring(1); // Remove '/'

			// If there's a space, command selection is done
			if (commandText.includes(" ")) {
				this.hideAutocomplete();
				return;
			}

			// Filter matching commands
			const matches = SLASH_COMMANDS.filter(cmd =>
				cmd.name.toLowerCase().startsWith(commandText.toLowerCase())
			);

			if (matches.length > 0) {
				this.showCommandAutocomplete(matches);
				return;
			} else {
				this.hideAutocomplete();
				return;
			}
		}

		// Check for @-mentions
		const lastAtIndex = textBeforeCursor.lastIndexOf("@");

		if (lastAtIndex === -1) {
			this.hideAutocomplete();
			return;
		}

		// Check if there's a space between @ and cursor (means we're not in a mention anymore)
		const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1);
		if (textAfterAt.includes(" ") || textAfterAt.includes("\n")) {
			this.hideAutocomplete();
			return;
		}

		// Get the search query
		const searchQuery = textAfterAt.toLowerCase();

		// Search for matching files
		const files = this.plugin.app.vault.getMarkdownFiles();
		const matches = files
			.filter(file => {
				const fileName = file.basename.toLowerCase();
				const filePath = file.path.toLowerCase();
				return fileName.includes(searchQuery) || filePath.includes(searchQuery);
			})
			.slice(0, 10); // Limit to 10 results

		if (matches.length > 0) {
			this.showFileAutocomplete(matches, lastAtIndex);
		} else {
			this.hideAutocomplete();
		}
	}

	showCommandAutocomplete(commands: SlashCommand[]) {
		this.autocompleteMode = 'command';

		// Create dropdown if it doesn't exist
		if (!this.autocompleteDropdown) {
			this.autocompleteDropdown = this.inputContainer.createEl("div", {
				cls: "letta-autocomplete-dropdown"
			});
		}

		// Clear and populate dropdown
		this.autocompleteDropdown.empty();
		this.autocompleteDropdown.addClass("letta-command-dropdown");
		this.selectedSuggestionIndex = -1;

		commands.forEach((cmd, index) => {
			const item = this.autocompleteDropdown!.createEl("div", {
				cls: "letta-autocomplete-item letta-command-item",
				attr: { "data-index": index.toString(), "data-command": cmd.name }
			});

			const cmdName = item.createEl("div", {
				cls: "letta-command-name",
				text: `/${cmd.name}`
			});

			const cmdDesc = item.createEl("div", {
				cls: "letta-command-description",
				text: cmd.description
			});

			item.addEventListener("click", () => {
				this.insertCommand(cmd);
			});
		});

		this.autocompleteDropdown.style.display = "block";
	}

	insertCommand(cmd: SlashCommand) {
		// Replace the current text with the command
		if (cmd.usage) {
			// Commands with arguments: insert command + space
			this.messageInput.value = `/${cmd.name} `;
		} else {
			// Commands without arguments: insert and potentially execute
			this.messageInput.value = `/${cmd.name}`;
		}
		this.messageInput.focus();
		this.hideAutocomplete();

		// Move cursor to end
		const len = this.messageInput.value.length;
		this.messageInput.setSelectionRange(len, len);
	}

	showFileAutocomplete(files: any[], atPosition: number) {
		this.autocompleteMode = 'file';

		// Create dropdown if it doesn't exist
		if (!this.autocompleteDropdown) {
			this.autocompleteDropdown = this.inputContainer.createEl("div", {
				cls: "letta-autocomplete-dropdown"
			});
		}

		// Clear and populate dropdown
		this.autocompleteDropdown.empty();
		this.autocompleteDropdown.removeClass("letta-command-dropdown");
		this.selectedSuggestionIndex = -1;

		files.forEach((file, index) => {
			const item = this.autocompleteDropdown!.createEl("div", {
				cls: "letta-autocomplete-item",
				attr: { "data-index": index.toString(), "data-path": file.path }
			});

			const fileName = item.createEl("div", {
				cls: "letta-autocomplete-filename",
				text: file.basename
			});

			const filePath = item.createEl("div", {
				cls: "letta-autocomplete-path",
				text: file.path
			});

			item.addEventListener("click", () => {
				this.insertMention(file, atPosition);
			});
		});

		this.autocompleteDropdown.style.display = "block";
	}

	hideAutocomplete() {
		if (this.autocompleteDropdown) {
			this.autocompleteDropdown.style.display = "none";
			this.selectedSuggestionIndex = -1;
			this.autocompleteMode = null;
		}
	}

	navigateAutocomplete(direction: number) {
		if (!this.autocompleteDropdown) return;

		const items = this.autocompleteDropdown.querySelectorAll(".letta-autocomplete-item");
		if (items.length === 0) return;

		// Remove previous selection
		if (this.selectedSuggestionIndex >= 0) {
			items[this.selectedSuggestionIndex].removeClass("selected");
		}

		// Calculate new index
		this.selectedSuggestionIndex += direction;
		if (this.selectedSuggestionIndex < 0) {
			this.selectedSuggestionIndex = items.length - 1;
		} else if (this.selectedSuggestionIndex >= items.length) {
			this.selectedSuggestionIndex = 0;
		}

		// Add new selection
		items[this.selectedSuggestionIndex].addClass("selected");
		items[this.selectedSuggestionIndex].scrollIntoView({ block: "nearest" });
	}

	selectCurrentSuggestion() {
		if (!this.autocompleteDropdown || this.selectedSuggestionIndex < 0) return;

		const selectedItem = this.autocompleteDropdown.querySelector(
			`.letta-autocomplete-item[data-index="${this.selectedSuggestionIndex}"]`
		);

		if (selectedItem) {
			(selectedItem as HTMLElement).click();
		}
	}

	insertMention(file: any, atPosition: number) {
		const cursorPos = this.messageInput.selectionStart;
		const textBeforeCursor = this.messageInput.value.substring(0, cursorPos);
		const textAfterCursor = this.messageInput.value.substring(cursorPos);

		// Find where the @ mention started
		const mentionStart = atPosition;
		const beforeMention = this.messageInput.value.substring(0, mentionStart);

		// Insert the mention
		const mention = `@[[${file.path}]]`;
		this.messageInput.value = beforeMention + mention + " " + textAfterCursor;

		// Track the mentioned file
		this.mentionedFiles.add(file.path);

		// Set cursor position after the mention
		const newCursorPos = beforeMention.length + mention.length + 1;
		this.messageInput.setSelectionRange(newCursorPos, newCursorPos);

		// Hide autocomplete
		this.hideAutocomplete();

		// Trigger resize
		this.messageInput.style.height = "auto";
		this.messageInput.style.height = Math.min(this.messageInput.scrollHeight, 80) + "px";

		// Focus back on input
		this.messageInput.focus();
	}

	extractMentionedFiles(): string[] {
		const mentionPattern = /@\[\[([^\]]+)\]\]/g;
		const mentions: string[] = [];
		let match;

		while ((match = mentionPattern.exec(this.messageInput.value)) !== null) {
			mentions.push(match[1]);
		}

		return mentions;
	}

	// Clean up wavy lines and prominent styling from previous tool calls
	cleanupPreviousToolCalls() {
		// Remove wavy lines and prominent styling from all previous tool calls
		const allWavyLines =
			this.chatContainer.querySelectorAll(".letta-tool-curve");
		allWavyLines.forEach((line) => line.remove());

		const allProminentHeaders = this.chatContainer.querySelectorAll(
			".letta-tool-prominent",
		);
		allProminentHeaders.forEach((header) =>
			header.removeClass("letta-tool-prominent"),
		);
	}

	addToolInteractionMessage(
		reasoning: string,
		toolCall: string,
	): HTMLElement {
		// Clean up previous tool calls when a new one starts
		this.cleanupPreviousToolCalls();

		// Parse tool call to extract tool name
		let toolName = "Tool Call";
		try {
			const toolCallObj = JSON.parse(toolCall);
			if (toolCallObj.name) {
				toolName = toolCallObj.name;
			} else if (toolCallObj.function && toolCallObj.function.name) {
				toolName = toolCallObj.function.name;
			}
		} catch (e) {
			// Keep default if parsing fails
		}
		const messageEl = this.chatContainer.createEl("div", {
			cls: "letta-message letta-message-tool-interaction",
		});

		// Create bubble wrapper
		const bubbleEl = messageEl.createEl("div", {
			cls: "letta-message-bubble",
		});

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});

		// Header with timestamp
		const headerEl = bubbleEl.createEl("div", {
			cls: "letta-message-header",
		});
		const leftSide = headerEl.createEl("div", {
			cls: "letta-message-header-left",
		});
		leftSide.createEl("span", {
			cls: "letta-message-title",
			text: "Tool Usage",
		});
		leftSide.createEl("span", {
			cls: "letta-message-timestamp",
			text: timestamp,
		});

		// Reasoning content (only visible if setting is enabled)
		if (reasoning && this.plugin.settings.showReasoning) {
			const reasoningEl = bubbleEl.createEl("div", {
				cls: "letta-tool-reasoning",
			});

			// Enhanced markdown-like formatting for reasoning
			let formattedReasoning = reasoning
				// Trim leading and trailing whitespace first
				.trim()
				// Normalize multiple consecutive newlines to double newlines
				.replace(/\n{3,}/g, "\n\n")
				// Handle headers (must be done before other formatting)
				.replace(/^### (.+)$/gm, "<h3>$1</h3>")
				.replace(/^## (.+)$/gm, "<h2>$1</h2>")
				.replace(/^# (.+)$/gm, "<h1>$1</h1>")
				// Handle bold and italic
				.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
				.replace(/\*(.*?)\*/g, "<em>$1</em>")
				.replace(/`([^`]+)`/g, "<code>$1</code>")
				// Handle numbered lists (1. 2. 3. etc.)
				.replace(
					/^(\d+)\.\s+(.+)$/gm,
					'<li class="numbered-list">$2</li>',
				)
				// Handle bullet lists (•, -, *)
				.replace(/^[•*-]\s+(.+)$/gm, "<li>$1</li>")
				// Handle double newlines as paragraph breaks first
				.replace(/\n\n/g, "</p><p>")
				// Convert remaining single newlines to <br> tags
				.replace(/\n/g, "<br>");

			// Wrap consecutive numbered list items in <ol> tags
			formattedReasoning = formattedReasoning.replace(
				/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g,
				(match) => {
					// Remove the <br> tags between numbered list items and wrap in <ol>
					const cleanMatch = match.replace(/<br>\s*/g, "");
					return "<ol>" + cleanMatch + "</ol>";
				},
			);

			// Wrap consecutive regular list items in <ul> tags
			formattedReasoning = formattedReasoning.replace(
				/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g,
				(match) => {
					// Remove the <br> tags between list items and wrap in <ul>
					const cleanMatch = match.replace(/<br>\s*/g, "");
					return "<ul>" + cleanMatch + "</ul>";
				},
			);

			// Wrap in paragraphs if needed
			if (
				formattedReasoning.includes("</p><p>") &&
				!formattedReasoning.startsWith("<")
			) {
				formattedReasoning = "<p>" + formattedReasoning + "</p>";
			}

			reasoningEl.innerHTML = formattedReasoning;
		}

		// Normal expandable display for all tools
		const toolCallHeader = bubbleEl.createEl("div", {
			cls: "letta-expandable-header letta-tool-section letta-tool-prominent",
		});

		// Left side with tool name and loading
		const toolLeftSide = toolCallHeader.createEl("div", {
			cls: "letta-tool-left",
		});
		const toolTitle = toolLeftSide.createEl("span", {
			cls: "letta-expandable-title letta-tool-name",
			text: toolName,
		});

		// No loading indicator - just the wavy line animation shows loading state

		// Curvy connecting line (SVG) - continuous flowing wave
		const connectionLine = toolCallHeader.createEl("div", {
			cls: "letta-tool-connection",
		});
		const svg = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"svg",
		);
		svg.setAttribute("viewBox", "0 0 400 12");
		svg.setAttribute("preserveAspectRatio", "none");
		svg.setAttribute("class", "letta-tool-curve");

		const path = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"path",
		);
		path.setAttribute(
			"d",
			"M 0,6 Q 12.5,2 25,6 Q 37.5,10 50,6 Q 62.5,2 75,6 Q 87.5,10 100,6 Q 112.5,2 125,6 Q 137.5,10 150,6 Q 162.5,2 175,6 Q 187.5,10 200,6 Q 212.5,2 225,6 Q 237.5,10 250,6 Q 262.5,2 275,6 Q 287.5,10 300,6 Q 312.5,2 325,6 Q 337.5,10 350,6 Q 362.5,2 375,6 Q 387.5,10 400,6 Q 412.5,2 425,6 Q 437.5,10 450,6",
		);
		path.setAttribute("stroke", "var(--interactive-accent)");
		path.setAttribute("stroke-width", "1.5");
		path.setAttribute("fill", "none");
		path.setAttribute("opacity", "0.7");

		svg.appendChild(path);
		connectionLine.appendChild(svg);

		// Right side with circle indicator
		const toolRightSide = toolCallHeader.createEl("div", {
			cls: "letta-tool-right",
		});
		const toolCallChevron = toolRightSide.createEl("span", {
			cls: "letta-expandable-chevron letta-tool-circle",
			text: "○",
		});

		const toolCallContent = bubbleEl.createEl("div", {
			cls: "letta-expandable-content letta-expandable-collapsed",
		});
		const toolCallPre = toolCallContent.createEl("pre", {
			cls: "letta-code-block",
		});

		// Extract and pretty-print just the arguments from the tool call
		let displayContent = toolCall;
		try {
			const toolCallObj = JSON.parse(toolCall);
			if (toolCallObj.arguments) {
				// Parse the arguments if they're a string, otherwise use directly
				let args = toolCallObj.arguments;
				if (typeof args === "string") {
					args = JSON.parse(args);
				}
				displayContent = JSON.stringify(args, null, 2);
			}
		} catch (e) {
			// If parsing fails, fall back to the original content
		}

		const codeEl = toolCallPre.createEl("code", { text: displayContent });
		// Store the tool name in a data attribute for reliable parsing
		codeEl.setAttribute("data-tool-name", toolName);

		// Add click handler for tool call expand/collapse
		toolCallHeader.addEventListener("click", () => {
			const isCollapsed = toolCallContent.classList.contains(
				"letta-expandable-collapsed",
			);
			if (isCollapsed) {
				toolCallContent.removeClass("letta-expandable-collapsed");
				toolCallChevron.textContent = "●";
			} else {
				toolCallContent.addClass("letta-expandable-collapsed");
				toolCallChevron.textContent = "○";
			}
		});

		// Tool result placeholder (will be filled later)
		const toolResultHeader = bubbleEl.createEl("div", {
			cls: "letta-expandable-header letta-tool-section letta-tool-result-pending",
		});
		toolResultHeader.addClass("letta-tool-result-hidden");
		const toolResultTitle = toolResultHeader.createEl("span", {
			cls: "letta-expandable-title",
			text: "Tool Result",
		});
		const toolResultChevron = toolResultHeader.createEl("span", {
			cls: "letta-expandable-chevron letta-tool-circle",
			text: "○",
		});

		const toolResultContent = bubbleEl.createEl("div", {
			cls: "letta-expandable-content letta-expandable-collapsed",
		});
		toolResultContent.addClass("letta-tool-content-hidden");

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 10);

		return messageEl;
	}

	async addToolResultToMessage(
		messageEl: HTMLElement,
		toolResult: string,
		toolName?: string,
		toolCallData?: any,
	) {
		const bubbleEl = messageEl.querySelector(".letta-message-bubble");
		if (!bubbleEl) return;

		// Loading state was shown by wavy line animation only (no text indicator)

		// Remove wavy line animation now that tool call is complete
		const wavyLine = bubbleEl.querySelector(".letta-tool-curve");
		if (wavyLine) {
			wavyLine.remove();
		}

		// Remove prominent styling from tool call header now that it's complete
		const toolCallHeader = bubbleEl.querySelector(".letta-tool-prominent");
		if (toolCallHeader) {
			toolCallHeader.removeClass("letta-tool-prominent");
		}

		// Detect tool type - use provided toolName and toolCallData if available, otherwise parse from DOM
		let isArchivalMemorySearch = false;
		let isArchivalMemoryInsert = false;
		let isObsidianNoteProposal = false;
		let isVaultTool = false;
		let effectiveToolCallData = toolCallData;

		// Vault tool names
		const vaultToolNames = [
			"write_obsidian_note",
			"obsidian_read_file",
			"obsidian_search_vault",
			"obsidian_list_files",
			"obsidian_modify_file",
			"obsidian_delete_file",
			"obsidian_create_folder",
			"obsidian_rename",
			"obsidian_move",
			"obsidian_copy_file",
			"obsidian_get_metadata"
		];

		if (toolName) {
			// Use provided tool name (for historical messages)
			isArchivalMemorySearch = toolName === "archival_memory_search";
			isArchivalMemoryInsert = toolName === "archival_memory_insert";
			isObsidianNoteProposal = toolName === "propose_obsidian_note";
			isVaultTool = vaultToolNames.includes(toolName);
		} else {
			// Parse from DOM (for streaming messages)
			try {
				const toolCallPre = bubbleEl.querySelector(
					".letta-code-block code",
				);
				if (toolCallPre) {
					// First try to get tool name from data attribute (more reliable)
					const detectedToolName = toolCallPre.getAttribute("data-tool-name");
					console.log("[Letta Plugin] DOM parsing - data-tool-name:", detectedToolName);
					if (detectedToolName) {
						isArchivalMemorySearch = detectedToolName === "archival_memory_search";
						isArchivalMemoryInsert = detectedToolName === "archival_memory_insert";
						isObsidianNoteProposal = detectedToolName === "propose_obsidian_note";
						isVaultTool = vaultToolNames.includes(detectedToolName);
					} else {
						// Fallback to parsing from content (legacy)
						effectiveToolCallData = JSON.parse(
							toolCallPre.textContent || "{}",
						);
						const fallbackToolName =
							effectiveToolCallData.name ||
							(effectiveToolCallData.function &&
								effectiveToolCallData.function.name);
						isArchivalMemorySearch =
							fallbackToolName === "archival_memory_search";
						isArchivalMemoryInsert =
							fallbackToolName === "archival_memory_insert";
						isObsidianNoteProposal =
							fallbackToolName === "propose_obsidian_note";
						isVaultTool = vaultToolNames.includes(fallbackToolName);
					}
				}
			} catch (e) {
				// Ignore parsing errors
			}
		}

		// Fallback detection: check tool result content for vault actions
		let vaultAction: any = null;
		try {
			const parsedResult = JSON.parse(toolResult);
			if (parsedResult.action) {
				vaultAction = parsedResult;
				isVaultTool = true;

				// Check for legacy note proposal format
				if (parsedResult.action === "create_note" && parsedResult.title && parsedResult.content) {
					console.log("[Letta Plugin] 🔍 Fallback detection: Found note proposal in tool result!");
					isObsidianNoteProposal = true;
				}
			}
		} catch (e) {
			// Not JSON or not a vault action, continue normally
		}

		// Debug logging for tool detection
		console.log("[Letta Plugin] Tool detection results:", {
			toolName,
			detectedFromDOM: !toolName,
			isArchivalMemorySearch,
			isArchivalMemoryInsert,
			isObsidianNoteProposal,
			isVaultTool,
			vaultAction: vaultAction?.action,
			toolResultPreview: toolResult.substring(0, 100) + "..."
		});


		// Show the tool result section
		const toolResultHeader = bubbleEl.querySelector(
			".letta-tool-result-pending",
		) as HTMLElement;
		const toolResultContent = bubbleEl.querySelector(
			".letta-expandable-content:last-child",
		) as HTMLElement;

		if (toolResultHeader && toolResultContent) {
			// Format the result and get a preview
			const formattedResult = this.formatToolResult(toolResult);

			// Always use "Tool Result" as the label (don't show content preview)
			const toolResultTitle = toolResultHeader.querySelector(
				".letta-expandable-title",
			);
			if (toolResultTitle) {
				toolResultTitle.textContent = "Tool Result";
			}

			// Make visible
			toolResultHeader.removeClass("letta-tool-result-hidden");
			toolResultHeader.addClass("letta-tool-result-visible");
			toolResultContent.removeClass("letta-tool-content-hidden");
			toolResultContent.addClass("letta-tool-content-visible");
			toolResultHeader.removeClass("letta-tool-result-pending");

			// Handle special tool types
			if (isArchivalMemorySearch) {
				this.createArchivalMemoryDisplay(toolResultContent, toolResult);
			} else if (isArchivalMemoryInsert) {
				this.createArchivalMemoryInsertDisplay(
					toolResultContent,
					effectiveToolCallData,
					toolResult,
				);
			} else if (isObsidianNoteProposal) {
				// Show pretty note preview instead of raw JSON for note proposals
				this.createNotePreviewDisplay(toolResultContent, toolResult);
			} else if (isVaultTool && vaultAction) {
				// Execute vault tool and display result
				await this.executeVaultToolAndDisplay(toolResultContent, vaultAction, toolName);
			} else {
				// Add full content to expandable section for other tools
				const toolResultDiv = toolResultContent.createEl("div", {
					cls: "letta-tool-result-text",
					text: formattedResult,
				});
			}

			// Add click handler for tool result expand/collapse
			const toolResultChevron = toolResultHeader.querySelector(
				".letta-expandable-chevron",
			);
			toolResultHeader.addEventListener("click", () => {
				const isCollapsed = toolResultContent.classList.contains(
					"letta-expandable-collapsed",
				);
				if (isCollapsed) {
					toolResultContent.removeClass("letta-expandable-collapsed");
					if (toolResultChevron) toolResultChevron.textContent = "●";
				} else {
					toolResultContent.addClass("letta-expandable-collapsed");
					if (toolResultChevron) toolResultChevron.textContent = "○";
				}
			});

			// Post-processing enhancement for note proposals
			if (isObsidianNoteProposal) {
				console.log("[Letta Plugin] 🎯 Note proposal detected! Starting enhancement...");
				setTimeout(async () => {
					try {
						await this.enhanceNoteProposalDisplay(toolResultContent, toolResult);
					} catch (error) {
						console.error("[Letta Plugin] ❌ Error during note proposal enhancement:", error);
					}
				}, 10); // Reduced delay for faster appearance
			}
		}

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 10);
	}

	createArchivalMemoryDisplay(container: HTMLElement, toolResult: string) {
		try {
			let result;
			let rawContent = toolResult.trim();

			// Handle JSON-encoded string containing Python tuple format
			if (rawContent.startsWith('"') && rawContent.endsWith('"')) {
				const parsedString = JSON.parse(rawContent);

				if (
					parsedString.startsWith("(") &&
					parsedString.endsWith(")")
				) {
					// Extract array from Python tuple: ([...], count) -> [...]
					const innerContent = parsedString.slice(1, -1);
					const match = innerContent.match(/^(.+),\s*(\d+)$/);

					if (match) {
						const arrayString = match[1];
						// Extract memory items manually from Python dict format
						const dictPattern =
							/\{'timestamp':\s*'([^']+)',\s*'content':\s*'((?:[^'\\]|\\.)*)'\}/g;
						const memoryItems = [];
						let dictMatch;

						while (
							(dictMatch = dictPattern.exec(arrayString)) !== null
						) {
							const timestamp = dictMatch[1];
							const content = dictMatch[2]
								.replace(/\\'/g, "'")
								.replace(/\\n/g, "\n")
								.replace(/\\t/g, "\t")
								.replace(/\\"/g, '"');
							memoryItems.push({ timestamp, content });
						}

						result = memoryItems;
					} else {
						result = JSON.parse(parsedString);
					}
				} else {
					result = JSON.parse(parsedString);
				}
			} else if (rawContent.startsWith("(") && rawContent.endsWith(")")) {
				// Handle direct Python tuple format
				const innerContent = rawContent.slice(1, -1);
				const match = innerContent.match(/^(.+),\s*(\d+)$/);
				if (match) {
					let arrayString = match[1];
					arrayString = arrayString
						.replace(/None/g, "null")
						.replace(/True/g, "true")
						.replace(/False/g, "false")
						.replace(/'/g, '"');
					result = JSON.parse(arrayString);
				} else {
					result = JSON.parse(rawContent);
				}
			} else {
				result = JSON.parse(rawContent);
			}

			// Check if it's an array (archival memory search results)
			if (Array.isArray(result) && result.length > 0) {
				const memoryList = container.createEl("div", {
					cls: "letta-memory-list",
				});

				// Filter out non-memory items (like count at the end)
				const memoryItems = result.filter(
					(item) =>
						typeof item === "object" &&
						item !== null &&
						(item.content || item.text || item.message),
				);

				memoryItems.forEach((item, index) => {
					// Create expandable memory item
					const memoryItem = memoryList.createEl("div", {
						cls: "letta-memory-item",
					});

					// Extract content and timestamp
					const content =
						item.content || item.text || item.message || "";
					const timestamp = item.timestamp || "";

					// Create expandable header
					const itemHeader = memoryItem.createEl("div", {
						cls: "letta-memory-item-header letta-expandable-header",
					});

					// Add expand/collapse indicator
					const chevron = itemHeader.createEl("span", {
						cls: "letta-expandable-chevron",
						text: "○",
					});

					// Add memory item title with timestamp
					const titleText = "";

					itemHeader.createEl("span", {
						cls: "letta-memory-title",
						text: titleText,
					});

					// Add preview of content (first 80 characters)
					const preview =
						content.length > 80
							? content.substring(0, 80).trim() + "..."
							: content;

					itemHeader.createEl("span", {
						cls: "letta-memory-preview",
						text: preview,
					});

					// Create collapsible content area
					const itemContent = memoryItem.createEl("div", {
						cls: "letta-memory-content letta-expandable-content letta-expandable-collapsed",
					});

					// Apply markdown formatting to the full content
					let formattedContent = content
						.trim()
						.replace(/\n{3,}/g, "\n\n")
						// Handle headers
						.replace(/^### (.+)$/gm, "<h3>$1</h3>")
						.replace(/^## (.+)$/gm, "<h2>$1</h2>")
						.replace(/^# (.+)$/gm, "<h1>$1</h1>")
						// Handle bold and italic
						.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
						.replace(/\*(.*?)\*/g, "<em>$1</em>")
						.replace(/`([^`]+)`/g, "<code>$1</code>")
						// Handle bullet lists
						.replace(/^[•*-]\s+(.+)$/gm, "<li>$1</li>")
						// Convert line breaks to HTML
						.replace(/\n/g, "<br>");

					// Wrap consecutive list items in ul tags
					formattedContent = formattedContent.replace(
						/(<li>.*?<\/li>)(?:\s*<li>.*?<\/li>)*/g,
						(match: string) => {
							return "<ul>" + match + "</ul>";
						},
					);

					itemContent.innerHTML = formattedContent;

					// Add click handler for expand/collapse
					itemHeader.addEventListener("click", () => {
						const isCollapsed = itemContent.classList.contains(
							"letta-expandable-collapsed",
						);
						if (isCollapsed) {
							itemContent.removeClass(
								"letta-expandable-collapsed",
							);
							chevron.textContent = "●";
						} else {
							itemContent.addClass("letta-expandable-collapsed");
							chevron.textContent = "○";
						}
					});
				});

				// Add summary at the bottom
				if (memoryItems.length > 0) {
					const summary = container.createEl("div", {
						cls: "letta-memory-summary",
					});
					summary.createEl("span", {
						text: `Found ${memoryItems.length} memory item${memoryItems.length === 1 ? "" : "s"}`,
					});
				}
			} else if (result && typeof result === "object") {
				// Single item or different structure
				const singleItem = container.createEl("div", {
					cls: "letta-memory-single",
				});

				let content =
					result.content ||
					result.text ||
					result.message ||
					JSON.stringify(result, null, 2);
				let formattedContent = content
					.trim()
					.replace(/\n{3,}/g, "\n\n")
					.replace(/^### (.+)$/gm, "<h3>$1</h3>")
					.replace(/^## (.+)$/gm, "<h2>$1</h2>")
					.replace(/^# (.+)$/gm, "<h1>$1</h1>")
					.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
					.replace(/\*(.*?)\*/g, "<em>$1</em>")
					.replace(/`([^`]+)`/g, "<code>$1</code>")
					.replace(/\n/g, "<br>");

				singleItem.innerHTML = formattedContent;
			} else {
				// Fallback to raw display
				const fallback = container.createEl("div", {
					cls: "letta-tool-result-text",
				});
				fallback.textContent = toolResult;
			}
		} catch (e) {
			// If parsing fails, fall back to raw display
			const fallback = container.createEl("div", {
				cls: "letta-tool-result-text",
			});
			fallback.textContent = toolResult;
		}
	}

	createArchivalMemoryInsertDisplay(
		container: HTMLElement,
		toolCallData: any,
		toolResult: string,
	) {
		try {
			// Extract the content from the tool call arguments
			let memoryContent = "";

			if (toolCallData) {
				let args = null;

				// Try different argument formats
				if (toolCallData.arguments) {
					// Standard format: { arguments: "..." } or { arguments: {...} }
					if (typeof toolCallData.arguments === "string") {
						try {
							args = JSON.parse(toolCallData.arguments);
						} catch (e) {
							console.warn(
								"[Letta Plugin] Failed to parse arguments string:",
								toolCallData.arguments,
							);
						}
					} else {
						args = toolCallData.arguments;
					}
				} else if (
					toolCallData.function &&
					toolCallData.function.arguments
				) {
					// OpenAI format: { function: { arguments: "..." } }
					if (typeof toolCallData.function.arguments === "string") {
						try {
							args = JSON.parse(toolCallData.function.arguments);
						} catch (e) {
							console.warn(
								"[Letta Plugin] Failed to parse function arguments string:",
								toolCallData.function.arguments,
							);
						}
					} else {
						args = toolCallData.function.arguments;
					}
				}

				// Extract content from parsed arguments
				if (args && args.content) {
					memoryContent = args.content;
				}
			}

			if (memoryContent) {
				// Add a simple header to indicate this is the content being stored
				const header = container.createEl("div", {
					cls: "letta-memory-insert-header",
				});
				header.createEl("span", {
					cls: "letta-memory-insert-label",
					text: "Content stored in archival memory:",
				});

				// Create simple content area with markdown formatting
				const contentArea = container.createEl("div", {
					cls: "letta-memory-insert-content",
				});

				// Apply basic markdown formatting to the content
				let formattedContent = memoryContent
					.trim()
					.replace(/\n{3,}/g, "\n\n")
					// Handle headers
					.replace(/^### (.+)$/gm, "<h3>$1</h3>")
					.replace(/^## (.+)$/gm, "<h2>$1</h2>")
					.replace(/^# (.+)$/gm, "<h1>$1</h1>")
					// Handle bold and italic
					.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
					.replace(/\*(.*?)\*/g, "<em>$1</em>")
					.replace(/`([^`]+)`/g, "<code>$1</code>")
					// Convert line breaks to HTML
					.replace(/\n/g, "<br>");

				contentArea.innerHTML = formattedContent;
			} else {
				// Fallback if we can't extract the content
				const fallback = container.createEl("div", {
					cls: "letta-tool-result-text",
				});
				fallback.textContent = `Memory insert completed. Result: ${toolResult}`;
			}
		} catch (e) {
			console.error(
				"[Letta Plugin] Error creating archival memory insert display:",
				e,
			);
			// If parsing fails, fall back to raw display
			const fallback = container.createEl("div", {
				cls: "letta-tool-result-text",
			});
			fallback.textContent = `Memory insert completed. Result: ${toolResult}`;
		}
	}

	// ========================================
	// Vault Tool Execution Methods
	// ========================================

	async executeVaultToolAndDisplay(
		container: HTMLElement,
		vaultAction: any,
		toolName?: string
	): Promise<void> {
		console.log("[Letta Plugin] Executing vault tool:", vaultAction.action, vaultAction);

		try {
			let result: any;

			switch (vaultAction.action) {
				case "read_file":
					result = await this.executeReadFile(vaultAction);
					this.displayReadFileResult(container, result);
					break;

				case "search_vault":
					result = await this.executeSearchVault(vaultAction);
					this.displaySearchResult(container, result);
					break;

				case "list_files":
					result = await this.executeListFiles(vaultAction);
					this.displayListFilesResult(container, result);
					break;

				case "write_file":
					result = await this.executeWriteFile(vaultAction);
					this.displayWriteResult(container, result);
					break;

				case "modify_file":
					result = await this.executeModifyFile(vaultAction);
					this.displayModifyResult(container, result);
					break;

				case "delete_file":
					result = await this.executeDeleteFile(vaultAction);
					this.displayDeleteResult(container, result);
					break;

				case "create_folder":
					result = await this.executeCreateFolder(vaultAction);
					this.displayCreateFolderResult(container, result);
					break;

				case "rename":
					result = await this.executeRename(vaultAction);
					this.displayRenameResult(container, result);
					break;

				case "move":
					result = await this.executeMove(vaultAction);
					this.displayMoveResult(container, result);
					break;

				case "copy_file":
					result = await this.executeCopyFile(vaultAction);
					this.displayCopyResult(container, result);
					break;

				case "get_metadata":
					result = await this.executeGetMetadata(vaultAction);
					this.displayMetadataResult(container, result);
					break;

				default:
					container.createEl("div", {
						cls: "letta-tool-result-text",
						text: `Unknown vault action: ${vaultAction.action}`,
					});
			}
		} catch (error: any) {
			console.error("[Letta Plugin] Vault tool execution error:", error);
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: `Error: ${error.message}`,
			});
		}
	}

	// Read a file from the vault
	async executeReadFile(action: any): Promise<any> {
		const filePath = action.file_path;

		// Check if folder is blocked
		const folderPath = filePath.substring(0, filePath.lastIndexOf("/")) || "";
		if (this.plugin.isFolderBlocked(folderPath)) {
			return { error: `Access denied: ${folderPath} is a restricted folder` };
		}

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			return { error: `File not found: ${filePath}` };
		}

		const content = await this.app.vault.read(file);

		const result: any = {
			path: file.path,
			name: file.basename,
			content: content,
		};

		if (action.include_metadata !== false) {
			const cache = this.app.metadataCache.getFileCache(file);
			result.frontmatter = cache?.frontmatter || {};
			result.tags = cache?.tags?.map((t) => t.tag) || [];
			result.headings = cache?.headings?.map((h) => ({ level: h.level, heading: h.heading })) || [];
			result.links = cache?.links?.map((l) => l.link) || [];
			result.created = file.stat.ctime;
			result.modified = file.stat.mtime;
			result.size = file.stat.size;
		}

		return result;
	}

	// Search the vault
	async executeSearchVault(action: any): Promise<any> {
		const query = (action.query || "").toLowerCase();
		const searchType = action.search_type || "all";
		const folder = action.folder || "";
		const limit = action.limit || 20;

		const files = this.app.vault.getMarkdownFiles();
		const results: any[] = [];

		for (const file of files) {
			if (results.length >= limit) break;

			// Filter by folder
			if (folder && !file.path.startsWith(folder)) continue;

			// Check if folder is blocked
			const fileFolder = file.path.substring(0, file.path.lastIndexOf("/")) || "";
			if (this.plugin.isFolderBlocked(fileFolder)) continue;

			let matched = false;
			const cache = this.app.metadataCache.getFileCache(file);

			switch (searchType) {
				case "name":
					matched = file.basename.toLowerCase().includes(query);
					break;
				case "tags":
					const tags = cache?.tags?.map((t) => t.tag.toLowerCase()) || [];
					matched = tags.some((t) => t.includes(query));
					break;
				case "content":
					const content = await this.app.vault.cachedRead(file);
					matched = content.toLowerCase().includes(query);
					break;
				case "path":
					matched = file.path.toLowerCase().includes(query);
					break;
				case "all":
				default:
					matched = file.basename.toLowerCase().includes(query) ||
						file.path.toLowerCase().includes(query);
					if (!matched) {
						const fileTags = cache?.tags?.map((t) => t.tag.toLowerCase()) || [];
						matched = fileTags.some((t) => t.includes(query));
					}
					if (!matched && query) {
						const fileContent = await this.app.vault.cachedRead(file);
						matched = fileContent.toLowerCase().includes(query);
					}
					break;
			}

			if (matched) {
				const content = await this.app.vault.cachedRead(file);
				results.push({
					path: file.path,
					name: file.basename,
					folder: file.parent?.path || "",
					modified: file.stat.mtime,
					preview: content.substring(0, 200) + (content.length > 200 ? "..." : ""),
				});
			}
		}

		return {
			query: action.query,
			search_type: searchType,
			results: results,
			total_found: results.length,
		};
	}

	// List files in a folder
	async executeListFiles(action: any): Promise<any> {
		const folder = action.folder || "";
		const recursive = action.recursive || false;
		const limit = action.limit || 50;

		// Check if folder is blocked
		if (folder && this.plugin.isFolderBlocked(folder)) {
			return { error: `Access denied: ${folder} is a restricted folder` };
		}

		const files = this.app.vault.getMarkdownFiles();
		const results: any[] = [];

		for (const file of files) {
			if (results.length >= limit) break;

			// Filter by folder
			if (folder) {
				if (recursive) {
					if (!file.path.startsWith(folder + "/") && file.path !== folder) continue;
				} else {
					const fileFolder = file.parent?.path || "";
					if (fileFolder !== folder) continue;
				}
			} else if (!recursive) {
				// Root folder only
				if (file.parent?.path) continue;
			}

			// Check if folder is blocked
			const fileFolder = file.path.substring(0, file.path.lastIndexOf("/")) || "";
			if (this.plugin.isFolderBlocked(fileFolder)) continue;

			const cache = this.app.metadataCache.getFileCache(file);
			results.push({
				path: file.path,
				name: file.basename,
				folder: file.parent?.path || "",
				modified: file.stat.mtime,
				size: file.stat.size,
				tags: cache?.tags?.map((t) => t.tag) || [],
			});
		}

		return {
			folder: folder || "(vault root)",
			recursive: recursive,
			files: results,
			total: results.length,
		};
	}

	// Write/create a file (requires approval)
	async executeWriteFile(action: any): Promise<any> {
		const title = action.title;
		const content = action.content;
		const folder = action.folder || this.plugin.settings.defaultNoteFolder;

		// Check if folder is blocked
		if (folder && this.plugin.isFolderBlocked(folder)) {
			return { error: `Access denied: ${folder} is a restricted folder` };
		}

		// Check for session approval
		if (action.requires_approval && !this.plugin.settings.vaultToolsApprovedThisSession) {
			// Show approval modal
			const approved = await this.showVaultApprovalModal("write", { title, folder, content });
			if (!approved) {
				return { error: "User declined write operation" };
			}
		}

		// Sanitize filename
		const sanitizedTitle = title.replace(/[\\/:*?"<>|]/g, "_");
		const fileName = `${sanitizedTitle}.md`;
		const filePath = folder ? `${folder}/${fileName}` : fileName;

		// Create folder if needed
		if (folder) {
			const folderExists = this.app.vault.getAbstractFileByPath(folder);
			if (!folderExists) {
				await this.app.vault.createFolder(folder);
			}
		}

		// Create or overwrite file
		const existingFile = this.app.vault.getAbstractFileByPath(filePath);
		if (existingFile instanceof TFile) {
			await this.app.vault.modify(existingFile, content);
		} else {
			await this.app.vault.create(filePath, content);
		}

		return {
			success: true,
			path: filePath,
			action: existingFile ? "modified" : "created",
		};
	}

	// Modify an existing file (requires approval)
	async executeModifyFile(action: any): Promise<any> {
		const filePath = action.file_path;
		const operation = action.operation;
		const content = action.content;
		const sectionHeading = action.section_heading;

		// Check if folder is blocked
		const folder = filePath.substring(0, filePath.lastIndexOf("/")) || "";
		if (this.plugin.isFolderBlocked(folder)) {
			return { error: `Access denied: ${folder} is a restricted folder` };
		}

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			return { error: `File not found: ${filePath}` };
		}

		// Check for session approval
		if (action.requires_approval && !this.plugin.settings.vaultToolsApprovedThisSession) {
			const approved = await this.showVaultApprovalModal("modify", { filePath, operation, content });
			if (!approved) {
				return { error: "User declined modify operation" };
			}
		}

		const existingContent = await this.app.vault.read(file);
		let newContent: string;

		switch (operation) {
			case "append":
				newContent = existingContent + "\n" + content;
				break;
			case "prepend":
				newContent = content + "\n" + existingContent;
				break;
			case "replace_section":
				if (!sectionHeading) {
					return { error: "section_heading required for replace_section operation" };
				}
				// Find and replace section
				const sectionRegex = new RegExp(
					`(${sectionHeading}[^\n]*\n)([\\s\\S]*?)(?=\n#{1,6}\\s|$)`,
					"m"
				);
				if (sectionRegex.test(existingContent)) {
					newContent = existingContent.replace(sectionRegex, `$1${content}\n`);
				} else {
					// Section not found, append at end
					newContent = existingContent + `\n\n${sectionHeading}\n${content}`;
				}
				break;
			default:
				return { error: `Unknown operation: ${operation}` };
		}

		await this.app.vault.modify(file, newContent);

		return {
			success: true,
			path: filePath,
			operation: operation,
		};
	}

	// Delete a file (requires approval)
	async executeDeleteFile(action: any): Promise<any> {
		const filePath = action.file_path;
		const moveToTrash = action.move_to_trash !== false;

		// Check if folder is blocked
		const folder = filePath.substring(0, filePath.lastIndexOf("/")) || "";
		if (this.plugin.isFolderBlocked(folder)) {
			return { error: `Access denied: ${folder} is a restricted folder` };
		}

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			return { error: `File not found: ${filePath}` };
		}

		// Always require approval for delete
		if (!this.plugin.settings.vaultToolsApprovedThisSession) {
			const approved = await this.showVaultApprovalModal("delete", { filePath, moveToTrash });
			if (!approved) {
				return { error: "User declined delete operation" };
			}
		}

		if (moveToTrash) {
			await this.app.vault.trash(file, true);
		} else {
			await this.app.vault.delete(file);
		}

		return {
			success: true,
			path: filePath,
			action: moveToTrash ? "moved_to_trash" : "permanently_deleted",
		};
	}

	// Create a folder in the vault
	async executeCreateFolder(action: any): Promise<any> {
		const folderPath = action.folder_path;

		// Check if parent folder is blocked
		const parentPath = folderPath.substring(0, folderPath.lastIndexOf("/")) || "";
		if (parentPath && this.plugin.isFolderBlocked(parentPath)) {
			return { error: `Access denied: ${parentPath} is a restricted folder` };
		}

		// Check if folder already exists
		const existing = this.app.vault.getAbstractFileByPath(folderPath);
		if (existing) {
			return { error: `Folder already exists: ${folderPath}` };
		}

		await this.app.vault.createFolder(folderPath);

		return {
			success: true,
			path: folderPath,
			action: "created",
		};
	}

	// Rename a file or folder
	async executeRename(action: any): Promise<any> {
		const oldPath = action.old_path;
		const newName = action.new_name;

		// Check if folder is blocked
		const folder = oldPath.substring(0, oldPath.lastIndexOf("/")) || "";
		if (folder && this.plugin.isFolderBlocked(folder)) {
			return { error: `Access denied: ${folder} is a restricted folder` };
		}

		const file = this.app.vault.getAbstractFileByPath(oldPath);
		if (!file) {
			return { error: `File or folder not found: ${oldPath}` };
		}

		// Require approval for rename
		if (action.requires_approval && !this.plugin.settings.vaultToolsApprovedThisSession) {
			const approved = await this.showVaultApprovalModal("rename", { oldPath, newName });
			if (!approved) {
				return { error: "User declined rename operation" };
			}
		}

		// Calculate new path (preserve extension for files)
		let newPath: string;
		if (file instanceof TFile) {
			const extension = file.extension;
			const baseName = newName.endsWith(`.${extension}`) ? newName : `${newName}.${extension}`;
			newPath = folder ? `${folder}/${baseName}` : baseName;
		} else {
			newPath = folder ? `${folder}/${newName}` : newName;
		}

		await this.app.fileManager.renameFile(file, newPath);

		return {
			success: true,
			old_path: oldPath,
			new_path: newPath,
			action: "renamed",
		};
	}

	// Move a file or folder to a new location
	async executeMove(action: any): Promise<any> {
		const sourcePath = action.source_path;
		const destFolder = action.destination_folder;

		// Check source folder
		const sourceFolder = sourcePath.substring(0, sourcePath.lastIndexOf("/")) || "";
		if (sourceFolder && this.plugin.isFolderBlocked(sourceFolder)) {
			return { error: `Access denied: ${sourceFolder} is a restricted folder` };
		}

		// Check destination folder
		if (this.plugin.isFolderBlocked(destFolder)) {
			return { error: `Access denied: ${destFolder} is a restricted folder` };
		}

		const file = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!file) {
			return { error: `File or folder not found: ${sourcePath}` };
		}

		// Require approval for move
		if (action.requires_approval && !this.plugin.settings.vaultToolsApprovedThisSession) {
			const approved = await this.showVaultApprovalModal("move", { sourcePath, destFolder });
			if (!approved) {
				return { error: "User declined move operation" };
			}
		}

		// Calculate new path
		const fileName = sourcePath.substring(sourcePath.lastIndexOf("/") + 1);
		const newPath = destFolder ? `${destFolder}/${fileName}` : fileName;

		// Create destination folder if needed
		if (destFolder) {
			const folderExists = this.app.vault.getAbstractFileByPath(destFolder);
			if (!folderExists) {
				await this.app.vault.createFolder(destFolder);
			}
		}

		await this.app.fileManager.renameFile(file, newPath);

		return {
			success: true,
			old_path: sourcePath,
			new_path: newPath,
			action: "moved",
		};
	}

	// Copy a file to a new location
	async executeCopyFile(action: any): Promise<any> {
		const sourcePath = action.source_path;
		const destPath = action.destination_path;

		// Check source folder
		const sourceFolder = sourcePath.substring(0, sourcePath.lastIndexOf("/")) || "";
		if (sourceFolder && this.plugin.isFolderBlocked(sourceFolder)) {
			return { error: `Access denied: ${sourceFolder} is a restricted folder` };
		}

		// Check destination folder
		const destFolder = destPath.substring(0, destPath.lastIndexOf("/")) || "";
		if (destFolder && this.plugin.isFolderBlocked(destFolder)) {
			return { error: `Access denied: ${destFolder} is a restricted folder` };
		}

		const sourceFile = this.app.vault.getAbstractFileByPath(sourcePath);
		if (!(sourceFile instanceof TFile)) {
			return { error: `Source file not found: ${sourcePath}` };
		}

		// Check if destination exists
		const destExists = this.app.vault.getAbstractFileByPath(destPath);
		if (destExists) {
			return { error: `Destination already exists: ${destPath}` };
		}

		// Create destination folder if needed
		if (destFolder) {
			const folderExists = this.app.vault.getAbstractFileByPath(destFolder);
			if (!folderExists) {
				await this.app.vault.createFolder(destFolder);
			}
		}

		// Read source and create copy
		const content = await this.app.vault.read(sourceFile);
		await this.app.vault.create(destPath, content);

		return {
			success: true,
			source: sourcePath,
			destination: destPath,
			action: "copied",
		};
	}

	// Get file metadata without reading full content
	async executeGetMetadata(action: any): Promise<any> {
		const filePath = action.file_path;

		// Check if folder is blocked
		const folder = filePath.substring(0, filePath.lastIndexOf("/")) || "";
		if (folder && this.plugin.isFolderBlocked(folder)) {
			return { error: `Access denied: ${folder} is a restricted folder` };
		}

		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			return { error: `File not found: ${filePath}` };
		}

		const cache = this.app.metadataCache.getFileCache(file);

		return {
			path: file.path,
			name: file.basename,
			extension: file.extension,
			size: file.stat.size,
			created: file.stat.ctime,
			modified: file.stat.mtime,
			frontmatter: cache?.frontmatter || {},
			tags: cache?.tags?.map((t: any) => t.tag) || [],
			headings: cache?.headings?.map((h: any) => ({ level: h.level, heading: h.heading })) || [],
			links: cache?.links?.map((l: any) => l.link) || [],
			embeds: cache?.embeds?.map((e: any) => e.link) || [],
		};
	}

	// Show approval modal for vault operations
	async showVaultApprovalModal(
		operation: "write" | "modify" | "delete" | "rename" | "move",
		details: any
	): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new VaultOperationApprovalModal(
				this.app,
				this.plugin,
				operation,
				details,
				(approved, trustSession) => {
					if (approved && trustSession) {
						this.plugin.settings.vaultToolsApprovedThisSession = true;
					}
					resolve(approved);
				}
			);
			modal.open();
		});
	}

	// Display methods for vault tool results
	displayReadFileResult(container: HTMLElement, result: any): void {
		container.empty();

		if (result.error) {
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: result.error,
			});
			return;
		}

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });

		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "📄" });
		header.createEl("span", { cls: "letta-vault-result-title", text: result.name });

		// File path link
		const pathEl = wrapper.createEl("div", { cls: "letta-vault-file-path" });
		pathEl.textContent = result.path;
		pathEl.addEventListener("click", () => {
			const file = this.app.vault.getAbstractFileByPath(result.path);
			if (file instanceof TFile) {
				this.app.workspace.getLeaf().openFile(file);
			}
		});

		// Metadata if present
		if (result.tags?.length || result.headings?.length) {
			const metaEl = wrapper.createEl("div", { cls: "letta-vault-file-meta" });
			if (result.tags?.length) {
				metaEl.createEl("span", { text: `Tags: ${result.tags.join(", ")}` });
			}
		}

		// Content preview
		const contentEl = wrapper.createEl("div", { cls: "letta-vault-result-content" });
		const preview = result.content.substring(0, 500);
		contentEl.textContent = preview + (result.content.length > 500 ? "..." : "");
	}

	displaySearchResult(container: HTMLElement, result: any): void {
		container.empty();

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });

		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "🔍" });
		header.createEl("span", {
			cls: "letta-vault-result-title",
			text: `Found ${result.total_found} results for "${result.query}"`,
		});

		if (result.results.length === 0) {
			wrapper.createEl("div", {
				cls: "letta-vault-file-meta",
				text: "No matching files found.",
			});
			return;
		}

		const list = wrapper.createEl("ul", { cls: "letta-vault-file-list" });

		for (const file of result.results) {
			const item = list.createEl("li", { cls: "letta-vault-file-item" });

			const pathEl = item.createEl("span", { cls: "letta-vault-file-path" });
			pathEl.textContent = file.path;
			pathEl.addEventListener("click", () => {
				const vaultFile = this.app.vault.getAbstractFileByPath(file.path);
				if (vaultFile instanceof TFile) {
					this.app.workspace.getLeaf().openFile(vaultFile);
				}
			});

			if (file.preview) {
				const previewEl = item.createEl("div", { cls: "letta-vault-file-meta" });
				previewEl.textContent = file.preview;
			}
		}
	}

	displayListFilesResult(container: HTMLElement, result: any): void {
		container.empty();

		if (result.error) {
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: result.error,
			});
			return;
		}

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });

		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "📁" });
		header.createEl("span", {
			cls: "letta-vault-result-title",
			text: `${result.total} files in ${result.folder}`,
		});

		const list = wrapper.createEl("ul", { cls: "letta-vault-file-list" });

		for (const file of result.files) {
			const item = list.createEl("li", { cls: "letta-vault-file-item" });

			const pathEl = item.createEl("span", { cls: "letta-vault-file-path" });
			pathEl.textContent = file.name;
			pathEl.addEventListener("click", () => {
				const vaultFile = this.app.vault.getAbstractFileByPath(file.path);
				if (vaultFile instanceof TFile) {
					this.app.workspace.getLeaf().openFile(vaultFile);
				}
			});

			const metaEl = item.createEl("span", { cls: "letta-vault-file-meta" });
			metaEl.textContent = file.folder || "(root)";
		}
	}

	displayWriteResult(container: HTMLElement, result: any): void {
		container.empty();

		if (result.error) {
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: result.error,
			});
			return;
		}

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });

		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "✅" });
		header.createEl("span", {
			cls: "letta-vault-result-title",
			text: `File ${result.action}: ${result.path}`,
		});

		const pathEl = wrapper.createEl("div", { cls: "letta-vault-file-path" });
		pathEl.textContent = "Click to open: " + result.path;
		pathEl.addEventListener("click", () => {
			const file = this.app.vault.getAbstractFileByPath(result.path);
			if (file instanceof TFile) {
				this.app.workspace.getLeaf().openFile(file);
			}
		});
	}

	displayModifyResult(container: HTMLElement, result: any): void {
		container.empty();

		if (result.error) {
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: result.error,
			});
			return;
		}

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });

		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "✏️" });
		header.createEl("span", {
			cls: "letta-vault-result-title",
			text: `File modified (${result.operation}): ${result.path}`,
		});

		const pathEl = wrapper.createEl("div", { cls: "letta-vault-file-path" });
		pathEl.textContent = "Click to open: " + result.path;
		pathEl.addEventListener("click", () => {
			const file = this.app.vault.getAbstractFileByPath(result.path);
			if (file instanceof TFile) {
				this.app.workspace.getLeaf().openFile(file);
			}
		});
	}

	displayDeleteResult(container: HTMLElement, result: any): void {
		container.empty();

		if (result.error) {
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: result.error,
			});
			return;
		}

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });

		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "🗑️" });
		header.createEl("span", {
			cls: "letta-vault-result-title",
			text: `File ${result.action === "moved_to_trash" ? "moved to trash" : "deleted"}: ${result.path}`,
		});
	}

	displayCreateFolderResult(container: HTMLElement, result: any): void {
		container.empty();

		if (result.error) {
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: result.error,
			});
			return;
		}

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });
		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "📁" });
		header.createEl("span", {
			cls: "letta-vault-result-title",
			text: `Folder created: ${result.path}`,
		});
	}

	displayRenameResult(container: HTMLElement, result: any): void {
		container.empty();

		if (result.error) {
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: result.error,
			});
			return;
		}

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });
		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "✏️" });
		header.createEl("span", {
			cls: "letta-vault-result-title",
			text: `Renamed: ${result.old_path} → ${result.new_path}`,
		});
	}

	displayMoveResult(container: HTMLElement, result: any): void {
		container.empty();

		if (result.error) {
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: result.error,
			});
			return;
		}

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });
		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "📦" });
		header.createEl("span", {
			cls: "letta-vault-result-title",
			text: `Moved: ${result.old_path} → ${result.new_path}`,
		});
	}

	displayCopyResult(container: HTMLElement, result: any): void {
		container.empty();

		if (result.error) {
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: result.error,
			});
			return;
		}

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });
		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "📋" });
		header.createEl("span", {
			cls: "letta-vault-result-title",
			text: `Copied: ${result.source} → ${result.destination}`,
		});
	}

	displayMetadataResult(container: HTMLElement, result: any): void {
		container.empty();

		if (result.error) {
			container.createEl("div", {
				cls: "letta-vault-result letta-vault-error",
				text: result.error,
			});
			return;
		}

		const wrapper = container.createEl("div", { cls: "letta-vault-result" });
		const header = wrapper.createEl("div", { cls: "letta-vault-result-header" });
		header.createEl("span", { cls: "letta-vault-result-icon", text: "ℹ️" });
		header.createEl("span", {
			cls: "letta-vault-result-title",
			text: `Metadata: ${result.name}`,
		});

		const details = wrapper.createEl("div", { cls: "letta-vault-metadata-details" });
		details.createEl("div", { text: `Path: ${result.path}` });
		details.createEl("div", { text: `Size: ${result.size} bytes` });
		details.createEl("div", { text: `Created: ${new Date(result.created).toLocaleString()}` });
		details.createEl("div", { text: `Modified: ${new Date(result.modified).toLocaleString()}` });
		if (result.tags && result.tags.length > 0) {
			details.createEl("div", { text: `Tags: ${result.tags.join(", ")}` });
		}
		if (result.links && result.links.length > 0) {
			details.createEl("div", { text: `Links: ${result.links.length} outgoing links` });
		}
		if (result.headings && result.headings.length > 0) {
			details.createEl("div", { text: `Headings: ${result.headings.length}` });
		}
	}

	async createTempNoteForProposal(proposal: ObsidianNoteProposal): Promise<string> {
		console.log("[Letta Plugin] Creating temp note for proposal:", proposal);
		
		// Create .letta/temp directory if it doesn't exist
		const tempDir = ".letta/temp";
		let tempFolder = this.app.vault.getAbstractFileByPath(tempDir);
		console.log("[Letta Plugin] Temp folder check:", tempFolder ? "exists" : "does not exist");
		
		if (!tempFolder) {
			try {
				await this.app.vault.createFolder(tempDir);
				console.log(`[Letta Plugin] Created temp directory: ${tempDir}`);
			} catch (error: any) {
				console.log("[Letta Plugin] Error creating temp directory:", error);
				// Check if it's specifically a "folder already exists" error
				if (error.message && error.message.includes("Folder already exists")) {
					console.log(`[Letta Plugin] Temp directory already exists: ${tempDir}`);
					// Don't throw the error, just continue
				} else {
					console.error(`[Letta Plugin] Failed to create temp directory: ${error.message}`);
					throw error;
				}
			}
		} else {
			console.log(`[Letta Plugin] Using existing temp directory: ${tempDir}`);
		}

		// Generate simple filename without timestamp (can overwrite existing temp files)
		const sanitizedTitle = proposal.title.replace(/[\\/:*?"<>|]/g, "_");
		const tempFileName = `${sanitizedTitle}.md`;
		const tempPath = `${tempDir}/${tempFileName}`;
		console.log("[Letta Plugin] Generated temp path:", tempPath);

		// Create note content with tags as hashtags and metadata at bottom
		let content = proposal.content || "";
		
		// Add tags as hashtags at the bottom
		if (proposal.tags && proposal.tags.length > 0) {
			content += "\n\n";
			const tagString = `#lettamade ${proposal.tags.map(tag => `#${tag.toLowerCase().replace(/\s+/g, '-')}`).join(" ")}`;
			content += tagString;
		} else {
			content += "\n\n#lettamade";
		}
		
		// Add timestamp and agent info at the bottom
		const timestamp = new Date().toISOString();
		const agentId = this.plugin.agent?.id || "unknown";
		content += `\n\n<small>Created: ${timestamp} | Agent: \`${agentId}\`</small>`;
		
		console.log("[Letta Plugin] Generated content length:", content.length);

		// Create or overwrite temp file
		try {
			const existingFile = this.app.vault.getAbstractFileByPath(tempPath);
			let tempFile;
			
			if (existingFile) {
				// Overwrite existing temp file
				await this.app.vault.modify(existingFile as any, content);
				tempFile = existingFile;
				console.log(`[Letta Plugin] Successfully overwritten existing temp note: ${tempPath}`);
			} else {
				// Create new temp file
				tempFile = await this.app.vault.create(tempPath, content);
				console.log(`[Letta Plugin] Successfully created new temp note: ${tempPath}`);
			}
			
			return tempPath;
		} catch (error) {
			console.error("[Letta Plugin] Failed to create/update temp file:", error);
			throw error;
		}
	}

	async createNotePreviewDisplay(container: HTMLElement, toolResult: string) {
		try {
			console.log("[Letta Plugin] Creating note preview, raw toolResult:", toolResult);
			const firstParse = JSON.parse(toolResult);
			console.log("[Letta Plugin] First parse result:", firstParse);
			let proposal = firstParse;
			
			// Handle double-encoded JSON if needed (same logic as enhancement)
			if (typeof firstParse === 'string') {
				proposal = JSON.parse(firstParse);
				console.log("[Letta Plugin] Double-encoded JSON detected, reparsed:", proposal);
			} else if (firstParse.data) {
				proposal = firstParse.data;
				console.log("[Letta Plugin] Found data property:", proposal);
			} else if (firstParse.result) {
				proposal = firstParse.result;
				console.log("[Letta Plugin] Found result property:", proposal);
			} else if (firstParse.value) {
				proposal = firstParse.value;
				console.log("[Letta Plugin] Found value property:", proposal);
			}
			
			const finalProposal = proposal as ObsidianNoteProposal;
			console.log("[Letta Plugin] Final proposal object:", finalProposal);
			console.log("[Letta Plugin] Content check - proposal.content:", finalProposal.content);
			
			// Create preview container
			const preview = container.createEl("div", { cls: "letta-note-preview" });
			
			// Title
			const titleEl = preview.createEl("h2", {
				text: `📝 ${finalProposal.title}`,
				cls: "letta-note-preview-title"
			});
			
			// Tags
			if (finalProposal.tags && finalProposal.tags.length > 0) {
				const tagsContainer = preview.createEl("div", { cls: "letta-note-preview-tags" });
				finalProposal.tags.forEach(tag => {
					tagsContainer.createEl("span", {
						text: tag,
						cls: "letta-note-preview-tag"
					});
				});
			}
			
			// Content preview (render markdown)
			if (finalProposal.content) {
				console.log("[Letta Plugin] Content found, rendering...");
				const contentEl = preview.createEl("div", { cls: "letta-note-preview-content" });
				
				// Extract the main content (skip frontmatter)
				let displayContent = finalProposal.content;
				if (displayContent.startsWith('---')) {
					const parts = displayContent.split('---');
					if (parts.length >= 3) {
						displayContent = parts.slice(2).join('---').trim();
					}
				}
				console.log("[Letta Plugin] Display content after processing:", displayContent);
				
				// Render the markdown content
				await this.renderMarkdownContent(contentEl, displayContent);
			} else {
				console.log("[Letta Plugin] No content found in proposal");
				const noContentEl = preview.createEl("div", { 
					cls: "letta-note-preview-content",
					text: "⚠️ No content available for preview"
				});
				noContentEl.style.color = "var(--text-muted)";
				noContentEl.style.fontStyle = "italic";
			}
			
			// Folder info
			if (finalProposal.folder) {
				const folderEl = preview.createEl("div", {
					text: `📁 ${finalProposal.folder}`,
					cls: "letta-note-preview-folder"
				});
			}
			
		} catch (error) {
			console.error("Failed to create note preview:", error);
			// Fallback to regular text display
			const fallback = container.createEl("div", {
				cls: "letta-tool-result-text",
				text: toolResult
			});
		}
	}

	async enhanceNoteProposalDisplay(container: HTMLElement, toolResult: string) {
		console.log("[Letta Plugin] 🚀 enhanceNoteProposalDisplay called!");
		console.log("[Letta Plugin] Tool result to enhance:", toolResult);
		
		try {
			const firstParse = JSON.parse(toolResult);
			console.log("[Letta Plugin] First parse result:", firstParse);
			console.log("[Letta Plugin] First parse keys:", Object.keys(firstParse));
			console.log("[Letta Plugin] First parse type:", typeof firstParse);
			
			// Handle double-encoded JSON or wrapper objects
			let proposal = firstParse;
			
			// If it's still a string, parse it again
			if (typeof firstParse === 'string') {
				console.log("[Letta Plugin] Double-parsing JSON string...");
				proposal = JSON.parse(firstParse);
			} 
			// Check for common wrapper patterns
			else if (firstParse.data) {
				console.log("[Letta Plugin] Found data wrapper, using firstParse.data");
				proposal = firstParse.data;
			} else if (firstParse.result) {
				console.log("[Letta Plugin] Found result wrapper, using firstParse.result");
				proposal = firstParse.result;
			} else if (firstParse.value) {
				console.log("[Letta Plugin] Found value wrapper, using firstParse.value");
				proposal = firstParse.value;
			}
			
			console.log("[Letta Plugin] Final proposal:", proposal);
			console.log("[Letta Plugin] Final proposal keys:", Object.keys(proposal));
			console.log("[Letta Plugin] Final proposal.action:", proposal.action);
			
			// Type assertion for the final proposal
			const finalProposal = proposal as ObsidianNoteProposal;
			
			// Use more robust comparison
			const actionValue = finalProposal.action?.trim() || "";
			if (actionValue !== "create_note" && !actionValue.includes("create_note")) {
				console.log("[Letta Plugin] ❌ Proposal action is not 'create_note', skipping enhancement");
				console.log("[Letta Plugin] Expected: 'create_note', Got:", actionValue);
				return;
			}
			
			console.log("[Letta Plugin] ✅ Action check passed, continuing with enhancement...");

			// Create temp file for preview
			const tempPath = await this.createTempNoteForProposal(finalProposal);

			// Create enhancement container below the existing tool result
			const enhancement = container.createEl("div", { 
				cls: "letta-note-proposal-enhancement" 
			});

			// Create note proposal header
			const header = enhancement.createEl("div", { cls: "letta-note-proposal-header" });
			const titleEl = header.createEl("h3", { 
				text: `📝 ${finalProposal.title}`,
				cls: "letta-note-proposal-title" 
			});

			// Add folder info if specified
			if (finalProposal.folder) {
				header.createEl("div", {
					text: `📁 Folder: ${finalProposal.folder}`,
					cls: "letta-note-proposal-folder"
				});
			}

			// Add tags if specified
			if (finalProposal.tags && finalProposal.tags.length > 0) {
				const tagsEl = header.createEl("div", { cls: "letta-note-proposal-tags" });
				tagsEl.createEl("span", { text: "🏷️ Tags: " });
				finalProposal.tags.forEach((tag, index) => {
					const tagSpan = tagsEl.createEl("span", { 
						text: tag,
						cls: "letta-note-proposal-tag" 
					});
					if (index < finalProposal.tags!.length - 1) {
						tagsEl.createEl("span", { text: ", " });
					}
				});
			}

			// Click to open temp file  
			titleEl.style.cursor = "pointer";
			titleEl.addEventListener("click", async () => {
				try {
					const tempFile = this.app.vault.getAbstractFileByPath(tempPath);
					if (tempFile) {
						const leaf = this.app.workspace.getLeaf('tab');
						await leaf.openFile(tempFile as any);
					}
				} catch (error) {
					console.error("Failed to open temp file:", error);
				}
			});

			// Action buttons
			const buttonContainer = enhancement.createEl("div", { cls: "letta-note-proposal-buttons" });
			
			const acceptButton = buttonContainer.createEl("button", {
				text: "Accept",
				cls: "letta-button letta-button-accept"
			});
			
			const editButton = buttonContainer.createEl("button", {
				text: "Edit",
				cls: "letta-button letta-button-edit"
			});
			
			const rejectButton = buttonContainer.createEl("button", {
				text: "Reject", 
				cls: "letta-button letta-button-reject"
			});

			// Add button event handlers
			acceptButton.addEventListener("click", async () => {
				await this.acceptNoteProposal(enhancement, finalProposal, tempPath);
			});

			editButton.addEventListener("click", async () => {
				await this.editNoteProposal(enhancement, finalProposal, tempPath);
			});

			rejectButton.addEventListener("click", async () => {
				await this.rejectNoteProposal(enhancement, tempPath);
			});

			// Auto-expand the tool result section for note proposals
			// The container itself is the expandable content that might be collapsed
			if (container.classList.contains("letta-expandable-collapsed")) {
				container.removeClass("letta-expandable-collapsed");
				console.log("[Letta Plugin] Auto-expanded tool result section for note proposal");
				
				// Update the chevron indicator
				const parentBubble = container.closest(".letta-message-bubble");
				if (parentBubble) {
					const chevron = parentBubble.querySelector(".letta-expandable-chevron");
					if (chevron) {
						chevron.textContent = "●";
					}
				}
			}
			
			console.log("[Letta Plugin] ✅ Note proposal enhancement created successfully!");
			
		} catch (error) {
			console.error("[Letta Plugin] ❌ Failed to enhance note proposal display:", error);
		}
	}

	createNoteProposalDisplay(container: HTMLElement, toolResult: string, tempPath?: string | null) {
		try {
			const proposal = JSON.parse(toolResult) as ObsidianNoteProposal;
			
			// Create note proposal header
			const header = container.createEl("div", { cls: "letta-note-proposal-header" });
			const titleEl = header.createEl("h3", { 
				text: `📝 Note Proposal: ${proposal.title}`,
				cls: "letta-note-proposal-title" 
			});

			// Add folder info if specified
			if (proposal.folder) {
				header.createEl("div", {
					text: `📁 Folder: ${proposal.folder}`,
					cls: "letta-note-proposal-folder"
				});
			}

			// Add tags if specified
			if (proposal.tags && proposal.tags.length > 0) {
				const tagsEl = header.createEl("div", { cls: "letta-note-proposal-tags" });
				tagsEl.createEl("span", { text: "🏷️ Tags: " });
				proposal.tags.forEach((tag, index) => {
					const tagSpan = tagsEl.createEl("span", { 
						text: tag,
						cls: "letta-note-proposal-tag" 
					});
					if (index < proposal.tags!.length - 1) {
						tagsEl.createEl("span", { text: ", " });
					}
				});
			}

			// Content preview (scrollable)
			const contentContainer = container.createEl("div", { cls: "letta-note-proposal-content" });
			const contentHeader = contentContainer.createEl("div", { 
				text: "Content Preview:",
				cls: "letta-note-proposal-content-header" 
			});
			
			const contentArea = contentContainer.createEl("div", { cls: "letta-note-proposal-content-area" });
			const previewEl = contentArea.createEl("pre", { cls: "letta-note-proposal-preview" });
			previewEl.textContent = proposal.content;

			// Click to open temp file  
			const finalTempPath = tempPath || (() => {
				// Fallback calculation if tempPath wasn't provided
				const timestamp = new Date().toISOString().slice(0, 19).replace(/[:-]/g, "");
				const sanitizedTitle = proposal.title.replace(/[\\/:*?"<>|]/g, "_");
				return `.letta/temp/${sanitizedTitle}_${timestamp}.md`;
			})();
			
			titleEl.style.cursor = "pointer";
			titleEl.addEventListener("click", async () => {
				try {
					const tempFile = this.app.vault.getAbstractFileByPath(finalTempPath);
					if (tempFile) {
						const leaf = this.app.workspace.getLeaf('tab');
						await leaf.openFile(tempFile as any);
					}
				} catch (error) {
					console.error("Failed to open temp file:", error);
				}
			});

			// Action buttons
			const buttonContainer = container.createEl("div", { cls: "letta-note-proposal-buttons" });
			
			const acceptButton = buttonContainer.createEl("button", {
				text: "Accept",
				cls: "letta-button letta-button-accept"
			});
			
			const editButton = buttonContainer.createEl("button", {
				text: "Edit",
				cls: "letta-button letta-button-edit"
			});
			
			const rejectButton = buttonContainer.createEl("button", {
				text: "Reject", 
				cls: "letta-button letta-button-reject"
			});

			// Store proposal data for button handlers
			container.setAttribute("data-proposal", JSON.stringify(proposal));
			container.setAttribute("data-temp-path", finalTempPath);

			// Add button event handlers
			acceptButton.addEventListener("click", async () => {
				await this.acceptNoteProposal(container, proposal, finalTempPath);
			});

			editButton.addEventListener("click", async () => {
				await this.editNoteProposal(container, proposal, finalTempPath);
			});

			rejectButton.addEventListener("click", async () => {
				await this.rejectNoteProposal(container, finalTempPath);
			});

		} catch (error) {
			console.error("Failed to parse note proposal:", error);
			const fallback = container.createEl("div", {
				cls: "letta-tool-result-text",
				text: "Invalid note proposal format"
			});
		}
	}

	async acceptNoteProposal(container: HTMLElement, proposal: ObsidianNoteProposal, tempPath: string) {
		try {
			// Determine target path
			const sanitizedTitle = proposal.title.replace(/[\\/:*?"<>|]/g, "_");
			const fileName = `${sanitizedTitle}.md`;
			const folder = proposal.folder?.trim() || this.plugin.settings.defaultNoteFolder;
			const targetPath = folder ? `${folder}/${fileName}` : fileName;

			// Check if target path already exists
			const existingFile = this.app.vault.getAbstractFileByPath(targetPath);
			if (existingFile) {
				// Show error and keep temp file
				this.showNoteProposalError(container, `A file already exists at: ${targetPath}. Please ask the agent to choose a different name or location.`);
				return;
			}

			// Create target folder if needed
			if (folder) {
				const folderExists = this.app.vault.getAbstractFileByPath(folder);
				if (!folderExists) {
					await this.app.vault.createFolder(folder);
					console.log(`[Letta Plugin] Created folder: ${folder}`);
				}
			}

			// Get temp file and move it
			console.log("[Letta Plugin] Looking for temp file at path:", tempPath);
			const tempFile = this.app.vault.getAbstractFileByPath(tempPath);
			console.log("[Letta Plugin] Temp file found:", tempFile ? "yes" : "no");
			
			if (tempFile) {
				// Read content from temp file and create at target location
				const content = await this.app.vault.read(tempFile as any);
				console.log("[Letta Plugin] Read content from temp file, length:", content.length);
				const newFile = await this.app.vault.create(targetPath, content);

				// Delete temp file
				await this.app.vault.delete(tempFile as any);

				// Open the new file
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(newFile);

				// Update UI to show success
				this.showNoteProposalSuccess(container, `Note created: [[${proposal.title}]] at \`${targetPath}\``);

				console.log(`[Letta Plugin] Note accepted and created: ${targetPath}`);
			} else {
				console.error("[Letta Plugin] Temp file not found at:", tempPath);
				// Fallback: create the note directly from proposal content
				console.log("[Letta Plugin] Attempting fallback creation with proposal content");
				let content = proposal.content || "";
				
				// Add tags as hashtags at the bottom
				if (proposal.tags && proposal.tags.length > 0) {
					content += "\n\n";
					const tagString = `#lettamade ${proposal.tags.map(tag => `#${tag.toLowerCase().replace(/\s+/g, '-')}`).join(" ")}`;
					content += tagString;
				} else {
					content += "\n\n#lettamade";
				}
				
				// Add timestamp and agent info at the bottom
				const timestamp = new Date().toISOString();
				const agentId = this.plugin.agent?.id || "unknown";
				content += `\n\n<small>Created: ${timestamp} | Agent: \`${agentId}\`</small>`;
				
				const newFile = await this.app.vault.create(targetPath, content);
				
				// Open the new file
				const leaf = this.app.workspace.getLeaf('tab');
				await leaf.openFile(newFile);

				// Update UI to show success
				this.showNoteProposalSuccess(container, `Note created: [[${proposal.title}]] at \`${targetPath}\` (fallback)`);

				console.log(`[Letta Plugin] Note accepted and created via fallback: ${targetPath}`);
			}
		} catch (error) {
			console.error("Failed to accept note proposal:", error);
			this.showNoteProposalError(container, `Failed to create note: ${error.message}`);
		}
	}

	async editNoteProposal(container: HTMLElement, proposal: ObsidianNoteProposal, tempPath: string) {
		try {
			// Create and show the editing modal
			const modal = new NoteProposalModal(this.app, proposal, async (accepted: boolean, editedProposal?: ObsidianNoteProposal) => {
				if (accepted && editedProposal) {
					// Generate new temp path based on edited proposal
					const tempDir = ".letta/temp";
					const sanitizedTitle = editedProposal.title.replace(/[\\/:*?"<>|]/g, "_");
					const newTempPath = `${tempDir}/${sanitizedTitle}.md`;
					
					// Clean up original temp file and create new one
					await this.updateTempFileWithEditedProposal(tempPath, newTempPath, editedProposal);
					// Accept the edited proposal with new temp path
					await this.acceptNoteProposal(container, editedProposal, newTempPath);
				}
				// If not accepted, modal just closes without doing anything
			});
			modal.open();
		} catch (error) {
			console.error("Failed to open edit modal:", error);
			this.showNoteProposalError(container, `Failed to open editor: ${error.message}`);
		}
	}

	async updateTempFileWithEditedProposal(oldTempPath: string, newTempPath: string, proposal: ObsidianNoteProposal) {
		try {
			// Create updated content with the same format as createTempNoteForProposal
			let content = proposal.content || "";
			
			// Add tags as hashtags at the bottom
			if (proposal.tags && proposal.tags.length > 0) {
				content += "\n\n";
				const tagString = `#lettamade ${proposal.tags.map(tag => `#${tag.toLowerCase().replace(/\s+/g, '-')}`).join(" ")}`;
				content += tagString;
			} else {
				content += "\n\n#lettamade";
			}
			
			// Add timestamp and agent info at the bottom
			const timestamp = new Date().toISOString();
			const agentId = this.plugin.agent?.id || "unknown";
			content += `\n\n<small>Created: ${timestamp} | Agent: \`${agentId}\`</small>`;

			// Delete the original temp file if it exists
			const oldTempFile = this.app.vault.getAbstractFileByPath(oldTempPath);
			if (oldTempFile) {
				await this.app.vault.delete(oldTempFile as any);
				console.log("[Letta Plugin] Deleted original temp file");
			}
			
			// Try to modify existing file first, create if it doesn't exist
			const newTempFile = this.app.vault.getAbstractFileByPath(newTempPath);
			if (newTempFile) {
				// File exists, modify it
				await this.app.vault.modify(newTempFile as any, content);
				console.log("[Letta Plugin] Modified existing temp file with edited content");
			} else {
				// File doesn't exist in cache, try to create it
				try {
					await this.app.vault.create(newTempPath, content);
					console.log("[Letta Plugin] Created new temp file with edited content");
				} catch (createError: any) {
					if (createError.message && createError.message.includes("File already exists")) {
						// File exists but not in cache - try to get it and modify
						console.log("[Letta Plugin] File exists but not cached, attempting to modify");
						const existingFile = this.app.vault.getAbstractFileByPath(newTempPath);
						if (existingFile) {
							await this.app.vault.modify(existingFile as any, content);
							console.log("[Letta Plugin] Modified file that wasn't cached");
						} else {
							// Last resort - force delete and recreate
							try {
								await this.app.vault.adapter.remove(newTempPath);
								await this.app.vault.create(newTempPath, content);
								console.log("[Letta Plugin] Force deleted and recreated temp file");
							} catch (forceError) {
								console.error("[Letta Plugin] All recovery attempts failed:", forceError);
								throw forceError;
							}
						}
					} else {
						throw createError;
					}
				}
			}
		} catch (error) {
			console.error("Failed to update temp file:", error);
			throw error;
		}
	}

	async rejectNoteProposal(container: HTMLElement, tempPath: string) {
		try {
			// Delete temp file
			const tempFile = this.app.vault.getAbstractFileByPath(tempPath);
			if (tempFile) {
				await this.app.vault.delete(tempFile as any);
				console.log(`[Letta Plugin] Temp file deleted: ${tempPath}`);
			}

			// Update UI to show rejection
			this.showNoteProposalSuccess(container, "Note proposal rejected and temp file cleaned up");
		} catch (error) {
			console.error("Failed to reject note proposal:", error);
			this.showNoteProposalError(container, `Failed to clean up temp file: ${error.message}`);
		}
	}

	showNoteProposalSuccess(container: HTMLElement, message: string) {
		// Hide buttons and show success message
		const buttonContainer = container.querySelector(".letta-note-proposal-buttons");
		if (buttonContainer) {
			buttonContainer.remove();
		}

		const successEl = container.createEl("div", {
			cls: "letta-note-proposal-result letta-note-proposal-success",
			text: message
		});
	}

	showNoteProposalError(container: HTMLElement, message: string) {
		// Show error message but keep buttons visible for retry
		let errorContainer = container.querySelector(".letta-note-proposal-error");
		if (!errorContainer) {
			errorContainer = container.createEl("div", {
				cls: "letta-note-proposal-error"
			});
		}
		errorContainer.textContent = `⚠️ ${message}`;
	}

	async processNonStreamingMessages(messages: any[]) {
		// Processing non-streaming messages

		// Process response messages (fallback for when streaming fails)
		let tempReasoning = "";
		let tempToolMessage: HTMLElement | null = null;
		let tempToolName = "";
		let tempToolCallData: any = null;

		for (const responseMessage of messages) {
			// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
			if (
				responseMessage.type === "system_alert" ||
				(responseMessage.message &&
					typeof responseMessage.message === "string" &&
					responseMessage.message.includes(
						"prior messages have been hidden",
					))
			) {
				// Capturing non-streaming system_alert message
				this.addSystemMessage(responseMessage);
				continue;
			}

			// Handle heartbeat messages - show typing indicator
			if (
				responseMessage.type === "heartbeat" ||
				responseMessage.message_type === "heartbeat" ||
				responseMessage.role === "heartbeat" ||
				(responseMessage.reason &&
					(responseMessage.reason.includes(
						"automated system message",
					) ||
						responseMessage.reason.includes(
							"Function call failed, returning control",
						) ||
						responseMessage.reason.includes(
							"request_heartbeat=true",
						)))
			) {
				this.handleHeartbeat();
				continue;
			}

			switch (responseMessage.message_type || responseMessage.messageType) {
				case "reasoning_message":
					if (responseMessage.reasoning) {
						// Accumulate reasoning for the next tool call or assistant message
						tempReasoning += responseMessage.reasoning;
					}
					break;
				case "usage_statistics":
					// Received non-streaming usage statistics
					this.addUsageStatisticsToLastMessage(responseMessage);
					break;
				case "tool_call_message":
					const toolCallData = responseMessage.tool_call || responseMessage.toolCall;
					if (toolCallData) {
						// Store tool information for later use
						tempToolName = toolCallData.name || 
							(toolCallData.function && toolCallData.function.name) || 
							"";
						tempToolCallData = toolCallData;
						
						console.log("[Letta Plugin] Non-streaming tool call detected:", tempToolName);
						if (tempToolName === "propose_obsidian_note") {
							console.log("[Letta Plugin] 🔥 PROPOSE_OBSIDIAN_NOTE detected in non-streaming!");
						}
						
						// Create tool interaction with reasoning
						tempToolMessage = this.addToolInteractionMessage(
							tempReasoning,
							JSON.stringify(toolCallData, null, 2),
						);
						// Clear reasoning after using it
						tempReasoning = "";
					}
					break;
				case "tool_return_message":
					const toolReturnData = responseMessage.tool_return || responseMessage.toolReturn;
					if (toolReturnData && tempToolMessage) {
						console.log("[Letta Plugin] Non-streaming tool return for tool:", tempToolName);
						if (tempToolName === "propose_obsidian_note") {
							console.log("[Letta Plugin] 🔥 PROPOSE_OBSIDIAN_NOTE tool return in non-streaming!", toolReturnData);
						}

						// Add tool result to the existing tool interaction message
						await this.addToolResultToMessage(
							tempToolMessage,
							JSON.stringify(
								toolReturnData,
								null,
								2,
							),
							tempToolName,
							tempToolCallData,
						);
						// Clear the temp tool message reference and data
						tempToolMessage = null;
						tempToolName = "";
						tempToolCallData = null;
					}
					break;
				case "approval_request_message":
					console.log("[Letta Plugin] Non-streaming approval request:", responseMessage);
					await this.handleApprovalRequest(responseMessage);
					break;
				case "assistant_message":
					// Processing assistant message

					// Try multiple possible content fields
					let content =
						responseMessage.content ||
						responseMessage.text ||
						responseMessage.message;

					// Handle array content by extracting text from array elements
					if (Array.isArray(content)) {
						content = content
							.map((item) => {
								if (typeof item === "string") {
									return item;
								} else if (item && typeof item === "object") {
									return (
										item.text ||
										item.content ||
										item.message ||
										item.value ||
										JSON.stringify(item)
									);
								}
								return String(item);
							})
							.join("");
						// Non-streaming: Converted array content to string
					}

					if (content) {
						// Filter out system prompt content and use accumulated reasoning
						const filteredContent =
							this.filterSystemPromptContent(content);
						await this.addMessage(
							"assistant",
							filteredContent,
							this.plugin.settings.agentName,
							tempReasoning || undefined,
						);
						// Clear temp reasoning after using it
						tempReasoning = "";
					} else {
						console.warn(
							"[Letta Plugin] Assistant message has no recognizable content field:",
							Object.keys(responseMessage),
						);
						// Fallback: display the whole message structure for debugging
						await this.addMessage(
							"assistant",
							`**Debug**: ${JSON.stringify(responseMessage, null, 2)}`,
							"Debug",
						);
					}
					break;

				case "heartbeat":
					// Skip heartbeat messages - should already be filtered above
					// Heartbeat message reached switch statement
					break;

				default:
					// Unrecognized message type

					// Fallback handling for messages without proper message_type
					if (
						responseMessage.content ||
						responseMessage.text ||
						responseMessage.message
					) {
						let content =
							responseMessage.content ||
							responseMessage.text ||
							responseMessage.message;

						// Handle array content by extracting text from array elements
						if (Array.isArray(content)) {
							content = content
								.map((item) => {
									if (typeof item === "string") {
										return item;
									} else if (
										item &&
										typeof item === "object"
									) {
										return (
											item.text ||
											item.content ||
											item.message ||
											item.value ||
											JSON.stringify(item)
										);
									}
									return String(item);
								})
								.join("");
							// Fallback: Converted array content to string
						}

						const filteredContent =
							this.filterSystemPromptContent(content);
						await this.addMessage(
							"assistant",
							filteredContent,
							this.plugin.settings.agentName,
						);
					} else {
						// Last resort: show the JSON structure for debugging
						console.warn(
							"[Letta Plugin] Message has no recognizable content, displaying as debug info",
						);
						await this.addMessage(
							"assistant",
							`**Debug**: Unknown message structure\n\`\`\`json\n${JSON.stringify(responseMessage, null, 2)}\n\`\`\``,
							"Debug",
						);
					}
					break;
			}
		}
	}

	async processStreamingMessage(message: any) {
		// Handle system messages - capture system_alert for hidden viewing, skip heartbeats
		if (
			message.type === "system_alert" ||
			(message.message &&
				typeof message.message === "string" &&
				message.message.includes("prior messages have been hidden"))
		) {
			// Capturing streaming system_alert message
			this.addSystemMessage(message);
			return;
		}

		// Handle heartbeat messages - show typing indicator
		if (
			message.type === "heartbeat" ||
			message.message_type === "heartbeat" ||
			message.messageType === "heartbeat" ||
			message.role === "heartbeat" ||
			(message.reason &&
				(message.reason.includes("automated system message") ||
					message.reason.includes(
						"Function call failed, returning control",
					) ||
					message.reason.includes("request_heartbeat=true")))
		) {
			this.handleHeartbeat();
			return;
		}

		// Handle system status messages (reconnecting, etc.)
		if (message.message_type === "system_status") {
			if (message.status === "reconnecting") {
				// Show reconnecting status in typing indicator
				this.streamingPhase = 'idle'; // Reset phase during reconnect
				const typingTextEl = this.typingIndicator?.querySelector('.letta-typing-text');
				if (typingTextEl) {
					typingTextEl.textContent = `Reconnecting... (attempt ${message.attempt}/${message.maxRetries})`;
				}
			}
			return;
		}

		// Filter out login messages - check both direct type and content containing login JSON
		if (
			message.type === "login" ||
			message.message_type === "login" ||
			message.messageType === "login"
		) {
			return;
		}

		// Check if this is a user_message containing login JSON
		if (
			(message.message_type === "user_message" ||
				message.messageType === "user_message") &&
			message.content &&
			typeof message.content === "string"
		) {
			try {
				const parsedContent = JSON.parse(message.content.trim());
				if (parsedContent.type === "login") {
					return;
				}
			} catch (e) {
				// Not JSON, continue processing normally
			}
		}

		// Handle usage statistics
		if (
			message.message_type === "usage_statistics" ||
			message.messageType === "usage_statistics"
		) {
			// Track token count for live display
			const completionTokens = message.completion_tokens || message.completionTokens || 0;
			const promptTokens = message.prompt_tokens || message.promptTokens || 0;
			this.streamingTokenEstimate = completionTokens + promptTokens;

			// Received usage statistics
			this.addUsageStatistics(message);
			return;
		}

		switch (message.message_type || message.messageType) {
			case "reasoning_message":
				// Update streaming phase to reasoning
				this.streamingPhase = 'reasoning';
				this.updateTypingIndicatorText();

				if (message.reasoning) {
					// For streaming, we accumulate reasoning and show it in real-time
					this.updateOrCreateReasoningMessage(message.reasoning);
				}
				break;
			case "tool_call_message":
				const streamingToolCallData = message.tool_call || message.toolCall;
				if (streamingToolCallData) {
					// Update streaming phase to tool_call and track tool name
					this.streamingPhase = 'tool_call';
					const toolName = streamingToolCallData.name || streamingToolCallData.function?.name;
					if (toolName) {
						this.currentToolCallNameForStatus = toolName;
						// Increment step count when a new tool call starts
						this.streamingStepCount++;
					}
					this.updateTypingIndicatorText();

					// Handle streaming tool call chunks
					console.log("[Letta Plugin] Received tool_call_message:", streamingToolCallData);
					this.handleStreamingToolCall(streamingToolCallData);
				} else {
					console.log("[Letta Plugin] Received tool_call_message but no tool_call/toolCall field:", message);
				}
				break;
			case "stop_reason":
				// DISABLED: Approval handling commented out due to upstream API issues
				// if (message.stopReason === "requires_approval" || message.stop_reason === "requires_approval") {
				// 	console.log("[Letta Plugin] Stream stopped for approval");
				// }
				break;
			case "tool_return_message":
				const streamingToolReturnData = message.tool_return || message.toolReturn;
				if (streamingToolReturnData) {
					// Tool return received
					console.log("[Letta Plugin] Received tool_return_message:", streamingToolReturnData);
					console.log("[Letta Plugin] Current tool call name:", this.currentToolCallName);
					// Update the current tool interaction with the result
					await this.updateStreamingToolResult(streamingToolReturnData);
					// Clear the current tool call state since it's complete
					this.currentToolCallId = null;
					this.currentToolCallArgs = "";
					this.currentToolCallName = "";
					this.currentToolCallData = null;
					// Reset phase after tool completes (will be updated again if another message comes)
					this.currentToolCallNameForStatus = '';
					this.streamingPhase = 'idle';
					this.updateTypingIndicatorText();
				}
				break;
			case "approval_request_message":
				// DISABLED: Approval handling commented out due to upstream API issues
				// console.log("[Letta Plugin] Received approval_request_message:", message);
				// await this.handleApprovalRequest(message);
				break;
			case "assistant_message":
				// Update streaming phase to generating
				this.streamingPhase = 'generating';
				this.currentToolCallNameForStatus = ''; // Clear tool name when generating response
				this.updateTypingIndicatorText();

				// Try multiple possible content fields
				let content =
					message.content ||
					message.text ||
					message.message ||
					message.assistant_message;

				// Handle array content by extracting text from array elements
				if (Array.isArray(content)) {
					content = content
						.map((item) => {
							if (typeof item === "string") {
								return item;
							} else if (item && typeof item === "object") {
								return (
									item.text ||
									item.content ||
									item.message ||
									item.value ||
									JSON.stringify(item)
								);
							}
							return String(item);
						})
						.join("");
					// Streaming: Converted array content to string
				}

				if (content) {
					// Filter out system prompt content
					const filteredContent =
						this.filterSystemPromptContent(content);
					await this.updateOrCreateAssistantMessage(filteredContent);
				} else {
					console.warn(
						"[Letta Plugin] Streaming assistant message has no recognizable content field:",
						Object.keys(message),
					);
				}
				break;

			case "heartbeat":
				// Skip heartbeat messages - should already be filtered above
				// Heartbeat message reached switch statement
				break;

			default:
				// Unrecognized streaming message type
				break;
		}
	}

	// State for streaming messages
	private currentReasoningContent: string = "";
	private assistantReasoningContent: string = ""; // Separate reasoning storage for assistant messages
	private currentAssistantContent: string = "";
	private currentAssistantMessageEl: HTMLElement | null = null;
	private currentReasoningMessageEl: HTMLElement | null = null;
	private currentToolMessageEl: HTMLElement | null = null;
	private currentToolCallId: string | null = null;
	private currentToolCallArgs: string = "";
	private currentToolCallName: string = "";
	private currentToolCallData: any = null;
	private currentApprovalRequestId: string | null = null;
	private currentApprovalArgs: string = "";
	private currentApprovalToolName: string = "";
	private hasCreatedApprovalUI: boolean = false;

	updateOrCreateReasoningMessage(reasoning: string) {
		// Accumulate reasoning content for both tool interactions and assistant messages
		this.currentReasoningContent += reasoning;
		this.assistantReasoningContent += reasoning;
	}

	async updateOrCreateAssistantMessage(content: string) {
		// Process escape sequences in the chunk before accumulating
		const processedContent = this.processEscapeSequences(content);
		this.currentAssistantContent += processedContent;

		// Create message element if it doesn't exist
		if (!this.currentAssistantMessageEl) {
			this.currentAssistantMessageEl = this.chatContainer.createEl(
				"div",
				{
					cls: "letta-message letta-message-assistant",
				},
			);
			const bubbleEl = this.currentAssistantMessageEl.createEl("div", {
				cls: "letta-message-bubble",
			});

			// Add header
			const headerEl = bubbleEl.createEl("div", {
				cls: "letta-message-header",
			});
			const leftSide = headerEl.createEl("div", {
				cls: "letta-message-header-left",
			});
			leftSide.createEl("span", {
				cls: "letta-message-title",
				text: this.plugin.settings.agentName,
			});
			leftSide.createEl("span", {
				cls: "letta-message-timestamp",
				text: new Date().toLocaleTimeString([], {
					hour: "2-digit",
					minute: "2-digit",
				}),
			});

			// Skip creating reasoning content here - it will be handled properly in markStreamingComplete()
			// when the streaming is finished to create the proper reasoning button structure

			// Add content container
			bubbleEl.createEl("div", { cls: "letta-message-content" });
		}

		// Use render batching for smoother performance
		// Schedule a render if not already scheduled
		if (!this.renderScheduled) {
			this.renderScheduled = true;
			this.rafId = requestAnimationFrame(() => this.flushPendingRender());
		}
	}

	/**
	 * Flush pending content to DOM using batched rendering
	 */
	private async flushPendingRender() {
		this.renderScheduled = false;
		this.rafId = null;

		if (!this.currentAssistantMessageEl) return;

		// Update the assistant content with markdown formatting
		const contentEl = this.currentAssistantMessageEl.querySelector(
			".letta-message-content",
		);
		if (contentEl) {
			// Use robust markdown rendering instead of manual HTML formatting
			await this.renderMarkdownContent(contentEl as HTMLElement, this.currentAssistantContent);
		}

		// Scroll to bottom with smooth behavior
		this.chatContainer.scrollTo({
			top: this.chatContainer.scrollHeight,
			behavior: "smooth",
		});
	}

	createStreamingToolInteraction(toolCall: any) {
		// Clean up previous tool calls
		this.cleanupPreviousToolCalls();

		// Parse tool call to extract tool name
		let toolName = "Tool Call";
		try {
			if (toolCall.name) {
				toolName = toolCall.name;
			} else if (toolCall.function && toolCall.function.name) {
				toolName = toolCall.function.name;
			}
		} catch (e) {
			// Keep default if parsing fails
		}

		console.log("[Letta Plugin] Creating tool interaction DOM element for tool:", toolName);

		// Create tool interaction message
		this.currentToolMessageEl = this.chatContainer.createEl("div", {
			cls: "letta-message letta-message-tool-interaction",
		});

		const bubbleEl = this.currentToolMessageEl.createEl("div", {
			cls: "letta-message-bubble",
		});

		// Add timestamp
		const timestamp = new Date().toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});

		// Header with timestamp
		const headerEl = bubbleEl.createEl("div", {
			cls: "letta-message-header",
		});
		const leftSide = headerEl.createEl("div", {
			cls: "letta-message-header-left",
		});
		leftSide.createEl("span", {
			cls: "letta-message-title",
			text: "Tool Usage",
		});
		leftSide.createEl("span", {
			cls: "letta-message-timestamp",
			text: timestamp,
		});

		// Add reasoning content if available and setting is enabled
		console.log(
			"[Letta Plugin] Creating tool interaction with reasoning content:",
			this.currentReasoningContent,
		);
		console.log(
			"[Letta Plugin] showReasoning setting:",
			this.plugin.settings.showReasoning,
		);
		if (
			this.currentReasoningContent &&
			this.plugin.settings.showReasoning
		) {
			const reasoningEl = bubbleEl.createEl("div", {
				cls: "letta-tool-reasoning",
			});

			// Apply markdown formatting to reasoning
			let formattedReasoning = this.currentReasoningContent
				.trim()
				.replace(/\n{3,}/g, "\n\n")
				.replace(/^### (.+)$/gm, "<h3>$1</h3>")
				.replace(/^## (.+)$/gm, "<h2>$1</h2>")
				.replace(/^# (.+)$/gm, "<h1>$1</h1>")
				.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
				.replace(/\*(.*?)\*/g, "<em>$1</em>")
				.replace(/`([^`]+)`/g, "<code>$1</code>")
				.replace(
					/^(\d+)\.\s+(.+)$/gm,
					'<li class="numbered-list">$2</li>',
				)
				.replace(/^[•*-]\s+(.+)$/gm, "<li>$1</li>")
				.replace(/\n\n/g, "</p><p>")
				.replace(/\n/g, "<br>");

			// Wrap consecutive numbered list items in <ol> tags
			formattedReasoning = formattedReasoning.replace(
				/(<li class="numbered-list">.*?<\/li>)(\s*<br>\s*<li class="numbered-list">.*?<\/li>)*/g,
				(match) => {
					const cleanMatch = match.replace(/<br>\s*/g, "");
					return "<ol>" + cleanMatch + "</ol>";
				},
			);

			// Wrap consecutive regular list items in <ul> tags
			formattedReasoning = formattedReasoning.replace(
				/(<li>(?!.*class="numbered-list").*?<\/li>)(\s*<br>\s*<li>(?!.*class="numbered-list").*?<\/li>)*/g,
				(match) => {
					const cleanMatch = match.replace(/<br>\s*/g, "");
					return "<ul>" + cleanMatch + "</ul>";
				},
			);

			// Wrap in paragraphs if needed
			if (
				formattedReasoning.includes("</p><p>") &&
				!formattedReasoning.startsWith("<")
			) {
				formattedReasoning = "<p>" + formattedReasoning + "</p>";
			}

			reasoningEl.innerHTML = formattedReasoning;
			console.log(
				"[Letta Plugin] Successfully created reasoning element with content",
			);
		} else {
			console.log(
				"[Letta Plugin] Not displaying reasoning content - either empty or setting disabled",
			);
			console.log(
				"[Letta Plugin] Reasoning content length:",
				this.currentReasoningContent.length,
			);
			console.log(
				"[Letta Plugin] showReasoning setting:",
				this.plugin.settings.showReasoning,
			);
		}

		// Tool call expandable section
		const toolCallHeader = bubbleEl.createEl("div", {
			cls: "letta-expandable-header letta-tool-section letta-tool-prominent",
		});

		const toolLeftSide = toolCallHeader.createEl("div", {
			cls: "letta-tool-left",
		});
		toolLeftSide.createEl("span", {
			cls: "letta-expandable-title letta-tool-name",
			text: toolName,
		});

		// Curvy connecting line (SVG)
		const connectionLine = toolCallHeader.createEl("div", {
			cls: "letta-tool-connection",
		});
		const svg = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"svg",
		);
		svg.setAttribute("viewBox", "0 0 400 12");
		svg.setAttribute("preserveAspectRatio", "none");
		svg.setAttribute("class", "letta-tool-curve");

		const path = document.createElementNS(
			"http://www.w3.org/2000/svg",
			"path",
		);
		path.setAttribute(
			"d",
			"M 0,6 Q 12.5,2 25,6 Q 37.5,10 50,6 Q 62.5,2 75,6 Q 87.5,10 100,6 Q 112.5,2 125,6 Q 137.5,10 150,6 Q 162.5,2 175,6 Q 187.5,10 200,6 Q 212.5,2 225,6 Q 237.5,10 250,6 Q 262.5,2 275,6 Q 287.5,10 300,6 Q 312.5,2 325,6 Q 337.5,10 350,6 Q 362.5,2 375,6 Q 387.5,10 400,6 Q 412.5,2 425,6 Q 437.5,10 450,6",
		);
		path.setAttribute("stroke", "var(--interactive-accent)");
		path.setAttribute("stroke-width", "1.5");
		path.setAttribute("fill", "none");
		path.setAttribute("opacity", "0.7");

		svg.appendChild(path);
		connectionLine.appendChild(svg);

		const toolRightSide = toolCallHeader.createEl("div", {
			cls: "letta-tool-right",
		});
		toolRightSide.createEl("span", {
			cls: "letta-expandable-chevron letta-tool-circle",
			text: "○",
		});

		const toolCallContent = bubbleEl.createEl("div", {
			cls: "letta-expandable-content letta-expandable-collapsed",
		});
		const toolCallPre = toolCallContent.createEl("pre", {
			cls: "letta-code-block",
		});
		const streamingCodeEl = toolCallPre.createEl("code", {
			text: JSON.stringify(toolCall, null, 2),
		});
		// Store the tool name in a data attribute for reliable parsing
		streamingCodeEl.setAttribute("data-tool-name", toolName);

		// Add click handler for tool call expand/collapse
		toolCallHeader.addEventListener("click", () => {
			const isCollapsed = toolCallContent.classList.contains(
				"letta-expandable-collapsed",
			);
			if (isCollapsed) {
				toolCallContent.removeClass("letta-expandable-collapsed");
				toolCallHeader.querySelector(
					".letta-expandable-chevron",
				)!.textContent = "●";
			} else {
				toolCallContent.addClass("letta-expandable-collapsed");
				toolCallHeader.querySelector(
					".letta-expandable-chevron",
				)!.textContent = "○";
			}
		});

		// Tool result placeholder (will be filled later)
		const toolResultHeader = bubbleEl.createEl("div", {
			cls: "letta-expandable-header letta-tool-section letta-tool-result-pending",
		});
		toolResultHeader.addClass("letta-tool-result-hidden");
		toolResultHeader.createEl("span", {
			cls: "letta-expandable-title",
			text: "Tool Result",
		});
		toolResultHeader.createEl("span", {
			cls: "letta-expandable-chevron letta-tool-circle",
			text: "○",
		});

		const toolResultContent = bubbleEl.createEl("div", {
			cls: "letta-expandable-content letta-expandable-collapsed",
		});
		toolResultContent.addClass("letta-tool-content-hidden");

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 10);

		// Don't clear reasoning content here - preserve it for potential assistant messages
		// The reasoning content is copied to tool interactions but should remain available
		console.log(
			"[Letta Plugin] Preserving reasoning content for potential assistant messages",
		);
	}

	async handleApprovalRequest(message: any) {
		console.log("[Letta Plugin] handleApprovalRequest called with message:", message);

		const approvalRequestId = message.id;
		const toolCall = message.tool_call || message.toolCall;

		if (!toolCall) {
			console.error("[Letta Plugin] Approval request missing tool_call data");
			return;
		}

		const toolName = toolCall.name || (toolCall.function && toolCall.function.name);
		const toolArgsChunk = toolCall.arguments || "";

		console.log("[Letta Plugin] Approval request - ID:", approvalRequestId, "Tool:", toolName, "Args chunk:", toolArgsChunk);

		// Check if this is a new approval request or a continuation
		if (this.currentApprovalRequestId !== approvalRequestId) {
			// New approval request - initialize accumulation
			console.log("[Letta Plugin] New approval request detected");
			this.currentApprovalRequestId = approvalRequestId;
			this.currentApprovalToolName = toolName;
			this.currentApprovalArgs = toolArgsChunk;
			this.hasCreatedApprovalUI = false;
		} else {
			// Continuation - accumulate arguments
			console.log("[Letta Plugin] Accumulating approval request arguments");
			this.currentApprovalArgs += toolArgsChunk;
		}

		console.log("[Letta Plugin] Accumulated args so far:", this.currentApprovalArgs);

		// Try to parse the accumulated arguments - if it fails, we're still streaming
		let toolArgs: any;
		try {
			toolArgs = typeof this.currentApprovalArgs === 'string'
				? JSON.parse(this.currentApprovalArgs)
				: this.currentApprovalArgs;
			console.log("[Letta Plugin] Successfully parsed accumulated arguments:", toolArgs);
		} catch (parseError) {
			console.log("[Letta Plugin] Arguments not yet complete, waiting for more chunks...");
			return; // Wait for more chunks
		}

		// If we've already created the UI for this request, don't create it again
		if (this.hasCreatedApprovalUI) {
			console.log("[Letta Plugin] Approval UI already created for this request");
			return;
		}

		// Mark that we're creating the UI
		this.hasCreatedApprovalUI = true;

		console.log("[Letta Plugin] Creating approval UI for tool:", toolName);
		console.log("[Letta Plugin] Final tool arguments:", toolArgs);

		// Create approval request UI
		const approvalEl = this.chatContainer.createEl("div", {
			cls: "letta-approval-request",
		});

		// Header
		const headerEl = approvalEl.createEl("div", {
			cls: "letta-approval-header",
		});
		headerEl.createEl("span", {
			text: "🔐 Approval Required",
			cls: "letta-approval-title",
		});

		// Tool info
		const infoEl = approvalEl.createEl("div", {
			cls: "letta-approval-info",
		});
		infoEl.createEl("div", {
			text: `Tool: ${toolName}`,
			cls: "letta-approval-tool-name",
		});

		// Show tool arguments in a formatted way
		const argsEl = infoEl.createEl("div", {
			cls: "letta-approval-args",
		});

		if (toolName === "write_obsidian_note") {
			argsEl.createEl("div", {
				text: `Block Label: ${toolArgs.block_label || 'N/A'}`,
			});
			argsEl.createEl("div", {
				text: `File Path: ${toolArgs.file_path || 'N/A'}`,
			});
		} else {
			argsEl.createEl("pre", {
				text: JSON.stringify(toolArgs, null, 2),
			});
		}

		// Buttons container
		const buttonsEl = approvalEl.createEl("div", {
			cls: "letta-approval-buttons",
		});

		const approveBtn = buttonsEl.createEl("button", {
			text: "Approve",
			cls: "letta-approval-approve-btn",
		});

		const denyBtn = buttonsEl.createEl("button", {
			text: "Deny",
			cls: "letta-approval-deny-btn",
		});

		// Handle approval
		approveBtn.addEventListener("click", async () => {
			console.log("[Letta Plugin] User approved tool call");
			approvalEl.addClass("letta-approval-processing");
			approveBtn.disabled = true;
			denyBtn.disabled = true;
			approveBtn.textContent = "Approving...";

			await this.sendApprovalResponse(approvalRequestId, true, toolArgs);

			// Remove the approval UI after a short delay
			setTimeout(() => {
				approvalEl.remove();
			}, 500);
		});

		// Handle denial
		denyBtn.addEventListener("click", async () => {
			console.log("[Letta Plugin] User denied tool call");

			// Show reason input
			const reasonInput = approvalEl.createEl("textarea", {
				cls: "letta-approval-reason-input",
				attr: {
					placeholder: "Optional: Provide feedback for the agent...",
					rows: "3",
				},
			});

			approveBtn.disabled = true;
			denyBtn.textContent = "Submit Denial";

			// Change deny button to submit the denial
			denyBtn.removeEventListener("click", arguments.callee as any);
			denyBtn.addEventListener("click", async () => {
				const reason = reasonInput.value || "Request denied";
				approvalEl.addClass("letta-approval-processing");
				denyBtn.disabled = true;
				denyBtn.textContent = "Denying...";

				await this.sendApprovalResponse(approvalRequestId, false, toolArgs, reason);

				// Remove the approval UI after a short delay
				setTimeout(() => {
					approvalEl.remove();
				}, 500);
			});
		});

		// Auto-scroll to approval request
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 10);
	}

	async sendApprovalResponse(approvalRequestId: string, approve: boolean, toolArgs: any, reason?: string) {
		console.log("[Letta Plugin] sendApprovalResponse:", { approvalRequestId, approve, reason });

		let finalApprove = approve;
		let finalReason = reason;

		try {
			// If approved and it's a write_obsidian_note call, execute the write
			if (approve && toolArgs.block_label && toolArgs.file_path) {
				console.log("[Letta Plugin] Executing note write...");
				try {
					await this.executeNoteWrite(toolArgs.block_label, toolArgs.file_path);
				} catch (writeError: any) {
					// If the write fails, convert approval to denial with error message
					console.error("[Letta Plugin] Note write failed, converting to denial:", writeError);
					finalApprove = false;
					finalReason = `Failed to write note: ${writeError.message}`;
					new Notice(`Failed to write note: ${writeError.message}`);
				}
			}

			// Send approval/denial message to agent
			const approvalMessage = {
				id: `approval-response-${Date.now()}`,
				date: new Date().toISOString(),
				messageType: "approval_response_message",
				approve: finalApprove,
				approvalRequestId: approvalRequestId,
				...(finalReason && !finalApprove ? { reason: finalReason } : {})
			};

			console.log("[Letta Plugin] Sending approval response:", approvalMessage);

			// Send the approval message using the streaming API
			if (!this.plugin.agent || !this.plugin.client) {
				throw new Error("Agent or client not initialized");
			}

			const stream = await this.plugin.client.agents.messages.createStream(
				this.plugin.agent.id,
				{
					messages: [approvalMessage as any],
					streamTokens: this.plugin.settings.useTokenStreaming,
				},
			);

			// Process the stream responses
			for await (const chunk of stream) {
				if (chunk && typeof chunk === "object") {
					await this.processStreamingMessage(chunk);
				}
			}

			// Re-enable input after response is processed
			this.messageInput.disabled = false;
			this.sendButton.disabled = false;
			this.sendButton.textContent = "Send";
			this.sendButton.removeClass("letta-button-loading");

			// Reset approval state after completion
			this.currentApprovalRequestId = null;
			this.currentApprovalArgs = "";
			this.currentApprovalToolName = "";
			this.hasCreatedApprovalUI = false;

		} catch (error: any) {
			console.error("[Letta Plugin] Error sending approval response:", error);
			new Notice(`Failed to send approval response: ${error.message}`);

			// Re-enable input on error
			this.messageInput.disabled = false;
			this.sendButton.disabled = false;
			this.sendButton.textContent = "Send";
			this.sendButton.removeClass("letta-button-loading");
		}
	}

	async executeNoteWrite(blockLabel: string, filePath: string) {
		console.log("[Letta Plugin] executeNoteWrite:", { blockLabel, filePath });

		try {
			if (!this.plugin.client) {
				throw new Error("Letta client not initialized");
			}

			// Fetch the block content
			const blocks = await this.plugin.client.blocks.list({ label: blockLabel });
			if (!blocks || blocks.length === 0) {
				throw new Error(`Memory block with label '${blockLabel}' not found`);
			}

			const block = blocks[0];
			const content = block.value || "";

			// Sanitize the file path
			let sanitizedPath = filePath.replace(/[\\:*?"<>|]/g, "_");

			// Prepend default note folder if configured and path doesn't already start with it
			const defaultFolder = this.plugin.settings.defaultNoteFolder?.trim();
			if (defaultFolder && !sanitizedPath.startsWith(defaultFolder + '/')) {
				sanitizedPath = `${defaultFolder}/${sanitizedPath}`;
			}

			// Ensure .md extension
			const fullPath = sanitizedPath.endsWith('.md') ? sanitizedPath : `${sanitizedPath}.md`;

			// Create parent directories if they don't exist
			const pathParts = fullPath.split('/');
			if (pathParts.length > 1) {
				const folderPath = pathParts.slice(0, -1).join('/');
				const folder = this.app.vault.getAbstractFileByPath(folderPath);
				if (!folder) {
					await this.app.vault.createFolder(folderPath);
				}
			}

			// Create or overwrite the file
			const existingFile = this.app.vault.getAbstractFileByPath(fullPath);
			if (existingFile instanceof TFile) {
				await this.app.vault.modify(existingFile, content);
				new Notice(`Updated note: ${fullPath}`);
			} else {
				await this.app.vault.create(fullPath, content);
				new Notice(`Created note: ${fullPath}`);
			}

			console.log("[Letta Plugin] Note written successfully:", fullPath);

		} catch (error) {
			console.error("[Letta Plugin] Error writing note:", error);
			throw error;
		}
	}

	async updateStreamingToolResult(toolReturn: any) {
		console.log("[Letta Plugin] updateStreamingToolResult called for tool:", this.currentToolCallName);
		console.log("[Letta Plugin] Tool return data:", toolReturn);
		
		if (!this.currentToolMessageEl) {
			console.log("[Letta Plugin] ⚠️ No currentToolMessageEl found - tool message may have been removed!");
			return;
		}

		// Use the unified addToolResultToMessage method for consistency
		await this.addToolResultToMessage(
			this.currentToolMessageEl,
			JSON.stringify(toolReturn, null, 2),
			this.currentToolCallName,
			this.currentToolCallData,
		);

		// Auto-scroll to bottom
		setTimeout(() => {
			this.chatContainer.scrollTo({
				top: this.chatContainer.scrollHeight,
				behavior: "smooth",
			});
		}, 10);
	}

	resetStreamingState() {
		// Remove any existing streaming assistant message from DOM
		if (this.currentAssistantMessageEl) {
			this.currentAssistantMessageEl.remove();
		}

		// DON'T remove tool messages - they should persist in the chat
		// Just clear the reference so we don't update them anymore
		// if (this.currentToolMessageEl) {
		//     this.currentToolMessageEl.remove();
		// }

		this.currentReasoningContent = "";
		this.assistantReasoningContent = "";
		this.currentAssistantContent = "";
		this.currentAssistantMessageEl = null;
		this.currentReasoningMessageEl = null;
		this.currentToolMessageEl = null;
		this.currentToolCallId = null;
		this.currentToolCallArgs = "";
		this.currentToolCallName = "";
		this.currentToolCallData = null;
		this.currentApprovalRequestId = null;
		this.currentApprovalArgs = "";
		this.currentApprovalToolName = "";
		this.hasCreatedApprovalUI = false;
	}

	markStreamingComplete() {
		// Reset streaming state
		this.isActivelyStreaming = false;
		this.streamingPhase = 'idle';
		this.currentToolCallNameForStatus = '';

		// Cancel any pending RAF and flush remaining content synchronously
		if (this.rafId !== null) {
			cancelAnimationFrame(this.rafId);
			this.rafId = null;
		}
		this.renderScheduled = false;
		// Synchronously render any remaining content
		if (this.currentAssistantMessageEl) {
			const contentEl = this.currentAssistantMessageEl.querySelector(".letta-message-content");
			if (contentEl && this.currentAssistantContent) {
				this.renderMarkdownContent(contentEl as HTMLElement, this.currentAssistantContent);
			}
		}

		// If streaming was aborted, add a notice to the partial content
		if (this.wasStreamingAborted && this.currentAssistantMessageEl) {
			// Add aborted notice to the message
			const bubbleEl = this.currentAssistantMessageEl.querySelector(".letta-message-bubble");
			if (bubbleEl) {
				const abortedNotice = bubbleEl.createEl("div", {
					cls: "letta-streaming-aborted-notice",
					text: "⏹ Generation stopped",
				});
			}
			this.currentAssistantMessageEl.classList.add("streaming-aborted");
		}
		this.wasStreamingAborted = false;

		// If we have accumulated reasoning content, rebuild the assistant message with proper reasoning structure
		if (this.currentAssistantMessageEl && this.assistantReasoningContent && this.currentAssistantContent) {
			// Remove the current streaming message
			this.currentAssistantMessageEl.remove();

			// Recreate it using the proper addMessage method with reasoning
			this.addMessage(
				"assistant",
				this.currentAssistantContent,
				this.plugin.settings.agentName,
				this.assistantReasoningContent
			);

			// Clear the reasoning content after using it in the assistant message
			this.assistantReasoningContent = "";
		} else {
			// No reasoning content, just mark as complete
			if (this.currentAssistantMessageEl) {
				this.currentAssistantMessageEl.classList.add("streaming-complete");
			}
		}

		// Hide typing indicator
		this.hideTypingIndicator();

		// Reset button state
		this.resetSendButton();
	}

	/**
	 * Transform send button to stop button when streaming begins
	 */
	private showStopButton() {
		this.isActivelyStreaming = true;
		this.sendButton.disabled = false;
		this.sendButton.textContent = "";
		this.sendButton.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg><span>Stop</span>`;
		this.sendButton.removeClass("letta-button-loading");
		this.sendButton.addClass("letta-button-stop");
	}

	/**
	 * Reset send button to normal state
	 */
	private resetSendButton() {
		this.isActivelyStreaming = false;
		this.sendButton.disabled = false;
		this.sendButton.innerHTML = "";
		this.sendButton.textContent = "";
		this.sendButton.createEl("span", { text: "Send" });
		this.sendButton.removeClass("letta-button-loading");
		this.sendButton.removeClass("letta-button-stop");
	}

	/**
	 * Handle stop button click to abort streaming
	 */
	private stopStreaming() {
		if (this.streamAbortController && this.isActivelyStreaming) {
			console.log("[Letta Plugin] User stopped generation");
			this.wasStreamingAborted = true;
			this.streamAbortController.abort();
			// markStreamingComplete will be called by the error handler or completion handler
		}
	}

	addUsageStatistics(usageMessage: any) {
		// Add usage statistics to the current streaming assistant message
		if (!this.currentAssistantMessageEl) return;

		this.addUsageStatsToElement(
			this.currentAssistantMessageEl,
			usageMessage,
		);
	}

	addUsageStatisticsToLastMessage(usageMessage: any) {
		// Add usage statistics to the most recent assistant message in the chat
		const assistantMessages = this.chatContainer.querySelectorAll(
			".letta-message-assistant",
		);
		if (assistantMessages.length === 0) return;

		const lastAssistantMessage = assistantMessages[
			assistantMessages.length - 1
		] as HTMLElement;
		this.addUsageStatsToElement(lastAssistantMessage, usageMessage);
	}

	addUsageStatsToElement(messageEl: HTMLElement, usageMessage: any) {
		const bubbleEl = messageEl.querySelector(".letta-message-bubble");
		if (!bubbleEl) return;

		// Check if usage info already exists to avoid duplicates
		const existingUsage = bubbleEl.querySelector(".letta-usage-stats");
		if (existingUsage) return;

		// Create usage statistics display
		const usageEl = bubbleEl.createEl("div", { cls: "letta-usage-stats" });

		const parts = [];

		if (usageMessage.total_tokens) {
			parts.push(`${usageMessage.total_tokens.toLocaleString()} tokens`);
		} else {
			// Fallback to individual token counts
			if (usageMessage.prompt_tokens || usageMessage.completion_tokens) {
				const prompt = usageMessage.prompt_tokens || 0;
				const completion = usageMessage.completion_tokens || 0;
				const total = prompt + completion;
				parts.push(`${total.toLocaleString()} tokens`);
			}
		}

		if (usageMessage.step_count) {
			parts.push(
				`${usageMessage.step_count} step${usageMessage.step_count === 1 ? "" : "s"}`,
			);
		}

		if (parts.length > 0) {
			usageEl.textContent = parts.join(" • ");
		}
	}

	handleStreamingToolCall(toolCall: any) {
		const toolCallId = toolCall.tool_call_id || toolCall.id;
		const toolName =
			toolCall.name ||
			(toolCall.function && toolCall.function.name) ||
			"Tool Call";
		const toolArgs = toolCall.arguments || toolCall.args || "";

		console.log("[Letta Plugin] handleStreamingToolCall - toolName:", toolName, "toolCallId:", toolCallId);
		
		// Special logging for propose_obsidian_note
		if (toolName === "propose_obsidian_note") {
			console.log("[Letta Plugin] 🔥 PROPOSE_OBSIDIAN_NOTE tool detected in streaming!");
			console.log("[Letta Plugin] Tool call data:", JSON.stringify(toolCall, null, 2));
		}

		// Check if this is a new tool call or a continuation of the current one
		if (this.currentToolCallId !== toolCallId) {
			// New tool call - create the interaction
			console.log(
				"[Letta Plugin] Creating new tool interaction with reasoning content:",
				this.currentReasoningContent,
			);
			this.currentToolCallId = toolCallId;
			this.currentToolCallName = toolName;
			this.currentToolCallArgs = toolArgs;
			this.currentToolCallData = toolCall;
			this.createStreamingToolInteraction(toolCall);
		} else {
			// Continuation of current tool call - accumulate arguments
			this.currentToolCallArgs += toolArgs;

			// Update the tool call display with accumulated arguments
			if (this.currentToolMessageEl) {
				const toolCallPre = this.currentToolMessageEl.querySelector(
					".letta-code-block code",
				);
				if (toolCallPre) {
					const updatedToolCall = {
						...toolCall,
						arguments: this.currentToolCallArgs,
					};
					toolCallPre.textContent = JSON.stringify(
						updatedToolCall,
						null,
						2,
					);
				}
			}
		}

		console.log(
			`[Letta Plugin] Tool call chunk received: ${toolCallId}, args: "${toolArgs}" (accumulated: "${this.currentToolCallArgs}")`,
		);
	}

	// Populate the agent dropdown with recent agents
	populateAgentDropdown(): void {
		if (!this.agentDropdownContent) return;

		this.agentDropdownContent.empty();

		const recentAgents = this.plugin.settings.recentAgents;

		if (recentAgents.length > 0) {
			// Recent agents section
			const recentHeader = this.agentDropdownContent.createEl("div", {
				cls: "letta-dropdown-header",
				text: "Recent Agents",
			});

			for (const agent of recentAgents) {
				const agentItem = this.agentDropdownContent.createEl("div", {
					cls: "letta-dropdown-item",
				});

				const isActive = agent.id === this.plugin.agent?.id;
				if (isActive) {
					agentItem.addClass("active");
				}

				agentItem.createEl("span", {
					text: agent.name,
					cls: "letta-dropdown-item-name"
				});

				if (agent.projectSlug) {
					agentItem.createEl("span", {
						text: agent.projectSlug,
						cls: "letta-dropdown-item-project"
					});
				}

				agentItem.addEventListener("click", async () => {
					if (this.agentDropdownContent) {
						this.agentDropdownContent.classList.remove("show");
					}
					await this.quickSwitchToAgent(agent);
				});
			}

			// Divider
			this.agentDropdownContent.createEl("div", { cls: "letta-dropdown-divider" });
		}

		// "Browse All Agents" option
		const allAgentsItem = this.agentDropdownContent.createEl("div", {
			cls: "letta-dropdown-item letta-dropdown-item-browse",
		});
		allAgentsItem.createEl("span", { text: "Browse All Agents..." });
		allAgentsItem.addEventListener("click", () => {
			if (this.agentDropdownContent) {
				this.agentDropdownContent.classList.remove("show");
			}
			this.openAgentSwitcher();
		});
	}

	// Quick switch to a recent agent
	async quickSwitchToAgent(recent: RecentAgent): Promise<void> {
		// Show switching state immediately for visual feedback
		this.showSwitchingState(recent.name);

		try {
			// Verify agent still exists
			const agent = await this.plugin.makeRequest(`/v1/agents/${recent.id}`);

			if (!agent) {
				// Hide switching state
				this.hideSwitchingState();
				// Remove from recent list
				this.plugin.settings.recentAgents = this.plugin.settings.recentAgents.filter(
					(a) => a.id !== recent.id
				);
				await this.plugin.saveSettings();
				new Notice(`Agent "${recent.name}" no longer exists`);
				return;
			}

			// Build project object if we have a slug
			const project = recent.projectSlug ? { slug: recent.projectSlug } : undefined;

			// Hide switching state before calling switchToAgent (it will show its own)
			this.hideSwitchingState();

			// Use existing switchToAgent logic (which has its own switching state)
			await this.switchToAgent(agent, project);
		} catch (error) {
			// Always hide switching state on error
			this.hideSwitchingState();
			console.error("[Letta Plugin] Quick switch failed:", error);
			new Notice(`Failed to switch to ${recent.name}`);
		}
	}

	async openAgentSwitcher() {
		if (!this.plugin.settings.lettaApiKey) {
			new Notice("Please configure your Letta API key first");
			return;
		}

		const isCloudInstance =
			this.plugin.settings.lettaBaseUrl.includes("api.letta.com");

		if (isCloudInstance) {
			// For cloud instances, check if we have a valid project slug
			const projectSlug = this.plugin.settings.lettaProjectSlug;

			// Check if project slug looks valid
			const isValidProjectSlug =
				projectSlug &&
				projectSlug !== "obsidian-vault" &&
				projectSlug !== "default-project" &&
				projectSlug !== "filesystem";

			if (!isValidProjectSlug) {
				// Invalid project slug for cloud instances, show project selector
				new Notice("Please select a valid project first");
				this.openProjectSelector();
				return;
			}

			try {
				// Look up the actual project by slug to get the correct ID
				const projectsResponse =
					await this.plugin.makeRequest("/v1/projects");
				const projects = projectsResponse.projects || projectsResponse;
				const currentProject = projects.find(
					(p: any) => p.slug === projectSlug,
				);

				if (!currentProject) {
					new Notice(
						"Project not found. Please select a valid project.",
					);
					this.openProjectSelector();
					return;
				}

				this.openAgentSelector(currentProject, true); // true indicates it's the current project
			} catch (error: any) {
				console.error("Failed to load projects:", error);
				new Notice(
					"Failed to load projects. Please check your connection and try again.",
				);
				return;
			}
		} else {
			// For local instances, show all agents directly
			this.openAgentSelector();
		}
	}

	async openProjectSelector() {
		const modal = new Modal(this.app);
		modal.setTitle("Select Project");

		const { contentEl } = modal;

		// Add search input
		const searchContainer = contentEl.createEl("div", {
			attr: { style: "margin-bottom: 16px;" },
		});

		const searchInput = searchContainer.createEl("input", {
			type: "text",
			placeholder: "Search projects...",
			attr: {
				style: "width: 100%; padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 4px;",
			},
		});

		// Container for projects list
		const projectsContainer = contentEl.createEl("div");

		// Pagination state
		let currentOffset = 0;
		const limit = 10;
		let currentSearch = "";
		let hasMore = true;

		const loadProjects = async (reset = false) => {
			if (reset) {
				currentOffset = 0;
				projectsContainer.empty();
				hasMore = true;
			}

			if (!hasMore && !reset) return;

			const loadingEl = projectsContainer.createEl("div", {
				text: reset
					? "Loading projects..."
					: "Loading more projects...",
				cls: "letta-memory-empty",
			});

			try {
				const params = new URLSearchParams();
				params.append("limit", limit.toString());
				params.append("offset", currentOffset.toString());
				if (currentSearch) {
					params.append("name", currentSearch);
				}

				const projectsResponse = await this.plugin.makeRequest(
					`/v1/projects?${params.toString()}`,
				);
				loadingEl.remove();

				const projects = projectsResponse?.projects || [];
				hasMore = projectsResponse?.hasNextPage || false;

				if (projects.length === 0 && currentOffset === 0) {
					projectsContainer.createEl("div", {
						text: currentSearch
							? "No projects found matching your search"
							: "No projects found",
						cls: "letta-memory-empty",
					});
					return;
				}

				for (const project of projects) {
					const projectEl = projectsContainer.createEl("div");
					projectEl.style.padding = "12px";
					projectEl.style.borderBottom =
						"1px solid var(--background-modifier-border)";
					projectEl.style.cursor = "pointer";

					projectEl.createEl("div", {
						text: project.name,
						attr: {
							style: "font-weight: 500; margin-bottom: 4px;",
						},
					});

					if (project.description) {
						projectEl.createEl("div", {
							text: project.description,
							attr: {
								style: "color: var(--text-muted); font-size: 0.9em;",
							},
						});
					}

					projectEl.addEventListener("click", () => {
						modal.close();
						this.openAgentSelector(project);
					});

					projectEl.addEventListener("mouseenter", () => {
						projectEl.style.backgroundColor =
							"var(--background-modifier-hover)";
					});

					projectEl.addEventListener("mouseleave", () => {
						projectEl.style.backgroundColor = "";
					});
				}

				currentOffset += projects.length;

				// Add "Load More" button if there are more projects
				if (hasMore) {
					const loadMoreBtn = projectsContainer.createEl("button", {
						text: "Load More",
						attr: {
							style: "width: 100%; padding: 10px; margin-top: 10px; border: 1px solid var(--background-modifier-border); background: var(--background-primary); cursor: pointer;",
						},
					});

					loadMoreBtn.addEventListener("click", () => {
						loadMoreBtn.remove();
						loadProjects(false);
					});
				}
			} catch (error: any) {
				loadingEl.textContent = `Failed to load projects: ${error.message}`;
			}
		};

		// Search debouncing
		let searchTimeout: NodeJS.Timeout;
		searchInput.addEventListener("input", () => {
			clearTimeout(searchTimeout);
			searchTimeout = setTimeout(() => {
				currentSearch = searchInput.value.trim();
				loadProjects(true);
			}, 300);
		});

		// Initial load
		loadProjects(true);

		modal.open();

		// Focus search input after modal opens
		setTimeout(() => searchInput.focus(), 100);
	}

	async openAgentSelector(project?: any, isCurrentProject?: boolean) {
		const modal = new Modal(this.app);
		modal.setTitle(
			project ? `Select Agent - ${project.name}` : "Select Agent",
		);

		const { contentEl } = modal;

		const isCloudInstance =
			this.plugin.settings.lettaBaseUrl.includes("api.letta.com");

		if (
			isCloudInstance &&
			this.plugin.settings.lettaApiKey &&
			project &&
			!isCurrentProject
		) {
			const backButton = contentEl.createEl("button", {
				text: "← Back to Projects",
				attr: { style: "margin-bottom: 16px;" },
			});
			backButton.addEventListener("click", () => {
				modal.close();
				this.openProjectSelector();
			});
		}

		// Add search and sort controls
		const controlsContainer = contentEl.createEl("div", {
			attr: { style: "margin-bottom: 16px;" },
		});

		// Search row
		const searchRow = controlsContainer.createEl("div", {
			attr: { style: "display: flex; gap: 8px; align-items: center;" },
		});

		const searchInput = searchRow.createEl("input", {
			type: "text",
			placeholder: "Search agents...",
			attr: {
				style: "flex: 1; padding: 8px; border: 1px solid var(--background-modifier-border); border-radius: 4px;",
			},
		});

		// Sort buttons
		const sortContainer = searchRow.createEl("div", {
			attr: { style: "display: flex; gap: 4px;" },
		});

		const sortAscBtn = sortContainer.createEl("button", {
			text: "A-Z",
			attr: {
				title: "Sort A to Z",
				style: "padding: 6px 10px; border: 1px solid var(--background-modifier-border); border-radius: 4px; cursor: pointer; background: var(--background-primary);",
			},
		});

		const sortDescBtn = sortContainer.createEl("button", {
			text: "Z-A",
			attr: {
				title: "Sort Z to A",
				style: "padding: 6px 10px; border: 1px solid var(--background-modifier-border); border-radius: 4px; cursor: pointer; background: var(--background-primary);",
			},
		});

		// Container for agents list
		const agentsContainer = contentEl.createEl("div");

		let currentSearch = "";
		let sortOrder: "asc" | "desc" | "none" = "none";

		const updateSortButtons = () => {
			sortAscBtn.style.background = sortOrder === "asc" ? "var(--interactive-accent)" : "var(--background-primary)";
			sortAscBtn.style.color = sortOrder === "asc" ? "var(--text-on-accent)" : "var(--text-normal)";
			sortDescBtn.style.background = sortOrder === "desc" ? "var(--interactive-accent)" : "var(--background-primary)";
			sortDescBtn.style.color = sortOrder === "desc" ? "var(--text-on-accent)" : "var(--text-normal)";
		};

		sortAscBtn.addEventListener("click", () => {
			sortOrder = sortOrder === "asc" ? "none" : "asc";
			updateSortButtons();
			loadAgents();
		});

		sortDescBtn.addEventListener("click", () => {
			sortOrder = sortOrder === "desc" ? "none" : "desc";
			updateSortButtons();
			loadAgents();
		});

		const loadAgents = async () => {
			agentsContainer.empty();

			const loadingEl = agentsContainer.createEl("div", {
				text: "Loading agents...",
				cls: "letta-memory-empty",
			});

			try {
				const params = new URLSearchParams();
				if (project) {
					params.append("project_id", project.id);
				}
				if (currentSearch) {
					params.append("name", currentSearch);
				}

				const queryString = params.toString();
				const endpoint = `/v1/agents${queryString ? "?" + queryString : ""}`;

				const agents = await this.plugin.makeRequest(endpoint);
				loadingEl.remove();

				if (!agents || agents.length === 0) {
					const emptyDiv = agentsContainer.createEl("div", {
						text: currentSearch
							? "No agents found matching your search"
							: project
								? `No agents found in "${project.name}"`
								: "No agents found",
						attr: { style: "text-align: center; padding: 40px;" },
					});

					if (project && !isCurrentProject && !currentSearch) {
						const backButton = emptyDiv.createEl("button", {
							text: "← Back to Projects",
							attr: { style: "margin-top: 16px;" },
						});
						backButton.addEventListener("click", () => {
							modal.close();
							this.openProjectSelector();
						});
					}
					return;
				}

				// Sort agents if a sort order is selected
				if (sortOrder === "asc") {
					agents.sort((a: any, b: any) => a.name.localeCompare(b.name));
				} else if (sortOrder === "desc") {
					agents.sort((a: any, b: any) => b.name.localeCompare(a.name));
				}

				for (const agent of agents) {
					const agentEl = agentsContainer.createEl("div");
					agentEl.style.padding = "12px";
					agentEl.style.borderBottom =
						"1px solid var(--background-modifier-border)";
					agentEl.style.cursor = "pointer";

					const isCurrentAgent = agent.id === this.plugin.agent?.id;

					const nameEl = agentEl.createEl("div", {
						text: agent.name,
						attr: { style: "font-weight: 500; margin-bottom: 4px;" },
					});

					const infoEl = agentEl.createEl("div", {
						text: `${agent.id.substring(0, 8)}... ${isCurrentAgent ? "(Current)" : ""}`,
						attr: {
							style: "color: var(--text-muted); font-size: 0.9em;",
						},
					});

					if (isCurrentAgent) {
						agentEl.style.backgroundColor =
							"var(--background-modifier-border-hover)";
					}

					agentEl.addEventListener("click", () => {
						modal.close();
						this.switchToAgent(agent, project);
					});

					agentEl.addEventListener("mouseenter", () => {
						agentEl.style.backgroundColor =
							"var(--background-modifier-hover)";
					});

					agentEl.addEventListener("mouseleave", () => {
						if (!isCurrentAgent) {
							agentEl.style.backgroundColor = "";
						} else {
							agentEl.style.backgroundColor =
								"var(--background-modifier-border-hover)";
						}
					});
				}
			} catch (error: any) {
				loadingEl.textContent = `Failed to load agents: ${error.message}`;
			}
		};

		// Search debouncing
		let searchTimeout: NodeJS.Timeout;
		searchInput.addEventListener("input", () => {
			clearTimeout(searchTimeout);
			searchTimeout = setTimeout(() => {
				currentSearch = searchInput.value.trim();
				loadAgents();
			}, 300);
		});

		// Initial load
		loadAgents();

		modal.open();

		// Focus search input after modal opens
		setTimeout(() => searchInput.focus(), 100);
	}

	// Show switching state with visual feedback
	showSwitchingState(agentName: string): void {
		this.isSwitchingAgent = true;
		this.switchingToAgentName = agentName;

		// Add switching class to header for progress bar animation
		if (this.header) {
			this.header.addClass("letta-header-switching");
		}

		// Update agent name to show switching state
		if (this.agentNameElement) {
			this.agentNameElement.textContent = `Switching to ${agentName}...`;
			this.agentNameElement.className = "letta-chat-title switching";
		}

		// Update avatar to switching state
		if (this.agentAvatar) {
			this.agentAvatar.addClass("switching");
			this.agentAvatar.textContent = "...";
		}

		// Update status to switching
		if (this.statusDot) {
			this.statusDot.className = "letta-status-dot switching";
		}
		if (this.statusText) {
			this.statusText.textContent = "Switching agents...";
		}

		// Disable switch button
		if (this.switchButton) {
			this.switchButton.addClass("disabled");
			this.switchButton.setAttribute("aria-disabled", "true");
		}

		// Show skeleton loader in chat container
		this.showSkeletonLoader();

		// Close dropdown if open
		if (this.agentDropdownContent) {
			this.agentDropdownContent.classList.remove("show");
		}
	}

	// Hide switching state and restore normal display
	hideSwitchingState(): void {
		this.isSwitchingAgent = false;
		this.switchingToAgentName = null;

		// Remove switching class from header
		if (this.header) {
			this.header.removeClass("letta-header-switching");
		}

		// Restore agent name display
		this.updateAgentNameDisplay();

		// Update avatar
		this.updateAgentAvatar();

		// Re-enable switch button
		if (this.switchButton) {
			this.switchButton.removeClass("disabled");
			this.switchButton.removeAttribute("aria-disabled");
		}

		// Remove skeleton loader
		this.removeSkeletonLoader();
	}

	// Show skeleton loading state in chat container
	showSkeletonLoader(): void {
		if (!this.chatContainer) return;

		// Clear existing content
		this.chatContainer.empty();

		// Create skeleton container
		const skeleton = this.chatContainer.createEl("div", {
			cls: "letta-chat-skeleton",
		});

		// Add 3 skeleton messages
		for (let i = 0; i < 3; i++) {
			const message = skeleton.createEl("div", {
				cls: "letta-skeleton-message",
			});

			message.createEl("div", { cls: "letta-skeleton-avatar" });

			const content = message.createEl("div", {
				cls: "letta-skeleton-content",
			});

			// Varying line widths for natural look
			const widths = ["85%", "70%", "60%"];
			content.createEl("div", {
				cls: "letta-skeleton-line",
				attr: { style: `width: ${widths[i % 3]}` },
			});
			content.createEl("div", {
				cls: "letta-skeleton-line short",
				attr: { style: `width: ${i === 0 ? "45%" : "55%"}` },
			});
		}
	}

	// Remove skeleton loader
	removeSkeletonLoader(): void {
		if (!this.chatContainer) return;

		const skeleton = this.chatContainer.querySelector(".letta-chat-skeleton");
		if (skeleton) {
			skeleton.remove();
		}
	}

	// Update agent avatar display
	updateAgentAvatar(): void {
		if (!this.agentAvatar) return;

		this.agentAvatar.removeClass("switching");

		if (this.plugin.agent && this.plugin.settings.agentName) {
			// Get initials from agent name
			const name = this.plugin.settings.agentName;
			const initials = name
				.split(/\s+/)
				.map((word: string) => word[0])
				.join("")
				.toUpperCase()
				.slice(0, 2);
			this.agentAvatar.textContent = initials || "?";
			this.agentAvatar.removeClass("no-agent");
		} else {
			this.agentAvatar.textContent = "?";
			this.agentAvatar.addClass("no-agent");
		}
	}

	async switchToAgent(agent: any, project?: any) {
		const agentId = agent.id;
		const agentName = agent.name;
		const projectSlug = project?.slug || this.plugin.settings.lettaProjectSlug;

		console.log(`[Letta Plugin] Switching to agent: ${agentName} (ID: ${agentId})`);

		// RAINMAKER FIX: Abort any in-flight streaming request before switching
		if (this.streamAbortController) {
			console.log("[Letta Plugin] Aborting in-flight streaming request before agent switch");
			this.streamAbortController.abort();
			this.streamAbortController = null;
		}
		// Reset streaming agent ID
		this.currentStreamingAgentId = null;

		// Reset UI state if stuck in sending mode
		if (this.sendButton && this.sendButton.textContent === "Sending...") {
			this.sendButton.textContent = "Send";
			this.sendButton.disabled = false;
			this.sendButton.removeClass("letta-button-loading");
		}
		if (this.messageInput) {
			this.messageInput.disabled = false;
		}
		this.hideTypingIndicator();

		// Show switching state
		this.showSwitchingState(agentName);

		try {
			// Update settings
			this.plugin.settings.agentName = agentName;
			this.plugin.settings.agentId = agentId;
			if (project) {
				this.plugin.settings.lettaProjectSlug = projectSlug;
			}
			await this.plugin.saveSettings();

			// Track in recent agents for quick switching
			await this.plugin.trackRecentAgent({ id: agentId, name: agentName }, projectSlug);

			// Update plugin agent reference
			this.plugin.agent = { id: agentId, name: agentName, ...agent };

			// Verify the agent switch by checking if we can access it
			const verifyAgent = await this.plugin.makeRequest(`/v1/agents/${agentId}`);
			if (!verifyAgent) {
				throw new Error(`Cannot access agent ${agentId} - may not exist or lack permissions`);
			}

			console.log(`[Letta Plugin] Successfully verified agent access: ${verifyAgent.name}`);

			// Ensure Obsidian tools are registered and configured for this agent
			await this.plugin.registerObsidianTools();

			// Hide switching state
			this.hideSwitchingState();

			// Update header UI
			this.updateAgentNameDisplay();
			this.updateAgentAvatar();

			// Update active tab
			this.setActiveTab(agentId);

			// Create tab if it doesn't exist
			if (!this.agentTabs.has(agentId)) {
				const tab = this.createAgentTab(agentId, agentName);
				tab.addClass('active');
			}

			// Load conversation history if enabled
			if (this.plugin.settings.loadHistoryOnSwitch) {
				await this.loadHistoricalMessages();
			} else {
				// Show welcome message for fresh conversation
				await this.addMessage(
					"assistant",
					`Connected to **${agentName}**${project ? ` (Project: ${project.name})` : ""}. Conversation history available.`,
					"System",
				);
			}

			new Notice(`Switched to agent: ${agentName}`);
		} catch (error) {
			// Always hide switching state on error
			this.hideSwitchingState();
			console.error("Failed to switch agent:", error);
			new Notice(`Failed to switch agent: ${(error as Error).message}`);

			// Add error to current chat container
			await this.addMessage(
				"assistant",
				`**Error**: Failed to switch agent: ${(error as Error).message}`,
				"Error",
			);
		}
	}

	/**
	 * Initialize tabs from recent agents list
	 */
	initializeRecentAgentTabs(): void {
		const recentAgents = this.plugin.settings.recentAgents || [];
		const currentAgentId = this.plugin.settings.agentId;

		// Create tabs for recent agents
		for (const recent of recentAgents) {
			const tab = this.createAgentTab(recent.id, recent.name);
			// Mark current agent's tab as active
			if (recent.id === currentAgentId) {
				tab.addClass('active');
			}
		}

		// If current agent isn't in recent agents but we have one, create its tab
		if (currentAgentId && this.plugin.settings.agentName && !this.agentTabs.has(currentAgentId)) {
			const tab = this.createAgentTab(currentAgentId, this.plugin.settings.agentName);
			tab.addClass('active');
		}
	}
}

class LettaMemoryView extends ItemView {
	plugin: LettaPlugin;
	blocks: any[] = [];
	blockEditors: Map<string, HTMLTextAreaElement> = new Map();
	blockSaveButtons: Map<string, HTMLButtonElement> = new Map();
	blockDirtyStates: Map<string, boolean> = new Map();
	refreshButton: HTMLSpanElement;
	lastRefreshTime: Date = new Date();

	constructor(leaf: WorkspaceLeaf, plugin: LettaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType() {
		return LETTA_MEMORY_VIEW_TYPE;
	}

	getDisplayText() {
		return "Memory Blocks";
	}

	getIcon() {
		return "brain-circuit";
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("letta-memory-view");

		// Header
		const header = container.createEl("div", {
			cls: "letta-memory-header",
		});
		header.createEl("h3", { text: "Memory", cls: "letta-memory-title" });

		const buttonContainer = header.createEl("div");
		buttonContainer.style.display = "flex";
		buttonContainer.style.gap = "8px";

		const createButton = buttonContainer.createEl("span", { text: "New" });
		createButton.style.cssText =
			"cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px;";
		createButton.addEventListener("mouseenter", () => {
			createButton.style.opacity = "1";
		});
		createButton.addEventListener("mouseleave", () => {
			createButton.style.opacity = "0.7";
		});
		createButton.addEventListener("click", () => this.createNewBlock());

		const attachButton = buttonContainer.createEl("span", {
			text: "Manage",
		});
		attachButton.style.cssText =
			"cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px;";
		attachButton.addEventListener("mouseenter", () => {
			attachButton.style.opacity = "1";
		});
		attachButton.addEventListener("mouseleave", () => {
			attachButton.style.opacity = "0.7";
		});
		attachButton.addEventListener("click", () =>
			this.searchAndAttachBlocks(),
		);

		this.refreshButton = buttonContainer.createEl("span", {
			text: "Refresh",
		});
		this.refreshButton.style.cssText =
			"cursor: pointer; opacity: 0.7; padding: 2px 6px; margin: 0 4px;";
		this.refreshButton.addEventListener("mouseenter", () => {
			this.refreshButton.style.opacity = "1";
		});
		this.refreshButton.addEventListener("mouseleave", () => {
			this.refreshButton.style.opacity = "0.7";
		});
		this.refreshButton.addEventListener("click", () => this.loadBlocks());

		// Content container
		const contentContainer = container.createEl("div", {
			cls: "letta-memory-content",
		});

		// Load initial blocks
		await this.loadBlocks();
	}

	async loadBlocks() {
		try {
			// Auto-connect if not connected to server
			if (!this.plugin.agent) {
				new Notice("Connecting to agents...");
				const connected = await this.plugin.connectToLetta();
				if (!connected) {
					this.showError("Failed to connect to Letta");
					return;
				}
			}

			this.refreshButton.style.opacity = "0.5";
			this.refreshButton.style.pointerEvents = "none";
			this.refreshButton.textContent = "Loading...";

			// Fetch blocks from API
			this.blocks = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks`,
			);
			this.lastRefreshTime = new Date();

			this.renderBlocks();
		} catch (error) {
			console.error("Failed to load memory blocks:", error);
			this.showError("Failed to load memory blocks");
		} finally {
			this.refreshButton.style.opacity = "0.7";
			this.refreshButton.style.pointerEvents = "auto";
			this.refreshButton.textContent = "↻ Refresh";
		}
	}

	renderBlocks() {
		const contentContainer = this.containerEl.querySelector(
			".letta-memory-content",
		) as HTMLElement;
		contentContainer.empty();

		if (!this.blocks || this.blocks.length === 0) {
			contentContainer.createEl("div", {
				text: "No memory blocks found",
				cls: "letta-memory-empty",
			});
			return;
		}

		// Create block editors
		this.blocks.forEach((block) => {
			const blockContainer = contentContainer.createEl("div", {
				cls: "letta-memory-block",
			});

			// Block header
			const blockHeader = blockContainer.createEl("div", {
				cls: "letta-memory-block-header",
			});

			const titleSection = blockHeader.createEl("div", {
				cls: "letta-memory-title-section",
			});
			titleSection.createEl("h4", {
				text: block.label || block.name || "Unnamed Block",
				cls: "letta-memory-block-title",
			});

			const headerActions = blockHeader.createEl("div", {
				cls: "letta-memory-header-actions",
			});

			// Character counter
			const charCounter = headerActions.createEl("span", {
				text: `${(block.value || "").length}/${block.limit || 5000}`,
				cls: "letta-memory-char-counter",
			});

			// Detach button
			const detachButton = headerActions.createEl("button", {
				text: "Detach",
				cls: "letta-memory-action-btn letta-memory-detach-btn",
				attr: {
					title: "Detach block from agent (keeps block in system)",
				},
			});

			// Delete button
			const deleteButton = headerActions.createEl("button", {
				text: "Delete",
				cls: "letta-memory-action-btn letta-memory-delete-btn",
				attr: { title: "Permanently delete this block" },
			});

			// Event listeners for buttons
			detachButton.addEventListener("click", () =>
				this.detachBlock(block),
			);
			deleteButton.addEventListener("click", () =>
				this.deleteBlock(block),
			);

			// Block description
			if (block.description) {
				blockContainer.createEl("div", {
					text: block.description,
					cls: "letta-memory-block-description",
				});
			}

			// Editor textarea
			const editor = blockContainer.createEl("textarea", {
				cls: "letta-memory-block-editor",
				attr: {
					placeholder: "Enter block content...",
					"data-block-label": block.label || block.name,
				},
			});
			editor.value = block.value || "";

			if (block.read_only) {
				editor.disabled = true;
				editor.style.opacity = "0.6";
			}

			// Update character counter on input
			editor.addEventListener("input", () => {
				const currentLength = editor.value.length;
				const limit = block.limit || 5000;
				charCounter.textContent = `${currentLength}/${limit}`;

				if (currentLength > limit) {
					charCounter.style.color = "var(--text-error)";
				} else {
					charCounter.style.color = "var(--text-muted)";
				}

				// Track dirty state
				const isDirty = editor.value !== (block.value || "");
				this.blockDirtyStates.set(block.label || block.name, isDirty);
				this.updateSaveButton(block.label || block.name, isDirty);
			});

			// Save button
			const saveButton = blockContainer.createEl("button", {
				text: "Save Changes",
				cls: "letta-memory-save-btn",
			});
			saveButton.disabled = true;

			saveButton.addEventListener("click", () =>
				this.saveBlock(block.label || block.name),
			);

			// Store references
			this.blockEditors.set(block.label || block.name, editor);
			this.blockSaveButtons.set(block.label || block.name, saveButton);
			this.blockDirtyStates.set(block.label || block.name, false);
		});
	}

	updateSaveButton(blockLabel: string, isDirty: boolean) {
		const saveButton = this.blockSaveButtons.get(blockLabel);
		if (saveButton) {
			saveButton.disabled = !isDirty;
			saveButton.textContent = isDirty ? "Save Changes" : "No Changes";
		}
	}

	async saveBlock(blockLabel: string) {
		const editor = this.blockEditors.get(blockLabel);
		const saveButton = this.blockSaveButtons.get(blockLabel);

		if (!editor || !saveButton) return;

		try {
			saveButton.disabled = true;
			saveButton.textContent = "Checking...";

			// Step 1: Fetch current server state to check for conflicts
			const serverBlock = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/${blockLabel}`,
			);
			const localBlock = this.blocks.find(
				(b) => (b.label || b.name) === blockLabel,
			);

			if (!localBlock) {
				throw new Error("Local block not found");
			}

			// Step 2: Check for conflicts (server value differs from our original local value)
			const serverValue = (serverBlock.value || "").trim();
			const originalLocalValue = (localBlock.value || "").trim();
			const newValue = editor.value.trim();

			if (serverValue !== originalLocalValue) {
				// Conflict detected - show resolution dialog
				saveButton.textContent = "Conflict Detected";

				const resolution = await this.showConflictDialog(
					blockLabel,
					originalLocalValue,
					serverValue,
					newValue,
				);

				if (resolution === "cancel") {
					saveButton.textContent = "Save Changes";
					return;
				} else if (resolution === "keep-server") {
					// Update editor and local state with server version
					editor.value = serverValue;
					localBlock.value = serverValue;
					this.blockDirtyStates.set(blockLabel, false);
					saveButton.textContent = "No Changes";

					// Update character counter
					const charCounter = this.containerEl
						.querySelector(`[data-block-label="${blockLabel}"]`)
						?.parentElement?.querySelector(
							".letta-memory-char-counter",
						) as HTMLElement;
					if (charCounter) {
						const limit = localBlock.limit || 5000;
						charCounter.textContent = `${serverValue.length}/${limit}`;
						if (serverValue.length > limit) {
							charCounter.style.color = "var(--text-error)";
						} else {
							charCounter.style.color = "var(--text-muted)";
						}
					}

					new Notice(
						`Memory block "${blockLabel}" updated with server version`,
					);
					return;
				}
				// If resolution === 'overwrite', continue with save
			}

			// Step 3: Save our changes (no conflict or user chose to overwrite)
			saveButton.textContent = "Saving...";

			await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/${blockLabel}`,
				{
					method: "PATCH",
					body: { value: newValue },
				},
			);

			// Update local state
			localBlock.value = newValue;
			this.blockDirtyStates.set(blockLabel, false);
			saveButton.textContent = "Saved ✓";

			setTimeout(() => {
				saveButton.textContent = "No Changes";
			}, 2000);

			new Notice(`Memory block "${blockLabel}" updated successfully`);
		} catch (error) {
			console.error(`Failed to save block ${blockLabel}:`, error);
			new Notice(
				`Failed to save block "${blockLabel}". Please try again.`,
			);
			saveButton.textContent = "Save Changes";
		} finally {
			saveButton.disabled =
				this.blockDirtyStates.get(blockLabel) !== true;
		}
	}

	private showConflictDialog(
		blockLabel: string,
		originalValue: string,
		serverValue: string,
		localValue: string,
	): Promise<"keep-server" | "overwrite" | "cancel"> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle("Memory Block Conflict");

			const { contentEl } = modal;

			// Warning message
			const warningEl = contentEl.createEl("div", {
				cls: "conflict-warning",
			});
			warningEl.createEl("p", {
				text: `The memory block "${blockLabel}" has been changed on the server since you started editing.`,
				cls: "conflict-message",
			});

			// Create tabs/sections for different versions
			const versionsContainer = contentEl.createEl("div", {
				cls: "conflict-versions",
			});

			// Server version section
			const serverSection = versionsContainer.createEl("div", {
				cls: "conflict-section",
			});
			serverSection.createEl("h4", {
				text: "🌐 Server Version (Current)",
				cls: "conflict-section-title",
			});
			const serverTextarea = serverSection.createEl("textarea", {
				cls: "conflict-textarea",
				attr: { readonly: "true", rows: "6" },
			});
			serverTextarea.value = serverValue;

			// Your version section
			const localSection = versionsContainer.createEl("div", {
				cls: "conflict-section",
			});
			localSection.createEl("h4", {
				text: "✏️ Your Changes",
				cls: "conflict-section-title",
			});
			const localTextarea = localSection.createEl("textarea", {
				cls: "conflict-textarea",
				attr: { readonly: "true", rows: "6" },
			});
			localTextarea.value = localValue;

			// Character counts
			const serverCount = contentEl.createEl("p", {
				text: `Server version: ${serverValue.length} characters`,
				cls: "conflict-char-count",
			});
			const localCount = contentEl.createEl("p", {
				text: `Your version: ${localValue.length} characters`,
				cls: "conflict-char-count",
			});

			// Action buttons
			const buttonContainer = contentEl.createEl("div", {
				cls: "conflict-buttons",
			});

			const keepServerButton = buttonContainer.createEl("button", {
				text: "Keep Server Version",
				cls: "conflict-btn conflict-btn-server",
			});

			const overwriteButton = buttonContainer.createEl("button", {
				text: "Overwrite with My Changes",
				cls: "conflict-btn conflict-btn-overwrite",
			});

			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel",
				cls: "conflict-btn conflict-btn-cancel",
			});

			// Event handlers
			keepServerButton.addEventListener("click", () => {
				resolve("keep-server");
				modal.close();
			});

			overwriteButton.addEventListener("click", () => {
				resolve("overwrite");
				modal.close();
			});

			cancelButton.addEventListener("click", () => {
				resolve("cancel");
				modal.close();
			});

			modal.open();
		});
	}

	showError(message: string) {
		const contentContainer = this.containerEl.querySelector(
			".letta-memory-content",
		) as HTMLElement;
		contentContainer.empty();
		contentContainer.createEl("div", {
			text: message,
			cls: "letta-memory-error",
		});
	}

	async createNewBlock() {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		const blockData = await this.promptForNewBlock();
		if (!blockData) return;

		try {
			// Step 1: Create the block using the blocks endpoint
			console.log("[Letta Plugin] Creating block with data:", blockData);

			const createResponse = await this.plugin.makeRequest("/v1/blocks", {
				method: "POST",
				body: {
					label: blockData.label,
					description: blockData.description,
					value: blockData.value,
					limit: blockData.limit,
				},
			});

			console.log(
				"[Letta Plugin] Block created successfully:",
				createResponse,
			);

			// Step 2: Attach the block to the agent
			console.log(
				`[Letta Plugin] Attaching block ${createResponse.id} to agent ${this.plugin.agent?.id}`,
			);

			const attachResponse = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/attach/${createResponse.id}`,
				{
					method: "PATCH",
				},
			);

			console.log(
				"[Letta Plugin] Block attached successfully:",
				attachResponse,
			);

			new Notice(`Created and attached memory block: ${blockData.label}`);

			// Refresh the blocks list
			await this.loadBlocks();
		} catch (error) {
			console.error("Failed to create and attach memory block:", error);

			// Fallback: Try the message approach as last resort
			try {
				console.log(
					"[Letta Plugin] Trying message approach as fallback",
				);

				const messageResponse = await this.plugin.makeRequest(
					`/v1/agents/${this.plugin.agent?.id}/messages`,
					{
						method: "POST",
						body: {
							messages: [
								{
									role: "user",
									content: [
										{
											type: "text",
											text: `Please create a new memory block with label "${blockData.label}", description "${blockData.description}", and initial content: "${blockData.value}". Use core_memory_append or appropriate memory tools to add this information to your memory.`,
										},
									],
								},
							],
						},
					},
				);

				console.log(
					"[Letta Plugin] Message approach result:",
					messageResponse,
				);
				new Notice(
					`Requested agent to create memory block: ${blockData.label}`,
				);

				// Refresh the blocks list after a short delay to allow agent processing
				setTimeout(() => this.loadBlocks(), 2000);
			} catch (messageError) {
				console.error(
					"Both creation approaches failed:",
					error,
					messageError,
				);
				new Notice(
					"Failed to create memory block. This feature may not be available in the current API version.",
				);
			}
		}
	}

	private promptForNewBlock(): Promise<{
		label: string;
		value: string;
		limit: number;
		description: string;
	} | null> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle("Create New Memory Block");

			const { contentEl } = modal;
			contentEl.style.width = "500px";

			// Label input
			contentEl.createEl("div", {
				text: "Block Label:",
				cls: "config-label",
			});
			const labelInput = contentEl.createEl("input", {
				type: "text",
				placeholder: "e.g., user_preferences, project_context",
				cls: "config-input",
			});
			labelInput.style.marginBottom = "16px";

			// Description input
			contentEl.createEl("div", {
				text: "Description:",
				cls: "config-label",
			});
			const descriptionInput = contentEl.createEl("input", {
				type: "text",
				placeholder: "Brief description of what this block is for...",
				cls: "config-input",
			});
			descriptionInput.style.marginBottom = "16px";

			// Value textarea
			contentEl.createEl("div", {
				text: "Initial Content (optional):",
				cls: "config-label",
			});
			const valueInput = contentEl.createEl("textarea", {
				placeholder:
					"Enter initial content for this memory block (can be left empty)...",
				cls: "config-textarea",
			});
			valueInput.style.height = "120px";
			valueInput.style.marginBottom = "16px";

			// Limit input
			contentEl.createEl("div", {
				text: "Character Limit:",
				cls: "config-label",
			});
			const limitInput = contentEl.createEl("input", {
				cls: "config-input",
			}) as HTMLInputElement;
			limitInput.type = "number";
			limitInput.value = "2000";
			limitInput.min = "100";
			limitInput.max = "8000";
			limitInput.style.marginBottom = "16px";

			const buttonContainer = contentEl.createEl("div");
			buttonContainer.style.display = "flex";
			buttonContainer.style.gap = "8px";
			buttonContainer.style.justifyContent = "flex-end";

			const createButton = buttonContainer.createEl("button", {
				text: "Create Block",
				cls: "mod-cta",
			});

			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel",
			});

			createButton.addEventListener("click", () => {
				const label = labelInput.value.trim();
				const description = descriptionInput.value.trim();
				const value = valueInput.value; // Don't trim - allow empty content
				const limit = parseInt(limitInput.value) || 2000;

				if (!label) {
					new Notice("Please enter a block label");
					labelInput.focus();
					return;
				}

				if (!description) {
					new Notice("Please enter a description");
					descriptionInput.focus();
					return;
				}

				// Allow empty blocks - content can be added later

				resolve({ label, description, value, limit });
				modal.close();
			});

			cancelButton.addEventListener("click", () => {
				resolve(null);
				modal.close();
			});

			modal.open();
			labelInput.focus();
		});
	}

	async detachBlock(block: any) {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		try {
			// Show confirmation dialog
			const confirmed = await this.showConfirmDialog(
				"Detach Memory Block",
				`Are you sure you want to detach "${block.label || block.name}" from this agent? The block will remain in the system but won't be accessible to this agent.`,
				"Detach",
				"var(--color-orange)",
			);

			if (!confirmed) return;

			console.log(
				"[Letta Plugin] Detaching block:",
				block.label || block.name,
			);

			await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/detach/${block.id}`,
				{
					method: "PATCH",
				},
			);

			new Notice(
				`Memory block "${block.label || block.name}" detached successfully`,
			);

			// Refresh the blocks list
			await this.loadBlocks();
		} catch (error) {
			console.error("Failed to detach block:", error);
			new Notice(
				`Failed to detach block "${block.label || block.name}". Please try again.`,
			);
		}
	}

	async deleteBlock(block: any) {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		try {
			// Show confirmation dialog with stronger warning
			const confirmed = await this.showConfirmDialog(
				"Delete Memory Block",
				`⚠️ Are you sure you want to PERMANENTLY DELETE "${block.label || block.name}"? This action cannot be undone and will remove the block from the entire system.`,
				"Delete Forever",
				"var(--text-error)",
			);

			if (!confirmed) return;

			console.log(
				"[Letta Plugin] Deleting block:",
				block.label || block.name,
			);

			await this.plugin.makeRequest(`/v1/blocks/${block.id}`, {
				method: "DELETE",
			});

			new Notice(
				`Memory block "${block.label || block.name}" deleted permanently`,
			);

			// Refresh the blocks list
			await this.loadBlocks();
		} catch (error) {
			console.error("Failed to delete block:", error);
			new Notice(
				`Failed to delete block "${block.label || block.name}". Please try again.`,
			);
		}
	}

	private showConfirmDialog(
		title: string,
		message: string,
		confirmText: string,
		confirmColor: string,
	): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.setTitle(title);

			const { contentEl } = modal;

			// Warning message
			const messageEl = contentEl.createEl("p", { text: message });
			messageEl.style.marginBottom = "20px";
			messageEl.style.lineHeight = "1.4";

			// Button container
			const buttonContainer = contentEl.createEl("div");
			buttonContainer.style.display = "flex";
			buttonContainer.style.gap = "12px";
			buttonContainer.style.justifyContent = "flex-end";

			// Cancel button
			const cancelButton = buttonContainer.createEl("button", {
				text: "Cancel",
				cls: "conflict-btn conflict-btn-cancel",
			});

			// Confirm button
			const confirmButton = buttonContainer.createEl("button", {
				text: confirmText,
				cls: "conflict-btn",
			});
			confirmButton.style.background = confirmColor;
			confirmButton.style.color = "var(--text-on-accent)";

			// Event handlers
			cancelButton.addEventListener("click", () => {
				resolve(false);
				modal.close();
			});

			confirmButton.addEventListener("click", () => {
				resolve(true);
				modal.close();
			});

			modal.open();
		});
	}

	async searchAndAttachBlocks() {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		try {
			// Get current agent's attached blocks to filter them out
			const attachedBlocks = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks`,
			);
			const attachedBlockIds = new Set(
				attachedBlocks.map((block: any) => block.id),
			);

			// Build query parameters for block search
			let queryParams = "?limit=20"; // Get more blocks for searching

			// If we have a project, filter by project_id
			if (this.plugin.settings.lettaProjectSlug) {
				// Try to get project ID from slug - we'll need to look this up
				try {
					const projects =
						await this.plugin.makeRequest("/v1/projects");
					const currentProject = projects.find(
						(p: any) =>
							p.slug === this.plugin.settings.lettaProjectSlug,
					);
					if (currentProject) {
						queryParams += `&project_id=${currentProject.id}`;
					}
				} catch (error) {
					console.warn(
						"Could not get project ID for filtering blocks:",
						error,
					);
					// Continue without project filter
				}
			}

			// Fetch all available blocks
			const allBlocks = await this.plugin.makeRequest(
				`/v1/blocks${queryParams}`,
			);

			// Filter out already attached blocks and templates
			const availableBlocks = allBlocks.filter(
				(block: any) =>
					!attachedBlockIds.has(block.id) && !block.is_template,
			);

			if (availableBlocks.length === 0) {
				new Notice("No unattached blocks found in the current scope");
				return;
			}

			// Show search/selection modal
			this.showBlockSearchModal(availableBlocks);
		} catch (error) {
			console.error("Failed to search blocks:", error);
			new Notice("Failed to search for blocks. Please try again.");
		}
	}

	private showBlockSearchModal(blocks: any[]) {
		const modal = new Modal(this.app);
		modal.setTitle("Manage Memory Blocks");

		const { contentEl } = modal;
		contentEl.addClass("block-search-modal");

		// Content section
		const content = contentEl.createEl("div", {
			cls: "block-search-content",
		});

		// Search input
		const searchInput = content.createEl("input", {
			type: "text",
			placeholder: "Search blocks by label, description, or content...",
			cls: "block-search-input",
		});

		// Results info
		const resultsInfo = content.createEl("div", {
			text: `Found ${blocks.length} available blocks`,
			cls: "block-search-results-info",
		});

		// Scrollable blocks container
		const blocksContainer = content.createEl("div", {
			cls: "block-search-list",
		});

		// Render all blocks initially
		const renderBlocks = (filteredBlocks: any[]) => {
			blocksContainer.empty();
			resultsInfo.textContent = `Found ${filteredBlocks.length} available blocks`;

			if (filteredBlocks.length === 0) {
				blocksContainer.createEl("div", {
					text: "No blocks match your search",
					cls: "block-search-empty",
				});
				return;
			}

			filteredBlocks.forEach((block) => {
				const blockEl = blocksContainer.createEl("div", {
					cls: "block-search-item",
				});

				// Block header
				const headerEl = blockEl.createEl("div", {
					cls: "block-search-item-header",
				});

				const titleEl = headerEl.createEl("div", {
					cls: "block-search-item-title",
				});

				titleEl.createEl("h4", {
					text: block.label || "Unnamed Block",
				});

				if (block.description) {
					titleEl.createEl("div", {
						text: block.description,
						cls: "block-search-item-description",
					});
				}

				// Character count
				headerEl.createEl("span", {
					text: `${(block.value || "").length} chars`,
					cls: "block-search-item-chars",
				});

				// Preview of content
				const preview = (block.value || "").slice(0, 200);
				const contentPreview = blockEl.createEl("div", {
					cls: "block-search-item-preview",
				});
				contentPreview.textContent =
					preview +
					(block.value && block.value.length > 200 ? "..." : "");

				// Click to attach
				blockEl.addEventListener("click", () => {
					modal.close();
					this.attachBlock(block);
				});
			});
		};

		// Initial render
		renderBlocks(blocks);

		// Search functionality
		searchInput.addEventListener("input", () => {
			const searchTerm = searchInput.value.toLowerCase();
			const filteredBlocks = blocks.filter((block) => {
				const label = (block.label || "").toLowerCase();
				const description = (block.description || "").toLowerCase();
				const content = (block.value || "").toLowerCase();
				return (
					label.includes(searchTerm) ||
					description.includes(searchTerm) ||
					content.includes(searchTerm)
				);
			});
			renderBlocks(filteredBlocks);
		});

		// Button container
		const buttonContainer = content.createEl("div", {
			cls: "block-search-buttons",
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
			cls: "conflict-btn conflict-btn-cancel",
		});

		cancelButton.addEventListener("click", () => modal.close());

		modal.open();
		searchInput.focus();
	}

	async attachBlock(block: any) {
		if (!this.plugin.agent) {
			new Notice("Please connect to Letta first");
			return;
		}

		try {
			console.log(
				"[Letta Plugin] Attaching block:",
				block.label || "Unnamed",
				"to agent:",
				this.plugin.agent?.id,
			);

			// First, get current agent state to ensure we have the latest block list
			const currentAgent = await this.plugin.makeRequest(
				`/v1/agents/${this.plugin.agent?.id}`,
			);
			const currentBlocks = currentAgent.memory?.blocks || [];

			console.log(
				"[Letta Plugin] Current blocks before attach:",
				currentBlocks.map((b: any) => b.label || b.id),
			);

			// Check if block is already attached
			const isAlreadyAttached = currentBlocks.some(
				(b: any) => b.id === block.id,
			);
			if (isAlreadyAttached) {
				new Notice(
					`Memory block "${block.label || "Unnamed"}" is already attached to this agent`,
				);
				return;
			}

			// Try the standard attach endpoint first
			try {
				await this.plugin.makeRequest(
					`/v1/agents/${this.plugin.agent?.id}/core-memory/blocks/attach/${block.id}`,
					{
						method: "PATCH",
					},
				);

				console.log(
					"[Letta Plugin] Successfully attached block using attach endpoint",
				);
				new Notice(
					`Memory block "${block.label || "Unnamed"}" attached successfully`,
				);
			} catch (attachError) {
				console.warn(
					"[Letta Plugin] Attach endpoint failed, trying alternative approach:",
					attachError,
				);

				// Alternative approach: Update agent with complete block list
				const updatedBlockIds = [
					...currentBlocks.map((b: any) => b.id),
					block.id,
				];

				await this.plugin.makeRequest(
					`/v1/agents/${this.plugin.agent?.id}`,
					{
						method: "PATCH",
						body: {
							memory: {
								...currentAgent.memory,
								blocks: updatedBlockIds,
							},
						},
					},
				);

				console.log(
					"[Letta Plugin] Successfully attached block using agent update approach",
				);
				new Notice(
					`Memory block "${block.label || "Unnamed"}" attached successfully`,
				);
			}

			// Refresh the blocks list to show the newly attached block
			await this.loadBlocks();
		} catch (error) {
			console.error("Failed to attach block:", error);
			new Notice(
				`Failed to attach block "${block.label || "Unnamed"}". Please try again.`,
			);
		}
	}

	async onClose() {
		// Clean up any resources if needed
	}
}



class VaultOperationApprovalModal extends Modal {
	plugin: LettaPlugin;
	operation: "write" | "modify" | "delete" | "rename" | "move";
	details: any;
	callback: (approved: boolean, trustSession: boolean) => void;
	trustSessionCheckbox: HTMLInputElement | null = null;

	constructor(
		app: App,
		plugin: LettaPlugin,
		operation: "write" | "modify" | "delete" | "rename" | "move",
		details: any,
		callback: (approved: boolean, trustSession: boolean) => void
	) {
		super(app);
		this.plugin = plugin;
		this.operation = operation;
		this.details = details;
		this.callback = callback;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("letta-vault-approval-modal");

		// Title based on operation
		const titles: Record<string, string> = {
			write: "Approve File Write?",
			modify: "Approve File Modification?",
			delete: "Approve File Deletion?",
			rename: "Approve Rename?",
			move: "Approve Move?",
		};
		contentEl.createEl("h2", { text: titles[this.operation] });

		// Warning icon and message
		const warningDiv = contentEl.createEl("div", { cls: "letta-approval-warning" });
		const warningIcons: Record<string, string> = {
			write: "📝",
			modify: "📝",
			delete: "⚠️",
			rename: "✏️",
			move: "📦",
		};
		warningDiv.createEl("span", { cls: "letta-approval-icon", text: warningIcons[this.operation] });

		const operationDescriptions: Record<string, string> = {
			write: "Your Letta agent wants to create or overwrite a file:",
			modify: "Your Letta agent wants to modify a file:",
			delete: "Your Letta agent wants to delete a file:",
			rename: "Your Letta agent wants to rename a file or folder:",
			move: "Your Letta agent wants to move a file or folder:",
		};
		warningDiv.createEl("span", { text: operationDescriptions[this.operation] });

		// File path
		const pathDiv = contentEl.createEl("div", { cls: "letta-approval-path" });
		pathDiv.createEl("strong", { text: "Path: " });
		pathDiv.createEl("code", { text: this.details.path || this.details.file_path || "Unknown" });

		// Content preview for write/modify operations
		if (this.operation === "write" && this.details.content) {
			const contentDiv = contentEl.createEl("div", { cls: "letta-approval-content" });
			contentDiv.createEl("strong", { text: "Content to write:" });
			const preview = contentDiv.createEl("pre", { cls: "letta-approval-preview" });
			const contentText = this.details.content.length > 500
				? this.details.content.substring(0, 500) + "..."
				: this.details.content;
			preview.createEl("code", { text: contentText });
		}

		if (this.operation === "modify") {
			const modifyDiv = contentEl.createEl("div", { cls: "letta-approval-content" });
			modifyDiv.createEl("strong", { text: "Modification details:" });

			const detailsList = modifyDiv.createEl("ul");
			if (this.details.mode) {
				detailsList.createEl("li", { text: `Mode: ${this.details.mode}` });
			}
			if (this.details.section) {
				detailsList.createEl("li", { text: `Section: ${this.details.section}` });
			}
			if (this.details.content) {
				const contentPreview = this.details.content.length > 200
					? this.details.content.substring(0, 200) + "..."
					: this.details.content;
				const contentLi = detailsList.createEl("li");
				contentLi.createEl("span", { text: "Content: " });
				contentLi.createEl("code", { text: contentPreview });
			}
		}

		if (this.operation === "delete") {
			const deleteWarning = contentEl.createEl("div", { cls: "letta-approval-delete-warning" });
			deleteWarning.createEl("strong", { text: "This action cannot be undone!" });
			deleteWarning.createEl("p", { text: "The file will be moved to Obsidian's trash folder." });
		}

		if (this.operation === "rename") {
			const renameDiv = contentEl.createEl("div", { cls: "letta-approval-content" });
			renameDiv.createEl("strong", { text: "Rename details:" });
			const detailsList = renameDiv.createEl("ul");
			detailsList.createEl("li", { text: `From: ${this.details.oldPath}` });
			detailsList.createEl("li", { text: `To: ${this.details.newName}` });
		}

		if (this.operation === "move") {
			const moveDiv = contentEl.createEl("div", { cls: "letta-approval-content" });
			moveDiv.createEl("strong", { text: "Move details:" });
			const detailsList = moveDiv.createEl("ul");
			detailsList.createEl("li", { text: `Source: ${this.details.sourcePath}` });
			detailsList.createEl("li", { text: `Destination: ${this.details.destFolder}` });
		}

		// Trust session checkbox
		const checkboxDiv = contentEl.createEl("div", { cls: "letta-approval-checkbox" });
		this.trustSessionCheckbox = checkboxDiv.createEl("input", { type: "checkbox" });
		this.trustSessionCheckbox.id = "trust-session-checkbox";
		const checkboxLabel = checkboxDiv.createEl("label");
		checkboxLabel.setAttribute("for", "trust-session-checkbox");
		checkboxLabel.setText("Trust this agent for the rest of this session (no more prompts for vault operations)");

		// Button container
		const buttonContainer = contentEl.createEl("div", { cls: "modal-button-container" });

		const approveButton = buttonContainer.createEl("button", {
			text: this.operation === "delete" ? "Delete File" : "Approve",
			cls: this.operation === "delete" ? "mod-warning" : "mod-cta",
		});
		approveButton.onclick = () => {
			const trustSession = this.trustSessionCheckbox?.checked || false;
			this.callback(true, trustSession);
			this.close();
		};

		const denyButton = buttonContainer.createEl("button", {
			text: "Deny",
		});
		denyButton.onclick = () => {
			this.callback(false, false);
			this.close();
		};

		// Focus deny button for safety
		denyButton.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}


class ToolRegistrationConsentModal extends Modal {
	plugin: LettaPlugin;
	resolve: (consent: boolean) => void;

	constructor(app: App, plugin: LettaPlugin) {
		super(app);
		this.plugin = plugin;
	}
	
	async show(): Promise<boolean> {
		return new Promise<boolean>((resolve) => {
			this.resolve = resolve;
			this.open();
		});
	}
	
	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h2", { text: "Register Custom Tools?" });
		
		const description = contentEl.createEl("div", {
			cls: "modal-description",
		});
		description.innerHTML = `
			<p>Letta wants to register the following custom Obsidian tool:</p>
			<ul>
				<li><code>write_obsidian_note</code> - Write a memory block's content to a specified file path in your vault</li>
			</ul>
			<p><strong>Note:</strong> Tools will be installed for your entire Letta organization but will only be attached to your current agent. Each tool use requires your explicit approval before execution.</p>
			<p><em>You can change this preference in the plugin settings at any time.</em></p>
		`;
		
		const buttonContainer = contentEl.createEl("div", {
			cls: "modal-button-container",
		});
		
		const allowButton = buttonContainer.createEl("button", {
			text: "Register Tools",
			cls: "mod-cta",
		});
		allowButton.onclick = () => {
			this.resolve(true);
			this.close();
		};
		
		const denyButton = buttonContainer.createEl("button", {
			text: "Not Now",
		});
		denyButton.onclick = () => {
			this.resolve(false);
			this.close();
		};
		
		// Auto-focus the deny button for safety
		denyButton.focus();
	}
	
	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class AgentConfigModal extends Modal {
	plugin: LettaPlugin;
	config: AgentConfig;
	resolve: (config: AgentConfig | null) => void;
	reject: (error: Error) => void;

	constructor(app: App, plugin: LettaPlugin) {
		super(app);
		this.plugin = plugin;
		this.config = {
			name: plugin.settings.agentName,
			agent_type: "memgpt_v2_agent", // Default to MemGPT v2 architecture
			description: "An AI assistant for your Obsidian vault",
			include_base_tools: false, // Don't include core_memory* tools
			include_multi_agent_tools: false,
			include_default_source: false,
			tags: ["obsidian", "assistant"],
			model: "letta/letta-free",
			memory_blocks: [
				{
					value: "You are an AI assistant integrated with an Obsidian vault. You have access to the user's markdown files and can help them explore, organize, and work with their notes. Be helpful, knowledgeable, and concise.",
					label: "system",
					limit: 2000,
					description: "Core system instructions",
				},
			],
		};
	}

	async showModal(): Promise<AgentConfig | null> {
		return new Promise((resolve, reject) => {
			this.resolve = resolve;
			this.reject = reject;
			this.open();
		});
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("agent-config-modal");

		// Header
		const header = contentEl.createEl("div", {
			cls: "agent-config-header",
		});
		header.createEl("h2", { text: "Configure New Agent" });
		header.createEl("p", {
			text: "Set up your Letta AI agent with custom configuration",
			cls: "agent-config-subtitle",
		});

		// Form container
		const formEl = contentEl.createEl("div", { cls: "agent-config-form" });

		// Basic Configuration
		const basicSection = formEl.createEl("div", { cls: "config-section" });
		basicSection.createEl("h3", { text: "Basic Configuration" });

		// Agent Name
		const nameGroup = basicSection.createEl("div", { cls: "config-group" });
		nameGroup.createEl("label", {
			text: "Agent Name",
			cls: "config-label",
		});
		const nameInput = nameGroup.createEl("input", {
			type: "text",
			value: this.config.name,
			cls: "config-input",
		});
		nameInput.addEventListener("input", () => {
			this.config.name = nameInput.value;
		});

		// Agent Type
		const typeGroup = basicSection.createEl("div", { cls: "config-group" });
		typeGroup.createEl("label", {
			text: "Agent Type",
			cls: "config-label",
		});
		const typeSelect = typeGroup.createEl("select", {
			cls: "config-select",
		});

		const agentTypes = [
			{
				value: "memgpt_v2_agent",
				label: "MemGPT v2 Agent (Recommended)",
			},
			{ value: "memgpt_agent", label: "MemGPT v1 Agent" },
			{ value: "react_agent", label: "ReAct Agent" },
			{ value: "workflow_agent", label: "Workflow Agent" },
			{ value: "sleeptime_agent", label: "Sleeptime Agent" },
		];

		agentTypes.forEach((type) => {
			const option = typeSelect.createEl("option", {
				value: type.value,
				text: type.label,
			});
			if (type.value === this.config.agent_type) {
				option.selected = true;
			}
		});

		typeSelect.addEventListener("change", () => {
			this.config.agent_type = typeSelect.value as AgentType;
		});

		// Description
		const descGroup = basicSection.createEl("div", { cls: "config-group" });
		descGroup.createEl("label", {
			text: "Description",
			cls: "config-label",
		});
		const descInput = descGroup.createEl("textarea", {
			value: this.config.description || "",
			cls: "config-textarea",
			attr: { rows: "3" },
		});
		descInput.addEventListener("input", () => {
			this.config.description = descInput.value;
		});

		// Advanced Configuration
		const advancedSection = formEl.createEl("div", {
			cls: "config-section",
		});
		advancedSection.createEl("h3", { text: "Advanced Configuration" });

		// Model Configuration
		const modelGroup = advancedSection.createEl("div", {
			cls: "config-group",
		});
		modelGroup.createEl("label", {
			text: "Model (Optional)",
			cls: "config-label",
		});
		const modelHelp = modelGroup.createEl("div", {
			text: "Format: provider/model-name (default: letta/letta-free)",
			cls: "config-help",
		});
		const modelInput = modelGroup.createEl("input", {
			type: "text",
			value: this.config.model || "letta/letta-free",
			cls: "config-input",
			attr: { placeholder: "letta/letta-free" },
		});
		modelInput.addEventListener("input", () => {
			this.config.model = modelInput.value || undefined;
		});

		// Tool Configuration
		const toolsSection = advancedSection.createEl("div", {
			cls: "config-subsection",
		});
		toolsSection.createEl("h4", { text: "Tool Configuration" });

		// Include Base Tools
		const baseToolsGroup = toolsSection.createEl("div", {
			cls: "config-checkbox-group",
		});
		const baseToolsCheckbox = baseToolsGroup.createEl("input", {
			cls: "config-checkbox",
		}) as HTMLInputElement;
		baseToolsCheckbox.type = "checkbox";
		baseToolsCheckbox.checked = this.config.include_base_tools ?? true;
		baseToolsGroup.createEl("label", {
			text: "Include Base Tools (Core memory functions)",
			cls: "config-checkbox-label",
		});
		baseToolsCheckbox.addEventListener("change", () => {
			this.config.include_base_tools = baseToolsCheckbox.checked;
		});

		// Include Multi-Agent Tools
		const multiAgentToolsGroup = toolsSection.createEl("div", {
			cls: "config-checkbox-group",
		});
		const multiAgentToolsCheckbox = multiAgentToolsGroup.createEl("input", {
			cls: "config-checkbox",
		}) as HTMLInputElement;
		multiAgentToolsCheckbox.type = "checkbox";
		multiAgentToolsCheckbox.checked =
			this.config.include_multi_agent_tools ?? false;
		multiAgentToolsGroup.createEl("label", {
			text: "Include Multi-Agent Tools",
			cls: "config-checkbox-label",
		});
		multiAgentToolsCheckbox.addEventListener("change", () => {
			this.config.include_multi_agent_tools =
				multiAgentToolsCheckbox.checked;
		});

		// System Prompt Configuration
		const systemSection = formEl.createEl("div", { cls: "config-section" });
		systemSection.createEl("h3", { text: "System Prompt" });

		const systemGroup = systemSection.createEl("div", {
			cls: "config-group",
		});
		systemGroup.createEl("label", {
			text: "System Instructions",
			cls: "config-label",
		});
		const systemHelp = systemGroup.createEl("div", {
			text: "These instructions define how the agent behaves and responds",
			cls: "config-help",
		});
		const systemInput = systemGroup.createEl("textarea", {
			value: this.config.memory_blocks?.[0]?.value || "",
			cls: "config-textarea",
			attr: { rows: "6" },
		});
		systemInput.addEventListener("input", () => {
			if (!this.config.memory_blocks) {
				this.config.memory_blocks = [];
			}
			if (this.config.memory_blocks.length === 0) {
				this.config.memory_blocks.push({
					value: "",
					label: "system",
					limit: 2000,
					description: "Core system instructions",
				});
			}
			this.config.memory_blocks[0].value = systemInput.value;
		});

		// Tags
		const tagsGroup = systemSection.createEl("div", {
			cls: "config-group",
		});
		tagsGroup.createEl("label", {
			text: "Tags (Optional)",
			cls: "config-label",
		});
		const tagsHelp = tagsGroup.createEl("div", {
			text: "Comma-separated tags for organizing agents",
			cls: "config-help",
		});
		const tagsInput = tagsGroup.createEl("input", {
			type: "text",
			value: this.config.tags?.join(", ") || "",
			cls: "config-input",
			attr: { placeholder: "obsidian, assistant, helpful" },
		});
		tagsInput.addEventListener("input", () => {
			const tags = tagsInput.value
				.split(",")
				.map((tag) => tag.trim())
				.filter((tag) => tag.length > 0);
			this.config.tags = tags.length > 0 ? tags : undefined;
		});

		// Buttons
		const buttonContainer = contentEl.createEl("div", {
			cls: "agent-config-buttons",
		});

		const createButton = buttonContainer.createEl("button", {
			text: "Create Agent",
			cls: "mod-cta agent-config-create-btn",
		});
		createButton.addEventListener("click", () => {
			this.resolve(this.config);
			this.close();
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
			cls: "agent-config-cancel-btn",
		});
		cancelButton.addEventListener("click", () => {
			this.resolve(null);
			this.close();
		});

		// Focus the name input
		nameInput.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
		if (this.resolve) {
			this.resolve(null);
		}
	}
}

class AgentPropertyModal extends Modal {
	agent: any;
	blocks: any[];
	onSave: (config: any) => Promise<void>;

	constructor(
		app: App,
		agent: any,
		blocks: any[],
		onSave: (config: any) => Promise<void>,
	) {
		super(app);
		this.agent = agent;
		this.blocks = blocks;
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass("agent-property-modal");

		// Header
		const header = contentEl.createEl("div", {
			cls: "agent-config-header",
		});
		header.createEl("h2", { text: "Agent Configuration" });
		header.createEl("p", {
			text: "Customize your agent's properties and behavior",
			cls: "agent-config-subtitle",
		});

		// Form container
		const form = contentEl.createEl("div", { cls: "agent-config-form" });

		// Name section
		const nameSection = form.createEl("div", { cls: "config-section" });
		nameSection.createEl("h3", { text: "Basic Information" });

		const nameGroup = nameSection.createEl("div", { cls: "config-group" });
		nameGroup.createEl("label", {
			text: "Agent Name",
			cls: "config-label",
		});
		const nameInput = nameGroup.createEl("input", {
			type: "text",
			cls: "config-input",
			value: this.agent.name || "",
		});

		const descGroup = nameSection.createEl("div", { cls: "config-group" });
		descGroup.createEl("label", {
			text: "Description",
			cls: "config-label",
		});
		descGroup.createEl("div", {
			text: "Optional description for your agent",
			cls: "config-help",
		});
		const descInput = descGroup.createEl("textarea", {
			cls: "config-textarea",
			attr: { rows: "3" },
		});
		descInput.value = this.agent.description || "";

		// System prompt section
		const systemSection = form.createEl("div", { cls: "config-section" });
		systemSection.createEl("h3", { text: "System Prompt" });

		const systemGroup = systemSection.createEl("div", {
			cls: "config-group",
		});
		systemGroup.createEl("label", {
			text: "System Instructions",
			cls: "config-label",
		});
		systemGroup.createEl("div", {
			text: "Instructions that define how your agent behaves and responds",
			cls: "config-help",
		});
		const systemInput = systemGroup.createEl("textarea", {
			cls: "config-textarea",
			attr: { rows: "6" },
		});
		systemInput.value = this.agent.system || "";

		// Tags section
		const tagsSection = form.createEl("div", { cls: "config-section" });
		tagsSection.createEl("h3", { text: "Tags" });

		const tagsGroup = tagsSection.createEl("div", { cls: "config-group" });
		tagsGroup.createEl("label", {
			text: "Tags (comma-separated)",
			cls: "config-label",
		});
		tagsGroup.createEl("div", {
			text: "Organize your agent with tags for easy discovery",
			cls: "config-help",
		});
		const tagsInput = tagsGroup.createEl("input", {
			type: "text",
			cls: "config-input",
			value: this.agent.tags ? this.agent.tags.join(", ") : "",
		});

		// Memory blocks section
		const blocksSection = form.createEl("div", { cls: "config-section" });
		blocksSection.createEl("h3", { text: "Core Memory Blocks" });

		// Create block editors
		this.blocks.forEach((block) => {
			const blockGroup = blocksSection.createEl("div", {
				cls: "config-group",
			});
			const blockHeader = blockGroup.createEl("div", {
				cls: "block-header",
			});

			blockHeader.createEl("label", {
				text: `${block.label || block.name || "Unnamed Block"}`,
				cls: "config-label",
			});

			const blockInfo = blockHeader.createEl("span", {
				text: `${block.value?.length || 0}/${block.limit || 5000} chars`,
				cls: "block-char-count",
			});

			if (block.description) {
				blockGroup.createEl("div", {
					text: block.description,
					cls: "config-help",
				});
			}

			const blockTextarea = blockGroup.createEl("textarea", {
				cls: "config-textarea block-editor",
				attr: {
					rows: "8",
					"data-block-label": block.label || block.name,
				},
			});
			blockTextarea.value = block.value || "";

			if (block.read_only) {
				blockTextarea.disabled = true;
				blockTextarea.style.opacity = "0.6";
			}

			// Add character counter update
			blockTextarea.addEventListener("input", () => {
				const currentLength = blockTextarea.value.length;
				const limit = block.limit || 5000;
				blockInfo.textContent = `${currentLength}/${limit} chars`;

				if (currentLength > limit) {
					blockInfo.style.color = "var(--text-error)";
				} else {
					blockInfo.style.color = "var(--text-muted)";
				}
			});
		});

		// Memory management section
		const memorySection = form.createEl("div", { cls: "config-section" });
		memorySection.createEl("h3", { text: "Memory Management" });

		const clearGroup = memorySection.createEl("div", {
			cls: "config-checkbox-group",
		});
		const clearCheckbox = clearGroup.createEl("input", {
			type: "checkbox",
			cls: "config-checkbox",
		});
		clearCheckbox.checked = this.agent.message_buffer_autoclear || false;
		clearGroup.createEl("label", {
			text: "Auto-clear message buffer (agent won't remember previous messages)",
			cls: "config-checkbox-label",
		});

		// Buttons
		const buttonContainer = contentEl.createEl("div", {
			cls: "agent-config-buttons",
		});

		const saveButton = buttonContainer.createEl("button", {
			text: "Save Changes",
			cls: "agent-config-create-btn",
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
			cls: "agent-config-cancel-btn",
		});

		// Event handlers

		saveButton.addEventListener("click", async () => {
			const config: any = {};
			const blockUpdates: any[] = [];

			// Only include fields that have changed
			if (nameInput.value.trim() !== this.agent.name) {
				config.name = nameInput.value.trim();
			}

			if (descInput.value.trim() !== (this.agent.description || "")) {
				config.description = descInput.value.trim() || null;
			}

			if (systemInput.value.trim() !== (this.agent.system || "")) {
				config.system = systemInput.value.trim() || null;
			}

			const newTags = tagsInput.value.trim()
				? tagsInput.value
						.split(",")
						.map((tag) => tag.trim())
						.filter((tag) => tag)
				: [];
			const currentTags = this.agent.tags || [];
			if (JSON.stringify(newTags) !== JSON.stringify(currentTags)) {
				config.tags = newTags;
			}

			if (
				clearCheckbox.checked !==
				(this.agent.message_buffer_autoclear || false)
			) {
				config.message_buffer_autoclear = clearCheckbox.checked;
			}

			// Check for block changes
			const blockTextareas = form.querySelectorAll(
				".block-editor",
			) as NodeListOf<HTMLTextAreaElement>;
			blockTextareas.forEach((textarea) => {
				const blockLabel = textarea.getAttribute("data-block-label");
				const originalBlock = this.blocks.find(
					(b) => (b.label || b.name) === blockLabel,
				);

				if (
					originalBlock &&
					textarea.value !== (originalBlock.value || "")
				) {
					blockUpdates.push({
						label: blockLabel,
						value: textarea.value,
					});
				}
			});

			// Save changes
			if (Object.keys(config).length > 0 || blockUpdates.length > 0) {
				await this.onSave({ ...config, blockUpdates });
			}

			this.close();
		});

		cancelButton.addEventListener("click", () => {
			this.close();
		});

		// Focus the name input
		nameInput.focus();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class NoteProposalModal extends Modal {
	proposal: ObsidianNoteProposal;
	onSubmit: (accepted: boolean, proposal?: ObsidianNoteProposal) => void;
	titleInput: HTMLInputElement;
	folderInput: HTMLInputElement;
	contentEl: HTMLTextAreaElement;

	constructor(
		app: App,
		proposal: ObsidianNoteProposal,
		onSubmit: (accepted: boolean, proposal?: ObsidianNoteProposal) => void
	) {
		super(app);
		this.proposal = { ...proposal }; // Create a copy to avoid mutating original
		this.onSubmit = onSubmit;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("note-proposal-modal");

		// Header
		contentEl.createEl("h2", { 
			text: "Proposed Note",
			cls: "note-proposal-title"
		});

		// Title section
		const titleContainer = contentEl.createEl("div", { cls: "note-proposal-field" });
		titleContainer.createEl("label", { 
			text: "Title:",
			cls: "note-proposal-label"
		});
		this.titleInput = titleContainer.createEl("input", {
			type: "text",
			value: this.proposal.title,
			cls: "note-proposal-input"
		});
		this.titleInput.addEventListener("input", () => {
			this.proposal.title = this.titleInput.value;
		});

		// Folder section
		const folderContainer = contentEl.createEl("div", { cls: "note-proposal-field" });
		folderContainer.createEl("label", { 
			text: "Folder:",
			cls: "note-proposal-label"
		});
		this.folderInput = folderContainer.createEl("input", {
			type: "text",
			value: this.proposal.folder || "",
			placeholder: "Leave empty for root folder",
			cls: "note-proposal-input"
		});
		this.folderInput.addEventListener("input", () => {
			this.proposal.folder = this.folderInput.value;
		});

		// Tags section (if any)
		if (this.proposal.tags && this.proposal.tags.length > 0) {
			const tagsContainer = contentEl.createEl("div", { cls: "note-proposal-field" });
			tagsContainer.createEl("label", { 
				text: "Tags:",
				cls: "note-proposal-label"
			});
			const tagsDisplay = tagsContainer.createEl("div", { cls: "note-proposal-tags" });
			this.proposal.tags.forEach(tag => {
				tagsDisplay.createEl("span", {
					text: `#${tag}`,
					cls: "note-proposal-tag"
				});
			});
		}

		// Content preview section
		const previewContainer = contentEl.createEl("div", { cls: "note-proposal-preview" });
		previewContainer.createEl("label", { 
			text: "Content Preview:",
			cls: "note-proposal-label"
		});
		
		const contentPreview = previewContainer.createEl("div", { cls: "note-proposal-content-preview" });
		
		// Show a truncated version for preview, full content in textarea
		const previewText = this.proposal.content.length > 300 
			? this.proposal.content.substring(0, 300) + "..."
			: this.proposal.content;
		
		contentPreview.createEl("pre", { 
			text: previewText,
			cls: "note-proposal-preview-text"
		});

		// Full content textarea (initially hidden)
		this.contentEl = previewContainer.createEl("textarea", {
			value: this.proposal.content,
			cls: "note-proposal-content-full"
		});
		this.contentEl.style.display = "none";
		this.contentEl.addEventListener("input", () => {
			this.proposal.content = this.contentEl.value;
		});

		// Toggle button to show/hide full content editor
		const toggleButton = previewContainer.createEl("button", {
			text: "Edit Content",
			cls: "note-proposal-toggle-btn"
		});

		let isEditing = false;
		toggleButton.addEventListener("click", () => {
			isEditing = !isEditing;
			if (isEditing) {
				contentPreview.style.display = "none";
				this.contentEl.style.display = "block";
				this.contentEl.style.height = "200px";
				toggleButton.textContent = "Preview";
			} else {
				contentPreview.style.display = "block";
				this.contentEl.style.display = "none";
				toggleButton.textContent = "Edit Content";
			}
		});

		// Action buttons
		const buttonContainer = contentEl.createEl("div", { cls: "note-proposal-actions" });
		
		const createButton = buttonContainer.createEl("button", {
			text: "Create Note",
			cls: "mod-cta note-proposal-btn"
		});
		createButton.addEventListener("click", () => {
			this.onSubmit(true, this.proposal);
			this.close();
		});

		const cancelButton = buttonContainer.createEl("button", {
			text: "Cancel",
			cls: "note-proposal-btn"
		});
		cancelButton.addEventListener("click", () => {
			this.onSubmit(false);
			this.close();
		});

		// Focus the title input
		setTimeout(() => this.titleInput.focus(), 10);
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

class LettaSettingTab extends PluginSettingTab {
	plugin: LettaPlugin;

	constructor(app: App, plugin: LettaPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "Letta AI Agent Settings" });

		// Engine Mode Selection
		new Setting(containerEl)
			.setName("Engine Mode")
			.setDesc("Choose between Letta Cloud (remote API) or Letta Code (local CLI)")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("cloud", "Letta Cloud (Remote API)")
					.addOption("local", "Letta Code (Local CLI)")
					.setValue(this.plugin.settings.engineMode)
					.onChange(async (value: 'cloud' | 'local') => {
						this.plugin.settings.engineMode = value;
						await this.plugin.saveSettings();
						new Notice(`Engine mode set to: ${value === 'cloud' ? 'Cloud' : 'Local'}`);
						// Note: User needs to reconnect for this to take effect
					}),
			);

		// API Configuration
		containerEl.createEl("h3", { text: "API Configuration" });

		new Setting(containerEl)
			.setName("Letta API Key")
			.setDesc("Your Letta API key for authentication")
			.addText((text) =>
				text
					.setPlaceholder("sk-let-...")
					.setValue(this.plugin.settings.lettaApiKey)
					.onChange(async (value) => {
						this.plugin.settings.lettaApiKey = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Letta Base URL")
			.setDesc("Base URL for Letta API")
			.addText((text) =>
				text
					.setPlaceholder("https://api.letta.com")
					.setValue(this.plugin.settings.lettaBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.lettaBaseUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Project ID")
			.setDesc(
				"Current project identifier (automatically set when selecting agents)",
			)
			.addText((text) =>
				text
					.setPlaceholder("Auto-detected from agent selection")
					.setValue(this.plugin.settings.lettaProjectSlug)
					.onChange(async (value) => {
						this.plugin.settings.lettaProjectSlug = value;
						await this.plugin.saveSettings();
					}),
			);

		// Agent Configuration
		containerEl.createEl("h3", { text: "Agent Configuration" });

		// Agent ID Setting
		new Setting(containerEl)
			.setName("Agent ID")
			.setDesc(
				"ID of the agent to use with this vault. Leave empty to select an agent when starting chat.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Enter agent ID...")
					.setValue(this.plugin.settings.agentId)
					.onChange(async (value) => {
						this.plugin.settings.agentId = value.trim();
						// Clear agent name when ID changes
						if (value.trim() !== this.plugin.settings.agentId) {
							this.plugin.settings.agentName = "";
						}
						await this.plugin.saveSettings();
					}),
			);


		new Setting(containerEl)
			.setName("Auto-Connect on Startup")
			.setDesc("Automatically connect to Letta when Obsidian starts")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoConnect)
					.onChange(async (value) => {
						this.plugin.settings.autoConnect = value;
						await this.plugin.saveSettings();
					}),
			);

		// Chat Configuration
		containerEl.createEl("h3", { text: "Chat Configuration" });

		new Setting(containerEl)
			.setName("Show Reasoning Messages")
			.setDesc(
				"Display AI reasoning messages in the chat (useful for debugging)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showReasoning)
					.onChange(async (value) => {
						this.plugin.settings.showReasoning = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Enable Streaming")
			.setDesc(
				"Use streaming API for real-time responses (disable for slower but more stable responses)",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableStreaming)
					.onChange(async (value) => {
						this.plugin.settings.enableStreaming = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Token Streaming Mode")
			.setDesc(
				"When enabled, responses stream word-by-word (ChatGPT-like). When disabled, responses arrive as complete messages per step (faster on some providers).",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.useTokenStreaming)
					.onChange(async (value) => {
						this.plugin.settings.useTokenStreaming = value;
						await this.plugin.saveSettings();
					}),
			);

		// Focus Mode Settings
		containerEl.createEl("h3", { text: "Focus Mode" });

		new Setting(containerEl)
			.setName("Enable Focus Mode")
			.setDesc(
				"Track and share the currently viewed note with the agent via a special memory block",
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.focusMode)
					.onChange(async (value) => {
						this.plugin.settings.focusMode = value;
						await this.plugin.saveSettings();

						// Enable or disable focus block based on setting
						if (this.plugin.agent) {
							if (value) {
								await this.plugin.ensureFocusBlock();
								await this.plugin.attachFocusBlock();
								// Update with current file
								const activeFile = this.plugin.app.workspace.getActiveFile();
								if (activeFile) {
									await this.plugin.updateFocusBlock(activeFile);
								}
							} else {
								await this.plugin.detachFocusBlock();
							}
						}

						new Notice(value
							? "Focus mode enabled - agent can now see your current note"
							: "Focus mode disabled"
						);
					}),
			);

		new Setting(containerEl)
			.setName("Focus Block Character Limit")
			.setDesc(
				"Maximum number of characters to include in the focus block (default: 4000)",
			)
			.addText((text) =>
				text
					.setPlaceholder("4000")
					.setValue(this.plugin.settings.focusBlockCharLimit.toString())
					.onChange(async (value) => {
						const numValue = parseInt(value, 10);
						if (!isNaN(numValue) && numValue > 0) {
							this.plugin.settings.focusBlockCharLimit = numValue;
							await this.plugin.saveSettings();

							// Update the block limit if it exists
							if (this.plugin.agent && this.plugin.focusBlockId) {
								const focusBlockLabel = this.plugin.getFocusBlockLabel();
								try {
									await this.plugin.client?.agents.blocks.modify(
										this.plugin.agent.id,
										focusBlockLabel,
										{
											limit: numValue,
										}
									);
									new Notice(`Focus block character limit updated to ${numValue}`);
								} catch (error) {
									console.error("[Letta Plugin] Failed to update block limit:", error);
								}
							}
						}
					}),
			);

		new Setting(containerEl)
			.setName("Ask Before Tool Registration")
			.setDesc(
				"Require user consent before registering custom tools with the agent"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.askBeforeToolRegistration)
					.onChange(async (value) => {
						this.plugin.settings.askBeforeToolRegistration = value;
						await this.plugin.saveSettings();
						
						new Notice(value 
							? "Tool registration consent enabled - you'll be asked before tools are registered"
							: "Tool registration consent disabled - tools will register automatically"
						);
					}),
			);

		new Setting(containerEl)
			.setName("Default Note Folder")
			.setDesc(
				"Default folder for new notes created by the agent (leave empty for root folder)"
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g., journal, notes, drafts")
					.setValue(this.plugin.settings.defaultNoteFolder)
					.onChange(async (value) => {
						this.plugin.settings.defaultNoteFolder = value.trim();
						await this.plugin.saveSettings();
					})
			);


		// Multi-Agent Settings
		containerEl.createEl("h3", { text: "Multi-Agent Settings" });

		new Setting(containerEl)
			.setName("Load History on Agent Switch")
			.setDesc(
				"Automatically load conversation history when switching to a different agent"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.loadHistoryOnSwitch)
					.onChange(async (value) => {
						this.plugin.settings.loadHistoryOnSwitch = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("History Page Size")
			.setDesc(
				"Number of messages to load at a time when loading conversation history"
			)
			.addText((text) =>
				text
					.setPlaceholder("50")
					.setValue(this.plugin.settings.historyPageSize.toString())
					.onChange(async (value) => {
						const numValue = parseInt(value, 10);
						if (!isNaN(numValue) && numValue > 0 && numValue <= 200) {
							this.plugin.settings.historyPageSize = numValue;
							await this.plugin.saveSettings();
						}
					}),
			);

		new Setting(containerEl)
			.setName("Clear Recent Agents")
			.setDesc(
				"Clear the list of recently used agents (currently: " +
				this.plugin.settings.recentAgents.length + " agents)"
			)
			.addButton((button) =>
				button
					.setButtonText("Clear")
					.onClick(async () => {
						this.plugin.settings.recentAgents = [];
						await this.plugin.saveSettings();
						new Notice("Recent agents list cleared");
						this.display(); // Refresh settings page
					}),
			);

		// Vault Tools Settings
		containerEl.createEl("h3", { text: "Vault Tools" });

		new Setting(containerEl)
			.setName("Enable Vault Tools")
			.setDesc(
				"Allow agents to read, search, and manipulate files in your vault using specialized tools"
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.enableVaultTools)
					.onChange(async (value) => {
						this.plugin.settings.enableVaultTools = value;
						await this.plugin.saveSettings();

						// Register/unregister tools if agent is available
						if (this.plugin.agent && value) {
							await this.plugin.registerObsidianTools();
							new Notice("Vault tools enabled - agent can now interact with your vault");
						} else if (!value) {
							new Notice("Vault tools disabled");
						}
					}),
			);

		new Setting(containerEl)
			.setName("Blocked Folders")
			.setDesc(
				"Comma-separated list of folders that agents cannot access (default: .obsidian, .trash)"
			)
			.addText((text) =>
				text
					.setPlaceholder(".obsidian, .trash, .git")
					.setValue(this.plugin.settings.blockedFolders.join(", "))
					.onChange(async (value) => {
						this.plugin.settings.blockedFolders = value
							.split(",")
							.map((f) => f.trim())
							.filter((f) => f.length > 0);
						await this.plugin.saveSettings();
					}),
			);

		const approvalDesc = this.plugin.settings.vaultToolsApprovedThisSession
			? "Currently trusted for this session (writes/deletes allowed without prompts)"
			: "First write/delete operation will require your approval";

		new Setting(containerEl)
			.setName("Session Trust Status")
			.setDesc(approvalDesc)
			.addButton((button) =>
				button
					.setButtonText(
						this.plugin.settings.vaultToolsApprovedThisSession
							? "Revoke Trust"
							: "Status OK"
					)
					.setDisabled(!this.plugin.settings.vaultToolsApprovedThisSession)
					.onClick(async () => {
						this.plugin.settings.vaultToolsApprovedThisSession = false;
						await this.plugin.saveSettings();
						new Notice("Session trust revoked - next write/delete will require approval");
						this.display(); // Refresh settings page
					}),
			);

		// Actions
		containerEl.createEl("h3", { text: "Actions" });

		new Setting(containerEl)
			.setName("Connect to Letta")
			.setDesc("Test connection and setup agent")
			.addButton((button) =>
				button
					.setButtonText("Connect")
					.setCta()
					.onClick(async () => {
						await this.plugin.connectToLetta();
					}),
			);

	}

	async addEmbeddingModelDropdown(setting: Setting) {
		try {
			// Fetch available embedding models
			const embeddingModels = await this.plugin.makeRequest(
				"/v1/models/embedding",
			);

			setting.addDropdown((dropdown) => {
				// Add options for each embedding model
				embeddingModels.forEach((model: any) => {
					if (model.handle) {
						dropdown.addOption(model.handle, model.handle);
					}
				});

				// Set current value
				dropdown.setValue("letta/letta-free");

				// Handle changes
				dropdown.onChange(async (value) => {
					// Check if the embedding model has actually changed
					// Remove embedding model setting
					await this.plugin.saveSettings();
				});
			});
		} catch (error) {
			console.error("Failed to fetch embedding models:", error);

			// Fallback to text input if API call fails
			setting.addText((text) =>
				text
					.setPlaceholder("letta/letta-free")
					.setValue("letta/letta-free")
					.onChange(async (value) => {
						// Remove embedding model setting
						await this.plugin.saveSettings();
					}),
			);
		}

	}





	async showAgentSelector(): Promise<void> {
		try {
			if (!this.plugin.client) throw new Error("Client not initialized");

			// Fetch agents from server
			const agents = await this.plugin.client.agents.list();

			if (!agents || agents.length === 0) {
				new Notice("No agents found. Please create an agent first.");
				return;
			}

			return new Promise((resolve) => {
				const modal = new Modal(this.app);
				modal.setTitle("Select Agent");

				const { contentEl } = modal;

				contentEl.createEl("p", {
					text: "Choose an agent to use with this Obsidian vault:",
					cls: "setting-item-description",
				});

				const agentList = contentEl.createEl("div", {
					cls: "letta-agent-list",
				});

				agents.forEach((agent: any) => {
					const agentItem = agentList.createEl("div", {
						cls: "letta-agent-item",
					});

					const agentInfo = agentItem.createEl("div", {
						cls: "letta-agent-info",
					});
					agentInfo.createEl("div", {
						text: agent.name,
						cls: "letta-agent-item-name",
					});
					agentInfo.createEl("div", {
						text: `ID: ${agent.id}`,
						cls: "letta-agent-item-id",
					});
					if (agent.description) {
						agentInfo.createEl("div", {
							text: agent.description,
							cls: "letta-agent-item-desc",
						});
					}

					const selectButton = agentItem.createEl("button", {
						text: "Select",
						cls: "mod-cta",
					});

					selectButton.addEventListener("click", async () => {
						this.plugin.settings.agentId = agent.id;
						this.plugin.settings.agentName = agent.name;
						await this.plugin.saveSettings();

						// Attempt to connect to the selected agent
						try {
							await this.plugin.setupAgent();
							new Notice(
								`Selected and connected to agent: ${agent.name}`,
							);

							// Update the chat interface to reflect the agent connection
							const chatLeaf =
								this.app.workspace.getLeavesOfType(
									LETTA_CHAT_VIEW_TYPE,
								)[0];
							if (
								chatLeaf &&
								chatLeaf.view instanceof LettaChatView
							) {
								await (
									chatLeaf.view as LettaChatView
								).updateChatStatus();
							}
						} catch (error) {
							console.error(
								"[Letta Plugin] Failed to connect to selected agent:",
								error,
							);
							new Notice(
								`Selected agent ${agent.name}, but failed to connect: ${error.message}`,
							);
						}

						modal.close();

						// Refresh the settings display
						this.display();
						resolve();
					});
				});

				const buttonContainer = contentEl.createEl("div", {
					cls: "modal-button-container",
				});
				const cancelButton = buttonContainer.createEl("button", {
					text: "Cancel",
				});
				cancelButton.addEventListener("click", () => {
					modal.close();
					resolve();
				});

				modal.open();
			});
		} catch (error) {
			console.error("Failed to fetch agents:", error);
			new Notice(
				"Failed to fetch agents. Please check your connection and try again.",
			);
		}
	}
}
