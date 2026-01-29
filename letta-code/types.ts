/**
 * Type definitions for Letta Code integration
 */

// Message types for communication with Letta Code subprocess
export interface BridgeMessage {
	id: string;
	type: 'request' | 'response' | 'event' | 'error';
	payload: any;
	timestamp: number;
}

// Agent message from Letta Code
export interface LettaCodeMessage {
	message_type: 'user_message' | 'internal_monologue' | 'function_call' | 'function_return' | 'assistant_message';
	content?: string;
	function_call?: {
		name: string;
		arguments: any;
	};
	function_return?: {
		status: string;
		message: string;
	};
	timestamp?: number;
}

// Configuration for Letta Code bridge
export interface LettaCodeConfig {
	agentId?: string;
	workingDirectory: string;
	lettaCodePath?: string; // Path to letta executable (defaults to 'letta')
	debug?: boolean;
}

// Events emitted by the bridge
export interface BridgeEvents {
	message: (message: LettaCodeMessage) => void;
	error: (error: Error) => void;
	ready: () => void;
	closed: () => void;
}
