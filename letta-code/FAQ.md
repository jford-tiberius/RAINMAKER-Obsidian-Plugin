# Letta Code Integration - FAQ & Troubleshooting

**Version**: 2.0.0  
**Last Updated**: January 29, 2026

---

## Frequently Asked Questions

### General Questions

#### Q1: What's the difference between Cloud and Local mode?

**Cloud Mode**:
- Connects to Letta Cloud API over internet
- Data sent to remote servers
- Requires API key
- Standard Letta features

**Local Mode (Letta Code)**:
- Runs entirely on your computer
- All data stays local
- No internet required (for local models)
- Enhanced vault integration
- Better performance

#### Q2: Do I need both modes?

No! You can use either:
- **Cloud only**: Original plugin behavior
- **Local only**: New Letta Code integration
- **Both**: Switch between modes as needed

#### Q3: Is Local mode more secure?

Yes, because:
- Your notes never leave your computer
- Conversations stored locally
- No cloud API calls
- Full control over your data

However, cloud mode is also secure (encrypted connections, trusted provider).

#### Q4: Does Local mode cost money?

Depends on your setup:
- **Local models** (LLaMA, Mistral, etc.): Free, run on your machine
- **API models** (GPT-4, Claude): Same cost as cloud mode
- **Plugin**: Free and open source

#### Q5: Can I use multiple agents?

Yes! In local mode:
- Create multiple agents in Letta Code
- Connect to each via Settings → Agent ID
- Switch between agents as needed
- Each has independent conversations

---

### Installation & Setup

#### Q6: "Letta Code not found" error - what do I do?

**Check installation**:
```bash
letta --version
```

If not found:
```bash
npm install -g @letta-ai/letta-code
```

**Still not working?**
1. Restart terminal
2. Check PATH includes npm global bin
3. On Windows, may need administrator privileges

#### Q7: How do I find my Agent ID?

**Method 1 - Letta Code CLI**:
```bash
letta
# Select your agent
# Agent ID displayed in prompt or config
```

**Method 2 - Letta Config**:
Look in `~/.letta/config` or Letta's configuration files

#### Q8: Can I use the same agent in both modes?

No - cloud agents and local agents are separate:
- Cloud agents: Managed by Letta Cloud
- Local agents: Managed by Letta Code

Create separate agents for each mode.

#### Q9: Do I need a Letta account for Local mode?

No! Local mode runs entirely on your machine. You only need:
- Node.js installed
- Letta Code installed
- An agent created locally

---

### Usage Questions

#### Q10: How do I approve vault tools?

**Option 1 - /vault command**:
```
/vault help
```
Grants approval for current session.

**Option 2 - Settings**:
Settings → Rainmaker Obsidian → Enable vault tools

**Note**: Approval resets when you close Obsidian (for security).

#### Q11: Can the agent delete my notes?

Only with approval:
1. You must use `/vault` command first
2. Agent requests delete operation
3. By default, files move to trash (recoverable)
4. Permanent delete requires explicit parameters

**Safety tips**:
- Backup your vault
- Use Git for version control
- Test with sample vault first

#### Q12: How many files can the agent search?

- **Search**: Scans entire vault (thousands of files possible)
- **List files**: Default limit is 50 (configurable up to 500)
- **Read operations**: No limit

Large vaults (> 1000 files) may take longer to search.

#### Q13: Can I undo agent changes?

Yes, several ways:
1. **Obsidian File History**: If enabled in Obsidian settings
2. **System Trash**: For deleted files
3. **Git**: If using version control (recommended!)
4. **Backups**: Regular vault backups

#### Q14: What folders are protected?

By default:
- `.obsidian` (plugin settings)
- `.trash` (deleted files)

You can add more blocked folders in settings.

---

### Performance Questions

#### Q15: Why are responses slow?

**Possible causes**:
1. **Large vault**: Search takes longer
2. **Model choice**: Some models slower than others
3. **Local resources**: CPU/RAM limitations
4. **Network**: If using API models

**Solutions**:
- Search specific folders instead of whole vault
- Use faster models
- Upgrade hardware for local models
- Check Letta Code logs for bottlenecks

#### Q16: Does caching improve performance?

Yes! The plugin caches:
- Last 200 messages per agent
- Conversation history
- Agent metadata

**Benefits**:
- Faster conversation loading
- Resume after disconnect
- Reduced Letta Code queries

**Clear cache**:
Settings → Clear conversation cache

#### Q17: Can I run Local mode on a potato computer?

Depends on your model choice:
- **API models** (GPT-4): Yes! API does the heavy lifting
- **Local models**: Need decent specs (8GB+ RAM, modern CPU)

For weak hardware, use API models via Local mode.

---

### Troubleshooting

#### Q18: Connection keeps dropping

**Symptoms**: "Letta Code bridge closed" repeatedly

**Possible causes**:
1. Letta Code process crashing
2. Incorrect agent ID
3. Resource constraints
4. Letta server issues

**Solutions**:
```bash
# Check Letta Code logs
letta --debug

# Verify agent exists
letta --list-agents

# Test Letta Code manually
letta --agent <your-agent-id>
```

#### Q19: Tools execute but nothing happens

**Symptoms**: Agent says tool succeeded but vault unchanged

**Check**:
1. **Console errors**: Open Developer Tools → Console
2. **Approval**: Is vault write approved?
3. **File exists**: Does target file/folder exist?
4. **Blocked folder**: Is target in blocked list?

**Debug**:
- Check console for `[BridgeTools] Executing tool:`
- Look for error messages
- Verify tool result sent back to agent

#### Q20: "Access denied: restricted folder" error

**Cause**: Trying to access blocked folder (`.obsidian`, `.trash`, etc.)

**Solution**: This is intentional protection! Don't modify:
- `.obsidian` - Plugin/Obsidian settings
- `.trash` - Deleted files

To access other folders, remove from blocked list in settings (not recommended).

#### Q21: Agent seems to "forget" things

**Possible causes**:
1. **Long conversation**: > 200 messages (cache limit)
2. **Memory blocks**: Not configured properly
3. **Agent restart**: Lost context

**Solutions**:
- Summarize long conversations periodically
- Use memory blocks to store important info
- Check agent's memory configuration in Letta Code

#### Q22: Process crashes on startup

**Symptoms**: "Failed to start Letta Code" error

**Check**:
1. **Letta Code works standalone**: Run `letta` manually
2. **Port conflicts**: Is port already in use?
3. **Permissions**: Can plugin spawn subprocesses?
4. **Agent configuration**: Is agent configured correctly?

**Debug**:
```bash
# Test Letta Code directly
letta --headless --output json --agent <your-agent-id>

# Should output JSON without errors
```

---

### Advanced Questions

#### Q23: Can I create custom tools?

**Current**: No, limited to built-in 14 tools

**Future**: Planned for v2.1.0+
- Custom tool API
- JavaScript-based tools
- Community tool marketplace

**Workaround**: Request custom tools on GitHub

#### Q24: How does multi-agent mode work?

**Architecture**:
```
Plugin
├── Bridge 1 (Agent A)
├── Bridge 2 (Agent B)
└── Bridge 3 (Agent C)
```

Each bridge:
- Independent subprocess
- Separate conversation
- Own tool context
- Cached messages

**Switching**: Change Agent ID in settings, click Connect

#### Q25: Can I share agents with others?

**Agent configuration**: Yes, export from Letta Code
**Conversation history**: No, stored locally per installation
**Memory blocks**: Yes, via Letta Code export

**Share**:
1. Export agent config from Letta Code
2. Share config file
3. Others import into their Letta Code
4. Connect plugin to imported agent

#### Q26: What's the difference between modify operations?

**Append**:
- Adds content to end of file
- Preserves existing content
- Use for: Adding items to lists

**Prepend**:
- Adds content to start of file
- Preserves existing content
- Use for: Adding headers, dates

**Replace Section**:
- Finds heading (e.g., `## Tasks`)
- Replaces content after heading
- Stops at next heading
- Use for: Updating specific sections

#### Q27: Can I automate tasks?

**Current**: No built-in automation

**Workarounds**:
- Use Obsidian templates
- Periodic commands via chat
- Manual triggers

**Future**: Planned features:
- Scheduled tasks
- Trigger-based actions
- Automation API

---

### Security & Privacy

#### Q28: What data does the plugin collect?

**Local mode**: Nothing! All data stays on your machine.

**Cloud mode**: Data sent to Letta Cloud:
- Conversation messages
- Agent configurations
- Tool call results

**Plugin itself**:
- No telemetry
- No analytics
- No external connections (except Letta)

#### Q29: Can others see my Letta Code conversations?

No! Local mode conversations are:
- Stored on your machine only
- In your Obsidian vault or Letta Code directory
- Not synchronized anywhere
- Private to you

#### Q30: Is it safe to let the agent modify files?

**Safety measures**:
1. **Approval required**: Can't write without permission
2. **Blocked folders**: Critical folders protected
3. **Trash option**: Deletes recoverable
4. **Audit trail**: All operations logged

**Best practices**:
- Backup vault regularly
- Use Git for version control
- Review agent actions
- Test on sample vault first
- Revoke approval when done

---

## Common Error Messages

### "Letta Code not found"

**Meaning**: Plugin can't find `letta` executable

**Fix**: Install Letta Code:
```bash
npm install -g @letta-ai/letta-code
```

### "Bridge not connected"

**Meaning**: Lost connection to Letta Code process

**Fix**:
1. Check Letta Code is running
2. Click "Connect to Letta" again
3. Restart Obsidian if needed

### "Access denied: [folder] is a restricted folder"

**Meaning**: Trying to access protected folder

**Fix**: Don't access `.obsidian`, `.trash`, etc. If you need access, remove from blocked list (not recommended).

### "Tool execution requires user approval"

**Meaning**: Write operation without approval

**Fix**: Use `/vault` command first to grant approval

### "File not found: [path]"

**Meaning**: Agent tried to access non-existent file

**Fix**:
1. Check file exists
2. Verify path is correct (case-sensitive!)
3. Use list/search to find actual path

### "Agent not connected"

**Meaning**: No active agent connection

**Fix**:
1. Settings → Enter Agent ID
2. Click "Connect to Letta"
3. Ensure Letta Code installed

---

## Performance Optimization

### Tip 1: Use Specific Searches

❌ "Search my entire vault"
✅ "Search in Projects folder"

Limits scope, faster results.

### Tip 2: Get Metadata Only

❌ "Read all files to find tags"
✅ "Get metadata for files" (faster, no content read)

### Tip 3: Close Unused Agents

If running multiple agents, close inactive ones:
- Frees system resources
- Improves performance
- Reduces memory usage

### Tip 4: Clear Cache Periodically

Settings → Clear conversation cache

Frees memory, especially after long conversations.

### Tip 5: Use Faster Models

For local models:
- Smaller models = faster
- Quantized models = less RAM
- Consider API models for weak hardware

---

## Still Having Issues?

### Check Logs

**Plugin Console**:
1. Open Developer Tools (Ctrl+Shift+I)
2. Console tab
3. Look for `[Letta Plugin]` and `[LettaCodeBridge]` messages

**Letta Code Logs**:
```bash
letta --debug --agent <your-agent-id>
```

### Get Help

**Discord**: [discord.gg/letta](https://discord.gg/letta)
- #obsidian channel
- Community support
- Real-time help

**GitHub Issues**: [github.com/letta-ai/letta-code/issues](https://github.com/letta-ai/letta-code/issues)
- Bug reports
- Feature requests
- Technical discussions

**Obsidian Forum**:
- Community Plugins section
- User experiences
- Tips and tricks

---

## Glossary

**Agent**: AI assistant with memory and context
**Bridge**: Communication layer between plugin and Letta Code
**Local Mode**: Running Letta Code on your machine
**Cloud Mode**: Using Letta Cloud API
**Tool**: Function agent can call (read, write, search, etc.)
**Vault**: Your Obsidian notes folder
**Subprocess**: Background process running Letta Code
**Cache**: Stored conversation history for fast loading
**Memory Block**: Persistent storage for agent context

---

**Document**: FAQ.md  
**Version**: 2.0.0  
**Date**: January 29, 2026  
**For**: Rainmaker Obsidian Plugin 2.0.0+
