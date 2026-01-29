# Letta Code Integration - User Guide

**Version**: 2.0.0  
**Last Updated**: January 29, 2026  
**For**: Rainmaker Obsidian Plugin Users

---

## Table of Contents

1. [Introduction](#introduction)
2. [What is Letta Code?](#what-is-letta-code)
3. [Installation](#installation)
4. [Getting Started](#getting-started)
5. [Using Vault Tools](#using-vault-tools)
6. [Multi-Agent Mode](#multi-agent-mode)
7. [Tips & Best Practices](#tips--best-practices)
8. [Troubleshooting](#troubleshooting)
9. [FAQ](#faq)

---

## Introduction

The Rainmaker Obsidian Plugin now supports **two modes** of operation:

1. **Cloud Mode** (default): Connects to Letta Cloud API over the internet
2. **Local Mode** (new): Runs Letta Code locally on your machine

This guide focuses on **Local Mode** using Letta Code, which offers:
- ✅ **Full privacy** - All data stays on your machine
- ✅ **Better performance** - Direct file access, no network latency
- ✅ **Enhanced capabilities** - Access to all Letta Code tools
- ✅ **Offline operation** - Works without internet connection

---

## What is Letta Code?

**Letta Code** is a command-line interface (CLI) for running Letta agents locally. Instead of sending your data to the cloud, Letta Code runs entirely on your computer.

### Benefits of Local Mode

**Privacy**:
- Your notes never leave your computer
- Conversations stored locally
- No cloud API calls

**Performance**:
- Instant vault access
- No network delays
- Faster tool execution

**Capabilities**:
- Full vault control (read, write, organize)
- Multiple concurrent agents
- Memory block access
- Conversation caching

---

## Installation

### Prerequisites

- **Obsidian**: Version 1.4.0 or later
- **Node.js**: Version 16 or later
- **Rainmaker Obsidian Plugin**: Installed and enabled

### Step 1: Install Letta Code

Open your terminal and run:

```bash
npm install -g @letta-ai/letta-code
```

Verify installation:

```bash
letta --version
```

You should see a version number (e.g., `letta-code 1.0.0`).

### Step 2: Set Up an Agent

Run Letta Code for the first time:

```bash
letta
```

Follow the interactive prompts to:
1. Choose a model (e.g., GPT-4, Claude, local LLM)
2. Set agent name and persona
3. Configure memory blocks

**Important**: Note your **Agent ID** - you'll need this for the plugin!

### Step 3: Configure Plugin

1. Open Obsidian
2. Go to **Settings → Rainmaker Obsidian**
3. Under **Engine Mode**, select **"Letta Code (Local CLI)"**
4. Enter your **Agent ID** from Step 2
5. Click **"Connect to Letta"**

If successful, you'll see:
- Notice: "Connected to Letta Code"
- Status bar: "Connected (Local)"

---

## Getting Started

### Your First Conversation

1. Click the **chat icon** in the left ribbon, or
2. Open command palette (Ctrl/Cmd+P) and search "Open Letta Chat"

Type a simple message:
```
Hello! Can you help me organize my notes?
```

The agent should respond and offer assistance.

### Approving Vault Access

Before the agent can modify your vault, you need to approve it:

**Method 1: Use /vault Command**

In the chat, type:
```
/vault help
```

This grants approval for the current session.

**Method 2: Settings**

1. Settings → Rainmaker Obsidian
2. Enable **"Auto-approve vault tools"** (if available)

### Testing Vault Tools

Try these commands:

**Read a note**:
```
Read my daily note for today
```

**Search vault**:
```
Search for notes about "project planning"
```

**List files**:
```
What files are in my Projects folder?
```

**Create a note** (requires approval):
```
/vault Create a new note called "Meeting Notes" in my Meetings folder
```

---

## Using Vault Tools

### Read Operations (Always Allowed)

#### Read File
**Command**: `"Read [filename]"`

**Example**:
```
Read Daily Notes/2026-01-29.md
```

**Agent receives**:
- Full note content
- Frontmatter (YAML)
- Tags
- Headings
- Links to other notes
- Creation/modification dates

#### Search Vault
**Command**: `"Search for [query]"`

**Examples**:
```
Search for notes with #project tag
Search my vault for "meeting notes"
Find all notes modified this week
```

**Search types**:
- By name (filename)
- By content (full text)
- By tags
- By path (folder location)

#### List Files
**Command**: `"List files in [folder]"`

**Examples**:
```
List files in Projects folder
Show me all files in Daily Notes
What's in my Archive folder?
```

**Options**:
- Non-recursive (folder only)
- Recursive (includes subfolders)
- Limit results (default: 50)

#### Get Metadata
**Command**: `"Show metadata for [filename]"`

**Example**:
```
What tags does project-a.md have?
```

**Returns**: Tags, headings, links, stats (fast, no content)

---

### Write Operations (Require Approval)

#### Create Note
**Command**: `"/vault Create a note called [title]"`

**Examples**:
```
/vault Create a note called "Daily Reflection"
/vault Create a meeting note in Meetings folder
```

**Features**:
- Auto-adds .md extension
- Creates folders if needed
- Sanitizes filenames

#### Modify Note
**Command**: `"/vault [operation] in [filename]"`

**Operations**:

1. **Append** (add to end):
   ```
   /vault Append "- New task" to my todo list
   ```

2. **Prepend** (add to start):
   ```
   /vault Add this to the top of my daily note
   ```

3. **Replace Section** (update heading):
   ```
   /vault In daily note, replace Tasks section with new tasks
   ```

---

### File Management (Require Approval)

#### Delete File
**Command**: `"/vault Delete [filename]"`

**Example**:
```
/vault Delete old-draft.md
```

**Safety**: Default moves to trash (recoverable)

#### Rename File
**Command**: `"/vault Rename [old name] to [new name]"`

**Example**:
```
/vault Rename meeting-notes.md to 2026-01-29-meeting.md
```

#### Move File
**Command**: `"/vault Move [filename] to [folder]"`

**Example**:
```
/vault Move project-notes.md to Archive folder
```

**Features**:
- Creates destination folder if needed
- Preserves filename
- Updates links automatically (Obsidian)

#### Copy File
**Command**: `"/vault Copy [source] to [destination]"`

**Example**:
```
/vault Copy meeting-template.md to today's meeting note
```

#### Create Folder
**Command**: `"/vault Create folder [path]"`

**Examples**:
```
/vault Create folder Projects/2026
/vault Create nested folders Projects/2026/Q1
```

---

## Multi-Agent Mode

### What is Multi-Agent Mode?

Run **multiple agents simultaneously**, each with:
- Independent conversations
- Separate contexts
- Different capabilities
- Dedicated subprocess

### Setting Up Multiple Agents

1. **Create agents** in Letta Code:
   ```bash
   letta  # Create agent-1
   letta  # Create agent-2
   ```

2. **Note agent IDs**

3. **In plugin**, switch between agents:
   - Settings → Agent ID → Enter agent-2 ID
   - Click "Connect to Letta"
   - Both agents now active!

### Switching Between Agents

**Current**: Manual (change settings)
**Future**: Tab-based UI for instant switching

### Use Cases

**Different roles**:
- Agent 1: Note organizer
- Agent 2: Research assistant
- Agent 3: Writing helper

**Different projects**:
- Agent 1: Work notes
- Agent 2: Personal journal
- Agent 3: Study notes

**Different capabilities**:
- Agent 1: Read-only (safe)
- Agent 2: Full access (trusted)

---

## Tips & Best Practices

### Getting Better Results

**Be specific**:
❌ "Organize my notes"
✅ "Move all meeting notes from 2025 to Archive/2025/Meetings"

**Use context**:
❌ "Read that note"
✅ "Read Daily Notes/2026-01-29.md"

**Provide examples**:
❌ "Create a project note"
✅ "Create a project note like project-template.md but for Project X"

### Security Best Practices

**Approve carefully**:
- Review what the agent plans to do
- Use `/vault` command explicitly
- Revoke approval between sessions

**Blocked folders**:
- `.obsidian` folder is always protected
- `.trash` folder is protected
- Configure additional blocks in settings

**Backup your vault**:
- Use Git for version control
- Regular backups before bulk operations
- Test with small vaults first

### Performance Tips

**Fast queries**:
- Use metadata-only for tags/links
- Search specific folders instead of whole vault
- Cache frequently accessed notes

**Efficient operations**:
- Batch operations when possible
- Use search before bulk modify
- Close unused agent connections

---

## Troubleshooting

### "Letta Code not found"

**Symptom**: Connection fails with "command not found"

**Solution**:
1. Verify installation: `letta --version`
2. Check PATH includes npm global bin
3. Restart terminal after installation
4. Reinstall: `npm install -g @letta-ai/letta-code`

### Connection Keeps Dropping

**Symptoms**: "Letta Code bridge closed" repeatedly

**Solutions**:
1. Check Letta Code logs for errors
2. Verify agent ID is correct
3. Ensure Letta server is running
4. Check system resources (CPU/memory)
5. Increase timeout in settings

### Tools Not Working

**Symptoms**: Agent says it called a tool but nothing happens

**Solutions**:
1. Check console for errors
2. Verify approval granted (for write operations)
3. Ensure files/folders exist
4. Check folder not blocked

### Slow Performance

**Symptoms**: Responses take > 5 seconds

**Solutions**:
1. Check local Letta server status
2. Verify model performance (local vs API)
3. Reduce vault size or use search
4. Clear message cache
5. Restart plugin

### Agent Doesn't Remember Context

**Symptoms**: Agent "forgets" previous messages

**Solutions**:
1. Check conversation length (> 200 messages)
2. Verify agent memory blocks configured
3. Use summary commands periodically
4. Check cache is enabled

---

## FAQ

### Q: Is my data safe?

**A**: Yes! In local mode:
- All data stays on your computer
- No cloud API calls
- Conversations stored locally
- Full control over your data

### Q: Can I use both cloud and local mode?

**A**: Yes! Switch between modes in settings. Your cloud agents and local agents are independent.

### Q: How many agents can I run?

**A**: No hard limit, but each agent uses system resources. Typically 2-3 agents is comfortable.

### Q: Do I need internet for local mode?

**A**: Not for the plugin, but:
- Letta server may need internet (for API models)
- Local models (e.g., LLaMA) work fully offline
- Plugin itself works offline

### Q: Can agents modify any file?

**A**: With approval, yes, except:
- Blocked folders (`.obsidian`, `.trash`)
- System files (outside vault)
- Requires explicit approval per session

### Q: What happens if Letta Code crashes?

**A**: The plugin detects crashes and can:
- Show error notice
- Attempt auto-reconnect
- Preserve conversation cache
- Resume after restart

### Q: Can I undo agent changes?

**A**: Yes, through:
- Obsidian's file history (if enabled)
- System trash (for deletions)
- Git version control (recommended)
- File backups

### Q: How do I update Letta Code?

**A**: Run:
```bash
npm update -g @letta-ai/letta-code
```

Then restart the plugin.

### Q: Can I create custom tools?

**A**: Not yet, but planned for future releases. Currently, 14 tools are available.

### Q: Does this work on mobile?

**A**: Desktop only. Mobile doesn't support Node.js/CLI tools.

---

## Getting Help

### Resources

**Documentation**:
- [README.md](./README.md) - Quick overview
- [TESTING-GUIDE.md](./TESTING-GUIDE.md) - Comprehensive testing
- [M4-COMPLETE.md](./M4-COMPLETE.md) - Technical details

**Support Channels**:
- Discord: [discord.gg/letta](https://discord.gg/letta)
- GitHub Issues: [github.com/letta-ai/letta-code/issues](https://github.com/letta-ai/letta-code/issues)
- Community Forum: Obsidian Community Plugins

### Reporting Issues

When reporting problems, include:
1. OS and Obsidian version
2. Letta Code version (`letta --version`)
3. Plugin version
4. Console logs (Developer Tools → Console)
5. Steps to reproduce

---

## What's Next?

### Upcoming Features

- **UI for agent switching**: Tab-based interface
- **Real memory integration**: Sync with Letta's memory API
- **Custom tools**: Create your own vault tools
- **Automation**: Scheduled tasks and triggers
- **Analytics**: Tool usage and performance stats

### Providing Feedback

Your feedback helps improve the plugin!

**What we'd love to hear**:
- Feature requests
- Use cases
- Performance issues
- UX improvements
- Documentation gaps

**How to provide feedback**:
- GitHub Issues (preferred)
- Discord #obsidian channel
- Direct message on community forum

---

## Conclusion

You now have a powerful local AI agent that can:
- Read and understand your vault
- Search and organize notes
- Create and modify content
- Manage files and folders
- Remember conversations
- Work completely offline

**Start small**: Try read-only operations first
**Build trust**: Approve writes carefully
**Explore**: Discover new workflows
**Share**: Help others learn

Welcome to the future of note-taking with AI! 🚀

---

**Document**: USER-GUIDE.md  
**Version**: 2.0.0  
**Date**: January 29, 2026  
**Plugin Version**: 2.0.0 (with Letta Code Integration)
