import {
	App,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	requestUrl,
	ItemView,
	WorkspaceLeaf,
} from "obsidian";
import { LettaClient } from "@letta-ai/letta-client";

// CORS bypass for Letta API
const originalFetch = window.fetch.bind(window);
function createObsidianFetch(lettaBaseUrl: string): typeof fetch {
	return async function obsidianFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
		
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

			return new Response(response.text, {
				status: response.status,
				statusText: response.status === 200 ? 'OK' : 'Error',
				headers: new Headers(response.headers),
			});
		} catch (error) {
			console.error('[Letta] Fetch error:', error);
			throw error;
		}
	};
}

export const LETTA_CHAT_VIEW_TYPE = "letta-chat-view";

interface LettaPluginSettings {
	lettaApiKey: string;
	lettaBaseUrl: string;
	lettaProjectSlug: string;
	agentId: string;
}

const DEFAULT_SETTINGS: LettaPluginSettings = {
	lettaApiKey: "",
	lettaBaseUrl: "https://api.letta.com",
	lettaProjectSlug: "",
	agentId: "",
};

export default class LettaPlugin extends Plugin {
	settings: LettaPluginSettings;
	client: LettaClient | null = null;
	agents: any[] = [];
	currentAgent: any = null;
	customFetch: typeof fetch | null = null;

	async onload() {
		await this.loadSettings();

		// Register chat view
		this.registerView(
			LETTA_CHAT_VIEW_TYPE,
			(leaf) => new LettaChatView(leaf, this)
		);

		// Add ribbon icon
		this.addRibbonIcon("message-circle", "Open Letta Chat", () => {
			this.activateChatView();
		});

		// Add command
		this.addCommand({
			id: "open-letta-chat",
			name: "Open Letta Chat",
			callback: () => this.activateChatView(),
		});

		// Add settings tab
		this.addSettingTab(new LettaSettingTab(this.app, this));

		// Auto-connect if configured
		if (this.settings.lettaApiKey && this.settings.lettaProjectSlug) {
			await this.connectToLetta();
		}
	}

	async activateChatView() {
		const { workspace } = this.app;
		
		let leaf: WorkspaceLeaf | null = null;
		const leaves = workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);

		if (leaves.length > 0) {
			leaf = leaves[0];
		} else {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({
					type: LETTA_CHAT_VIEW_TYPE,
					active: true,
				});
				leaf = rightLeaf;
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}

	async connectToLetta() {
		try {
			if (!this.settings.lettaBaseUrl) {
				new Notice("Letta base URL not configured");
				return;
			}

			// For self-hosted, token might be optional
			const clientOptions: any = {
				baseUrl: this.settings.lettaBaseUrl,
			};
			
			if (this.settings.lettaApiKey) {
				clientOptions.token = this.settings.lettaApiKey;
			}
			
			if (this.settings.lettaProjectSlug) {
				clientOptions.project = this.settings.lettaProjectSlug;
			}
			
			// Store custom fetch for raw requests
			this.customFetch = createObsidianFetch(this.settings.lettaBaseUrl);
			
			this.client = new LettaClient(clientOptions);

			// Test connection by loading agents
			new Notice("Connecting to Letta...");
			await this.loadAgents();

			if (this.agents.length > 0) {
				new Notice(`Connected! Found ${this.agents.length} agent(s)`);
			} else {
				new Notice("Connected, but no agents found");
			}
		} catch (error: any) {
			console.error("[Letta] Connection error:", error);
			new Notice(`Failed to connect: ${error.message || error}`);
		}
	}

	async loadAgents() {
		if (!this.customFetch) return;

		try {
			console.log("[Letta] Loading agents from:", this.settings.lettaBaseUrl);
			
			// Make raw request to bypass SDK validation
			const headers: Record<string, string> = {
				'Content-Type': 'application/json',
			};
			
			if (this.settings.lettaApiKey) {
				headers['Authorization'] = `Bearer ${this.settings.lettaApiKey}`;
			}
			
			if (this.settings.lettaProjectSlug) {
				headers['X-Project'] = this.settings.lettaProjectSlug;
			}
			
			const response = await this.customFetch(`${this.settings.lettaBaseUrl}/v1/agents/`, {
				method: 'GET',
				headers,
			});
			
			if (!response.ok) {
				throw new Error(`HTTP ${response.status}: ${response.statusText}`);
			}
			
			const data = await response.json();
			console.log("[Letta] Agents response:", data);
			
			// Handle both response formats: {agents: [...]} or [...]
			if (Array.isArray(data)) {
				this.agents = data;
			} else if (data && Array.isArray(data.agents)) {
				this.agents = data.agents;
			} else {
				this.agents = [];
			}

			// Set current agent
			if (this.settings.agentId) {
				this.currentAgent = this.agents.find((a: any) => a.id === this.settings.agentId);
			}
			if (!this.currentAgent && this.agents.length > 0) {
				this.currentAgent = this.agents[0];
				this.settings.agentId = this.currentAgent.id;
				await this.saveSettings();
			}
			
			// Update chat view if open
			const leaves = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);
			if (leaves.length > 0 && leaves[0].view instanceof LettaChatView) {
				leaves[0].view.updateAgentDropdown();
			}
		} catch (error: any) {
			console.error("[Letta] Failed to load agents:", error);
			throw error;
		}
	}

	async switchAgent(agentId: string) {
		this.currentAgent = this.agents.find((a: any) => a.id === agentId);
		if (this.currentAgent) {
			this.settings.agentId = agentId;
			await this.saveSettings();
			
			// Refresh chat view
			const leaves = this.app.workspace.getLeavesOfType(LETTA_CHAT_VIEW_TYPE);
			if (leaves.length > 0 && leaves[0].view instanceof LettaChatView) {
				await leaves[0].view.loadMessages();
			}
		}
	}

	async uploadFileToLetta(file: File): Promise<boolean> {
		if (!this.client || !this.currentAgent) return false;

		try {
			// Create/get upload folder
			let folderId = "";
			
			// Try to find existing "uploads" folder
			const foldersResponse: any = await this.client.agents.folders.list(this.currentAgent.id);
			const folders = Array.isArray(foldersResponse) ? foldersResponse : (foldersResponse.folders || []);
			const uploadFolder = folders.find((f: any) => f.name === "uploads");
			
			if (uploadFolder && uploadFolder.id) {
				folderId = uploadFolder.id;
			} else {
				// Create new folder
				const newFolder = await this.client.folders.create({
					name: "uploads",
					description: "Files uploaded from Obsidian",
				});
				if (!newFolder.id) {
					throw new Error("Failed to create folder");
				}
				folderId = newFolder.id;
				
				// Attach to agent
				await this.client.agents.folders.attach(this.currentAgent.id, folderId);
			}

			// Upload file
			await this.client.folders.files.upload(file, folderId, {});

			new Notice(`Uploaded ${file.name} to Letta`);
			return true;
		} catch (error) {
			console.error("[Letta] File upload error:", error);
			new Notice(`Failed to upload ${file.name}`);
			return false;
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}
}

class LettaChatView extends ItemView {
	plugin: LettaPlugin;
	messagesContainer: HTMLElement;
	inputEl: HTMLTextAreaElement;
	sendButton: HTMLButtonElement;
	messages: any[] = [];
	isStreaming: boolean = false;
	agentDropdown: HTMLSelectElement;

	constructor(leaf: WorkspaceLeaf, plugin: LettaPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return LETTA_CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Letta Chat";
	}

	getIcon(): string {
		return "message-circle";
	}

	async onOpen() {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass("letta-chat-container");

		// Header with agent dropdown
		const header = container.createDiv({ cls: "letta-chat-header" });
		
		header.createSpan({ text: "Agent: " });
		this.agentDropdown = header.createEl("select", { cls: "letta-agent-dropdown" });
		
		this.updateAgentDropdown();
		
		this.agentDropdown.addEventListener("change", async () => {
			await this.plugin.switchAgent(this.agentDropdown.value);
		});

		// Messages container
		this.messagesContainer = container.createDiv({ cls: "letta-messages" });

		// Input area
		const inputArea = container.createDiv({ cls: "letta-input-area" });
		
		this.inputEl = inputArea.createEl("textarea", {
			cls: "letta-input",
			attr: { placeholder: "Message Letta..." },
		});

		const buttonsRow = inputArea.createDiv({ cls: "letta-buttons-row" });
		
		// File attach button
		const attachButton = buttonsRow.createEl("button", {
			cls: "letta-button letta-attach-button",
			text: "📎",
			attr: { title: "Attach file" },
		});
		
		attachButton.addEventListener("click", () => {
			const input = document.createElement("input");
			input.type = "file";
			input.multiple = true;
			input.addEventListener("change", async () => {
				if (input.files) {
					for (const file of Array.from(input.files)) {
						await this.plugin.uploadFileToLetta(file);
					}
				}
			});
			input.click();
		});

		// Send button
		this.sendButton = buttonsRow.createEl("button", {
			cls: "letta-button letta-send-button",
			text: "Send",
		});
		
		this.sendButton.addEventListener("click", () => this.sendMessage());
		
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		// Load messages
		await this.loadMessages();
	}

	updateAgentDropdown() {
		this.agentDropdown.empty();
		
		for (const agent of this.plugin.agents) {
			const option = this.agentDropdown.createEl("option", {
				value: agent.id,
				text: agent.name,
			});
			if (this.plugin.currentAgent && agent.id === this.plugin.currentAgent.id) {
				option.selected = true;
			}
		}
	}

	async loadMessages() {
		if (!this.plugin.client || !this.plugin.currentAgent) {
			this.messagesContainer.empty();
			this.messagesContainer.createDiv({
				cls: "letta-empty-state",
				text: "No agent selected. Configure Letta in settings.",
			});
			return;
		}

		try {
			const response: any = await this.plugin.client.agents.messages.list(
				this.plugin.currentAgent.id,
				{ limit: 50 }
			);
			
			// Handle both response formats
			if (Array.isArray(response)) {
				this.messages = response;
			} else if (response && Array.isArray(response.messages)) {
				this.messages = response.messages;
			} else {
				this.messages = [];
			}
			
			this.renderMessages();
		} catch (error) {
			console.error("[Letta] Failed to load messages:", error);
		}
	}

	renderMessages() {
		this.messagesContainer.empty();

		for (const msg of this.messages) {
			if (msg.role === "user" || msg.role === "assistant") {
				const msgEl = this.messagesContainer.createDiv({
					cls: `letta-message letta-message-${msg.role}`,
				});

				const content = msgEl.createDiv({ cls: "letta-message-content" });
				
				// Extract text from message
				let text = "";
				if (Array.isArray(msg.content)) {
					text = msg.content
						.filter((c: any) => c.type === "text")
						.map((c: any) => c.text)
						.join("\n");
				} else if (typeof msg.content === "string") {
					text = msg.content;
				}

				content.setText(text);
			}
		}

		// Scroll to bottom
		this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
	}

	async sendMessage() {
		if (!this.plugin.client || !this.plugin.currentAgent || this.isStreaming) {
			return;
		}

		const message = this.inputEl.value.trim();
		if (!message) return;

		this.inputEl.value = "";
		this.isStreaming = true;
		this.sendButton.disabled = true;

		// Add user message to UI
		const userMsgEl = this.messagesContainer.createDiv({
			cls: "letta-message letta-message-user",
		});
		userMsgEl.createDiv({ cls: "letta-message-content", text: message });

		// Create assistant message placeholder
		const assistantMsgEl = this.messagesContainer.createDiv({
			cls: "letta-message letta-message-assistant",
		});
		const assistantContent = assistantMsgEl.createDiv({ cls: "letta-message-content" });

		try {
			const stream = await this.plugin.client.agents.messages.createStream(
				this.plugin.currentAgent.id,
				{
					messages: [{
						role: "user",
						content: [{ type: "text", text: message }],
					}],
				}
			);

			let fullText = "";

			for await (const chunk of stream) {
				// Handle different chunk types from streaming response
				if ((chunk as any).role === "assistant" && Array.isArray((chunk as any).content)) {
					for (const contentPart of (chunk as any).content) {
						if (contentPart.type === "text" && contentPart.text) {
							fullText += contentPart.text;
							assistantContent.setText(fullText);
							this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
						}
					}
				}
			}
		} catch (error) {
			console.error("[Letta] Send error:", error);
			assistantContent.setText("Error: Failed to send message");
		} finally {
			this.isStreaming = false;
			this.sendButton.disabled = false;
			this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
		}
	}

	async onClose() {
		// Cleanup
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

		new Setting(containerEl)
			.setName("Letta API Key")
			.setDesc("Your Letta API key (starts with sk-let-)")
			.addText((text) =>
				text
					.setPlaceholder("sk-let-...")
					.setValue(this.plugin.settings.lettaApiKey)
					.onChange(async (value) => {
						this.plugin.settings.lettaApiKey = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Letta Base URL")
			.setDesc("Letta server URL")
			.addText((text) =>
				text
					.setPlaceholder("https://api.letta.com")
					.setValue(this.plugin.settings.lettaBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.lettaBaseUrl = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Project Slug")
			.setDesc("Your Letta project identifier")
			.addText((text) =>
				text
					.setPlaceholder("my-project")
					.setValue(this.plugin.settings.lettaProjectSlug)
					.onChange(async (value) => {
						this.plugin.settings.lettaProjectSlug = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Connect")
			.setDesc("Connect to Letta server and load agents")
			.addButton((button) =>
				button.setButtonText("Connect").onClick(async () => {
					await this.plugin.connectToLetta();
				})
			);
	}
}
