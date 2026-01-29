/**
 * LettaCodeBridge - Manages communication with Letta Code CLI subprocess
 */

import { spawn, ChildProcess } from 'child_process';
import { BridgeMessage, LettaCodeConfig, LettaCodeMessage, BridgeEvents } from './types';

export class LettaCodeBridge {
	private process: ChildProcess | null = null;
	private config: LettaCodeConfig;
	private messageBuffer: string = '';
	private pendingRequests: Map<string, { resolve: Function; reject: Function; timeout: NodeJS.Timeout }> = new Map();
	private messageHandlers: Partial<BridgeEvents> = {};
	private isReady: boolean = false;
	private activeMessageHandler: ((message: LettaCodeMessage) => void) | null = null;
	private messageCache: LettaCodeMessage[] = []; // Cache messages for this agent

	constructor(config: LettaCodeConfig) {
		this.config = {
			lettaCodePath: 'letta',
			debug: false,
			...config,
		};
	}

	/**
	 * Start the Letta Code subprocess
	 */
	async start(agentId?: string): Promise<void> {
		if (this.process) {
			throw new Error('Letta Code bridge already started');
		}

		const args = [
			'--headless', // Non-interactive mode
			'--output', 'json', // JSON output format
		];

		// Add agent ID if provided
		if (agentId || this.config.agentId) {
			args.push('--agent', agentId || this.config.agentId!);
		}

		if (this.config.debug) {
			console.log('[LettaCodeBridge] Starting Letta Code:', this.config.lettaCodePath, args);
		}

		return new Promise((resolve, reject) => {
			try {
				// Spawn the Letta Code process
				this.process = spawn(this.config.lettaCodePath!, args, {
					cwd: this.config.workingDirectory,
					stdio: ['pipe', 'pipe', 'pipe'],
				});

				// Setup stdout handler for responses
				this.process.stdout?.on('data', (data: Buffer) => {
					this.handleOutput(data.toString());
				});

				// Setup stderr handler for errors and debug info
				this.process.stderr?.on('data', (data: Buffer) => {
					const text = data.toString();
					if (this.config.debug) {
						console.log('[LettaCodeBridge] stderr:', text);
					}
					// Some info logs come through stderr, only treat as error if it looks like one
					if (text.toLowerCase().includes('error')) {
						this.emit('error', new Error(text));
					}
				});

				// Handle process exit
				this.process.on('exit', (code, signal) => {
					if (this.config.debug) {
						console.log('[LettaCodeBridge] Process exited:', code, signal);
					}
					this.cleanup();
					this.emit('closed');
				});

				// Handle process errors
				this.process.on('error', (error) => {
					console.error('[LettaCodeBridge] Process error:', error);
					this.emit('error', error);
					reject(error);
				});

				// Wait a moment for process to initialize
				setTimeout(() => {
					if (this.process && !this.process.killed) {
						this.isReady = true;
						this.emit('ready');
						resolve();
					} else {
						reject(new Error('Letta Code process failed to start'));
					}
				}, 1000);

			} catch (error) {
				reject(error);
			}
		});
	}

	/**
	 * Send a message to the agent with streaming callback
	 */
	async sendMessage(
		content: string, 
		images?: Array<{ base64: string; mediaType: string }>,
		onMessage?: (message: LettaCodeMessage) => void
	): Promise<void> {
		if (!this.process || !this.isReady) {
			throw new Error('Letta Code bridge not ready');
		}

		// Store the message handler for this conversation
		if (onMessage) {
			this.activeMessageHandler = onMessage;
		}

		const message: BridgeMessage = {
			id: this.generateId(),
			type: 'request',
			payload: {
				content,
				images,
			},
			timestamp: Date.now(),
		};

		if (this.config.debug) {
			console.log('[LettaCodeBridge] Sending message:', message);
		}

		// Write message as JSON line
		const jsonLine = JSON.stringify(message) + '\n';
		this.process.stdin?.write(jsonLine);
	}

	/**
	 * Handle output from the subprocess
	 */
	private handleOutput(data: string): void {
		// Append to buffer
		this.messageBuffer += data;

		// Process complete lines
		let lineEnd: number;
		while ((lineEnd = this.messageBuffer.indexOf('\n')) !== -1) {
			const line = this.messageBuffer.substring(0, lineEnd).trim();
			this.messageBuffer = this.messageBuffer.substring(lineEnd + 1);

			if (line) {
				this.processLine(line);
			}
		}
	}

	/**
	 * Process a complete JSON line
	 */
	private processLine(line: string): void {
		try {
			const parsed = JSON.parse(line);

			if (this.config.debug) {
				console.log('[LettaCodeBridge] Received:', parsed);
			}

			// Check if this is a Letta Code message
			if (parsed.message_type) {
				const lettaMessage = parsed as LettaCodeMessage;
				
				// Cache the message
				this.messageCache.push(lettaMessage);
				// Keep cache size reasonable (last 200 messages)
				if (this.messageCache.length > 200) {
					this.messageCache = this.messageCache.slice(-200);
				}
				
				// Call active message handler first (for streaming)
				if (this.activeMessageHandler) {
					this.activeMessageHandler(lettaMessage);
				}
				// Also emit to general handlers
				this.emit('message', lettaMessage);
			}
			// Check if this is a bridge response
			else if (parsed.type === 'response' && parsed.id) {
				this.handleResponse(parsed as BridgeMessage);
			}
			// Check if this is an error
			else if (parsed.type === 'error') {
				this.emit('error', new Error(parsed.payload?.message || 'Unknown error'));
			}

		} catch (error) {
			if (this.config.debug) {
				console.error('[LettaCodeBridge] Failed to parse line:', line, error);
			}
		}
	}

	/**
	 * Handle a response message
	 */
	private handleResponse(message: BridgeMessage): void {
		const pending = this.pendingRequests.get(message.id);
		if (pending) {
			clearTimeout(pending.timeout);
			pending.resolve(message.payload);
			this.pendingRequests.delete(message.id);
		}
	}

	/**
	 * Stop the Letta Code subprocess
	 */
	async stop(): Promise<void> {
		if (!this.process) {
			return;
		}

		if (this.config.debug) {
			console.log('[LettaCodeBridge] Stopping Letta Code...');
		}

		// Try graceful shutdown first
		this.process.stdin?.end();

		// Wait a bit, then force kill if needed
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				if (this.process && !this.process.killed) {
					this.process.kill('SIGKILL');
				}
				resolve();
			}, 2000);

			this.process?.once('exit', () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.cleanup();
	}

	/**
	 * Cleanup resources
	 */
	private cleanup(): void {
		this.process = null;
		this.isReady = false;
		this.messageBuffer = '';

		// Reject all pending requests
		for (const [id, pending] of this.pendingRequests.entries()) {
			clearTimeout(pending.timeout);
			pending.reject(new Error('Bridge closed'));
		}
		this.pendingRequests.clear();
	}

	/**
	 * Register event handler
	 */
	on<K extends keyof BridgeEvents>(event: K, handler: BridgeEvents[K]): void {
		this.messageHandlers[event] = handler;
	}

	/**
	 * Emit event to registered handlers
	 */
	private emit<K extends keyof BridgeEvents>(event: K, ...args: any[]): void {
		const handler = this.messageHandlers[event];
		if (handler) {
			(handler as any)(...args);
		}
	}

	/**
	 * Generate unique message ID
	 */
	private generateId(): string {
		return `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
	}

	/**
	 * Send a tool return message to Letta Code
	 */
	async sendToolReturn(toolName: string, status: string, message: string): Promise<void> {
		if (!this.process || !this.isReady) {
			throw new Error('Letta Code bridge not ready');
		}

		const returnMessage: BridgeMessage = {
			id: this.generateId(),
			type: 'response',
			payload: {
				message_type: 'function_return',
				function_return: {
					name: toolName,
					status: status,
					message: message,
				},
			},
			timestamp: Date.now(),
		};

		if (this.config.debug) {
			console.log('[LettaCodeBridge] Sending tool return:', returnMessage);
		}

		// Write message as JSON line
		const jsonLine = JSON.stringify(returnMessage) + '\n';
		this.process.stdin?.write(jsonLine);
	}

	/**
	 * Get cached messages for this agent
	 */
	getCachedMessages(): LettaCodeMessage[] {
		return [...this.messageCache];
	}

	/**
	 * Clear message cache
	 */
	clearCache(): void {
		this.messageCache = [];
		if (this.config.debug) {
			console.log('[LettaCodeBridge] Message cache cleared');
		}
	}

	/**
	 * Check if bridge is ready
	 */
	isConnected(): boolean {
		return this.isReady && this.process !== null && !this.process.killed;
	}
}
