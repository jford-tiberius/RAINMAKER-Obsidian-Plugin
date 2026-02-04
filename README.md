# Rainmaker Obsidian - Letta AI Chat Plugin

Clean chat interface for Letta AI agents. Switch agents, upload files, pure messaging - no clutter.

## Features

- **Clean Chat Panel** - One focused sidebar for all your agent conversations
- **Agent Switcher** - Dropdown to quickly switch between agents
- **File Upload** - Upload files to Letta folders via 📎 button
- **Streaming Responses** - Real-time message streaming
- **Minimal Settings** - Just API key, base URL, and project slug

## Installation

### Via BRAT (Recommended)

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin
2. Add repository: `jford-tiberius/RAINMAKER-Obsidian-Plugin`
3. Enable the plugin in Obsidian settings

### Manual Installation

1. Download latest release from [releases page](https://github.com/jford-tiberius/RAINMAKER-Obsidian-Plugin/releases)
2. Extract to `.obsidian/plugins/rainmaker-obsidian/`
3. Enable in Community Plugins settings

## Configuration

1. Get your Letta API key from [app.letta.com](https://app.letta.com)
2. Open Obsidian Settings → Rainmaker Obsidian
3. Enter:
   - **API Key**: Your Letta API key (starts with `sk-let-`)
   - **Base URL**: `https://api.letta.com` (default)
   - **Project Slug**: Your project identifier
4. Click "Connect"

## Usage

### Open Chat

- Click ribbon icon (message circle)
- Command palette: "Open Letta Chat"

### Switch Agents

Use the dropdown in the chat header to switch between agents.

### Upload Files

Click the 📎 button to upload files to Letta. Files are uploaded to an "uploads" folder and become searchable by the agent.

## Development

```bash
npm install
npm run dev    # Watch mode
npm run build  # Production build
```

## What Changed in v3.0.0

Complete simplification from the upstream fork:

- ❌ Removed memory management UI
- ❌ Removed local mode (Letta Code bridge)
- ❌ Removed vault tools
- ❌ Removed file processors (mammoth, pdfjs, xlsx)
- ✅ Added agent dropdown
- ✅ Simplified to pure chat interface
- ✅ 97% code reduction (443KB → 13KB)

## License

MIT

## Credits

Built on [Letta](https://letta.com) - AI agents with memory
