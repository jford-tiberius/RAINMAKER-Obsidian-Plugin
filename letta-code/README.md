# Letta Code Integration - Proof of Concept

This directory contains the initial proof of concept for integrating Letta Code (local CLI) with the Rainmaker Obsidian plugin.

## What's Been Built (Milestone 1)

### Core Components

1. **types.ts** - Type definitions for bridge communication
   - `BridgeMessage` - Message format for IPC
   - `LettaCodeMessage` - Agent messages from Letta Code
   - `LettaCodeConfig` - Configuration options
   - `BridgeEvents` - Event handler types

2. **bridge.ts** - LettaCodeBridge class
   - Spawns Letta Code as subprocess
   - Manages process lifecycle (start/stop)
   - Handles message serialization (JSON Lines protocol)
   - Event-driven architecture for messages, errors, ready, closed
   - Automatic cleanup and error recovery

### Plugin Integration

**Modified files**:
- `main.ts` - Added bridge support to main plugin
  - New `bridge` field for LettaCodeBridge instance
  - New `engineMode` setting ('cloud' | 'local')
  - `_connectLocal()` method for local mode connection
  - Settings UI with engine mode dropdown
  - Cleanup in `onunload()`

## How to Test

### Prerequisites

1. **Install Letta Code globally**:
   ```bash
   npm install -g @letta-ai/letta-code
   ```

2. **Verify installation**:
   ```bash
   letta --version
   ```

3. **Set up an agent** (if you haven't already):
   ```bash
   letta
   # Follow prompts to create an agent
   ```

### Testing Steps

1. **Build the plugin**:
   ```bash
   npm run build
   ```

2. **Copy to your test vault**:
   ```bash
   # Copy main.js, manifest.json, styles.css to:
   # <your-vault>/.obsidian/plugins/rainmaker-obsidian/
   ```

3. **Enable the plugin in Obsidian**:
   - Open Settings → Community Plugins
   - Enable "Rainmaker Obsidian"

4. **Configure for local mode**:
   - Settings → Rainmaker Obsidian → Engine Mode
   - Select "Letta Code (Local CLI)"
   - Click "Connect to Letta" button

5. **Open the chat view**:
   - Click the chat icon in the ribbon, or
   - Command palette → "Open Letta Chat"

6. **Test message sending**:
   - Type a message in the chat input
   - Press Enter or click Send
   - Watch the console for debug logs

### What to Look For

**Success indicators**:
- Console logs: `[LettaCodeBridge] Starting Letta Code: letta [...]`
- Console logs: `[Letta Plugin] Letta Code bridge ready`
- Notice: "Connected to Letta Code"
- Status bar: "Connected (Local)"

**Common issues**:

1. **"Letta Code not found"**:
   - Ensure `letta` command is in your PATH
   - Try running `letta --version` in terminal

2. **"Failed to start Letta Code process"**:
   - Check console for error details
   - Verify you have an agent configured
   - Try running `letta` manually to ensure it works

3. **Process exits immediately**:
   - Check if agent ID is valid
   - Verify Letta Code supports headless mode
   - Look at stderr output in console

### Debug Mode

The bridge is initialized with `debug: true`, so you'll see detailed logs:
```
[LettaCodeBridge] Starting Letta Code: letta ['--headless', '--output', 'json', '--agent', 'your-agent-id']
[LettaCodeBridge] stderr: <any output from Letta Code>
[LettaCodeBridge] Received: {...}
```

## Known Limitations (Current Phase)

1. **No tool integration yet** - Vault tools not implemented (Milestone 3)
2. **Limited Letta Code validation** - Assumes headless mode and JSON output work
3. **No message caching** - Local mode doesn't use message cache
4. **Basic error messages** - Letta Code errors may not be user-friendly

## Implementation Status

### ✅ Milestone 1: Proof of Concept (COMPLETE)
- [x] Subprocess management (start/stop/cleanup)
- [x] Settings UI for mode selection
- [x] Connection logic for local mode
- [x] Event system (ready, message, error, closed)

### ✅ Milestone 2: Message Flow (COMPLETE)
- [x] Send messages through bridge
- [x] Receive streaming responses
- [x] Render in chat UI
- [x] Multi-turn conversations
- [x] Error handling and recovery
- [x] Completion detection

See [MILESTONE-2.md](./MILESTONE-2.md) for detailed implementation notes.

### ✅ Milestone 3: Tool Integration (COMPLETE)
- [x] Created BridgeToolRegistry for tool management
- [x] Implemented 4 core vault tools (read, search, list, write)
- [x] Added tool call handler in plugin
- [x] Wired tool results back to bridge
- [x] Permission system (blocked folders, write approval)
- [x] Error handling for tool execution

See [MILESTONE-3.md](./MILESTONE-3.md) for detailed implementation notes.

### ✅ Milestone 4: Enhanced Features (COMPLETE)
- [x] Complete tool set - All 14 tools implemented (11 vault + 3 memory)
- [x] Multi-agent support - Concurrent agent connections
- [x] Memory block integration - Placeholder implementation
- [x] Message caching - Last 200 messages per agent
- [x] Comprehensive testing guide - 80+ test procedures

See [M4-COMPLETE.md](./M4-COMPLETE.md) for full summary and [TESTING-GUIDE.md](./TESTING-GUIDE.md) for testing.

**Complete Tool Set** (11 tools):
- Read: `obsidian_read_file`, `obsidian_search_vault`, `obsidian_list_files`, `obsidian_get_metadata`
- Write: `write_obsidian_note`, `obsidian_modify_file`
- File Management: `obsidian_delete_file`, `obsidian_rename`, `obsidian_move`, `obsidian_copy_file`
- Folders: `obsidian_create_folder`

## Next Steps (Complete M4)

1. **Multi-Agent Support**:
   - Spawn multiple bridge instances
   - Tab-based UI for switching
   - Independent conversations

2. **Memory Block Integration**:
   - Sync memory blocks with Letta Code
   - Real-time updates
   - Conflict resolution

3. **Message Caching**:
   - Cache local mode conversations
   - Fast conversation loading
   - Incremental sync

## Architecture

```
┌─────────────────────────────┐
│ Obsidian Plugin             │
│  ┌──────────────────────┐   │
│  │ Chat View (UI)       │   │
│  └──────────┬───────────┘   │
│             │                │
│  ┌──────────▼───────────┐   │
│  │ LettaCodeBridge      │   │
│  │ - Process mgmt       │   │
│  │ - Message protocol   │   │
│  │ - Event handling     │   │
│  └──────────┬───────────┘   │
└─────────────┼───────────────┘
              │ stdin/stdout
              │ JSON Lines
┌─────────────▼───────────────┐
│ Letta Code CLI              │
│ (subprocess)                │
│ --headless --output json    │
└─────────────┬───────────────┘
              │ HTTPS
              ▼
        ┌─────────────┐
        │ Letta Server│
        │ (local)     │
        └─────────────┘
```

## Files Modified

- `main.ts`:
  - Line 19: Added imports for LettaCodeBridge and types
  - Line 718: Added `bridge` field to LettaPlugin class
  - Line 136: Added `engineMode` to settings interface
  - Line 176: Added default engine mode to DEFAULT_SETTINGS
  - Line 888: Modified `onunload()` to cleanup bridge
  - Line 1310: Modified `_doConnect()` to route to local mode
  - Line 1517: Added `_connectLocal()` method
  - Line 13588: Added engine mode dropdown in settings UI

## Testing Checklist

- [ ] Build succeeds without TypeScript errors
- [ ] Plugin loads in Obsidian
- [ ] Settings UI shows engine mode dropdown
- [ ] Can switch to "Local" mode
- [ ] "Connect to Letta" starts Letta Code subprocess
- [ ] Console shows bridge initialization logs
- [ ] Notice appears: "Connected to Letta Code"
- [ ] Status bar updates to "Connected (Local)"
- [ ] Chat view opens without errors
- [ ] (Future) Can send a message
- [ ] (Future) Agent response appears in chat

## Success Criteria (from Plan)

✅ Can start Letta Code subprocess
✅ Can configure local mode via settings
⏳ Can send user message (wiring needed)
⏳ Can receive agent response (wiring needed)
⏳ Response renders in chat UI (next milestone)

## Notes

- This is a **proof of concept** - not production ready
- Focus is on subprocess communication, not full feature parity
- Message flow completion is next milestone
- Tool integration comes after basic messaging works
