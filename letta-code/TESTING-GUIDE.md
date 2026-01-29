# Letta Code Integration - Comprehensive Testing Guide

**Version**: 1.0  
**Last Updated**: January 29, 2026  
**Milestone**: M4 Complete

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Test Environment Setup](#test-environment-setup)
3. [Test Categories](#test-categories)
4. [Test Procedures](#test-procedures)
5. [Expected Results](#expected-results)
6. [Troubleshooting](#troubleshooting)
7. [Test Checklist](#test-checklist)

---

## Prerequisites

### Required Software

1. **Letta Code CLI**:
   ```bash
   npm install -g @letta-ai/letta-code
   letta --version  # Verify installation
   ```

2. **Obsidian**:
   - Version 1.4.0 or later
   - Test vault with sample notes

3. **Plugin Build**:
   ```bash
   cd RAINMAKER-Obsidian-Plugin
   npm run build
   ```

### Required Configuration

1. **Agent Setup**:
   ```bash
   letta  # Interactive setup
   # Create/select an agent
   # Note the agent ID
   ```

2. **Plugin Settings**:
   - Engine Mode: "Letta Code (Local CLI)"
   - Agent ID: (your agent ID)
   - Auto Connect: Optional

---

## Test Environment Setup

### Create Test Vault Structure

```
test-vault/
├── Daily Notes/
│   ├── 2026-01-29.md
│   └── 2026-01-28.md
├── Projects/
│   ├── project-a.md
│   └── project-b.md
├── Templates/
│   └── meeting-template.md
├── Archive/
│   └── old-note.md
└── test-note.md
```

### Sample Note Content

**Daily Notes/2026-01-29.md**:
```markdown
---
tags: [daily, journal]
date: 2026-01-29
---

# Daily Note - January 29, 2026

## Tasks
- [ ] Test Letta Code integration
- [ ] Review pull requests

## Notes
Testing the new bridge functionality.
```

---

## Test Categories

### Category 1: Connection & Setup
- [ ] 1.1 Initial connection
- [ ] 1.2 Connection retry on failure
- [ ] 1.3 Reconnection after disconnect
- [ ] 1.4 Mode switching (cloud ↔ local)
- [ ] 1.5 Multi-agent connection
- [ ] 1.6 Graceful cleanup on unload

### Category 2: Message Flow
- [ ] 2.1 Send simple text message
- [ ] 2.2 Send message with attachments
- [ ] 2.3 Receive streaming response
- [ ] 2.4 Multi-turn conversation
- [ ] 2.5 Message completion detection
- [ ] 2.6 Abort message mid-stream
- [ ] 2.7 Message caching

### Category 3: Vault Tools - Read Operations
- [ ] 3.1 Read file with metadata
- [ ] 3.2 Read file without metadata
- [ ] 3.3 Search vault by name
- [ ] 3.4 Search vault by content
- [ ] 3.5 Search vault by tags
- [ ] 3.6 List files (non-recursive)
- [ ] 3.7 List files (recursive)
- [ ] 3.8 Get metadata only

### Category 4: Vault Tools - Write Operations
- [ ] 4.1 Write new note
- [ ] 4.2 Overwrite existing note
- [ ] 4.3 Append to file
- [ ] 4.4 Prepend to file
- [ ] 4.5 Replace section in file
- [ ] 4.6 Write without approval (should fail)

### Category 5: Vault Tools - File Management
- [ ] 5.1 Delete file (to trash)
- [ ] 5.2 Delete file (permanent)
- [ ] 5.3 Rename file
- [ ] 5.4 Move file to folder
- [ ] 5.5 Copy file
- [ ] 5.6 Create folder
- [ ] 5.7 Create nested folders

### Category 6: Security & Permissions
- [ ] 6.1 Blocked folder access denied
- [ ] 6.2 Write approval enforcement
- [ ] 6.3 Filename sanitization
- [ ] 6.4 Folder creation validation

### Category 7: Memory Blocks
- [ ] 7.1 List memory blocks
- [ ] 7.2 Read memory block
- [ ] 7.3 Update memory block

### Category 8: Multi-Agent
- [ ] 8.1 Connect to multiple agents
- [ ] 8.2 Switch between agents
- [ ] 8.3 Independent conversations
- [ ] 8.4 Separate tool contexts

### Category 9: Error Handling
- [ ] 9.1 File not found errors
- [ ] 9.2 Permission denied errors
- [ ] 9.3 Invalid arguments errors
- [ ] 9.4 Process crash recovery
- [ ] 9.5 Network errors (if applicable)

### Category 10: Performance
- [ ] 10.1 Message latency < 2s
- [ ] 10.2 Tool execution < 1s
- [ ] 10.3 Cache hit performance
- [ ] 10.4 Large file handling
- [ ] 10.5 Many files search

---

## Test Procedures

### 1. Connection Tests

#### Test 1.1: Initial Connection

**Steps**:
1. Open Obsidian
2. Settings → Rainmaker Obsidian
3. Engine Mode → "Letta Code (Local CLI)"
4. Enter agent ID
5. Click "Connect to Letta"

**Expected**:
- Console: `[LettaCodeBridge] Starting Letta Code...`
- Console: `[Letta Plugin] Letta Code bridge ready`
- Notice: "Connected to Letta Code"
- Status bar: "Connected (Local)"

**Pass Criteria**: All expected outputs present, no errors

---

#### Test 1.5: Multi-Agent Connection

**Steps**:
1. Connect to first agent (agent-1)
2. Change agent ID to agent-2
3. Click "Connect to Letta"
4. Verify both bridges active

**Expected**:
- Two bridges in `plugin.bridges` map
- Console shows both agents
- Can switch between them

**Pass Criteria**: Both agents connected independently

---

### 2. Message Flow Tests

#### Test 2.1: Send Simple Message

**Steps**:
1. Connect to agent
2. Open chat view
3. Type: "Hello, can you hear me?"
4. Press Enter

**Expected**:
- Message appears in chat (blue bubble)
- Console: `[Letta Plugin] Sending message via bridge`
- Console: `[LettaCodeBridge] Sending message`
- Typing indicator shows
- Response appears (gray bubble)
- Typing indicator disappears

**Pass Criteria**: Complete message round-trip

---

#### Test 2.7: Message Caching

**Steps**:
1. Send 5 messages
2. Close chat view
3. Reopen chat view
4. Check if messages preserved

**Expected**:
- Last 200 messages cached per agent
- Cache accessible via `bridge.getCachedMessages()`
- Fast conversation reload

**Pass Criteria**: Cache retains recent messages

---

### 3. Vault Tools Tests

#### Test 3.1: Read File with Metadata

**Steps**:
1. Agent prompt: "Read Daily Notes/2026-01-29.md with full metadata"
2. Wait for response

**Expected**:
- Console: `[BridgeTools] Executing tool: obsidian_read_file`
- Tool returns: content, frontmatter, tags, headings, links
- Agent summarizes file contents

**Pass Criteria**: Complete file data returned

---

#### Test 4.5: Replace Section

**Steps**:
1. Create note with sections: `## Tasks` and `## Notes`
2. Agent prompt: "In test-note.md, replace the Tasks section with 'New task list'"
3. Verify result

**Expected**:
- Console: `[BridgeTools] Executing tool: obsidian_modify_file`
- Operation: `replace_section`
- Section heading: `## Tasks`
- Content under ## Tasks replaced
- Other sections unchanged

**Pass Criteria**: Section replaced correctly

---

#### Test 5.7: Create Nested Folders

**Steps**:
1. Agent prompt: "Create folder Projects/2026/Q1"
2. Check vault structure

**Expected**:
- Console: `[BridgeTools] Executing tool: obsidian_create_folder`
- All folders created: Projects → 2026 → Q1
- No errors if parent exists

**Pass Criteria**: Nested structure created

---

### 6. Security Tests

#### Test 6.1: Blocked Folder Access

**Steps**:
1. Agent prompt: "Read .obsidian/config.json"
2. Observe result

**Expected**:
- Tool returns error: "Access denied: .obsidian is a restricted folder"
- No file read occurs
- Agent acknowledges restriction

**Pass Criteria**: Access properly denied

---

#### Test 6.2: Write Approval

**Steps**:
1. Fresh session (no approval)
2. Agent prompt: "Create a new note"
3. Observe result

**Expected**:
- Tool returns error: "Requires approval"
- Notice: "Agent wants to write a file..."
- Agent explains approval needed

**Pass Criteria**: Write blocked without approval

---

### 9. Error Handling Tests

#### Test 9.4: Process Crash Recovery

**Steps**:
1. Connect to agent
2. Kill Letta Code process manually:
   ```bash
   tasklist | findstr letta
   taskkill /F /PID <pid>
   ```
3. Try sending message
4. Observe recovery

**Expected**:
- Console: `[Letta Plugin] Letta Code bridge closed`
- Status: "Disconnected"
- Next message triggers reconnect
- Conversation resumes

**Pass Criteria**: Auto-recovery successful

---

### 10. Performance Tests

#### Test 10.1: Message Latency

**Steps**:
1. Send message: "Quick response test"
2. Measure time to first response token
3. Record total response time

**Expected**:
- First token: < 2 seconds
- Full response: < 10 seconds (varies by model)

**Pass Criteria**: Response times acceptable

---

#### Test 10.4: Large File Handling

**Steps**:
1. Create note with 10,000 lines
2. Agent prompt: "Read large-file.md"
3. Observe performance

**Expected**:
- Tool execution: < 2 seconds
- No memory errors
- Complete content returned

**Pass Criteria**: Large files handled gracefully

---

## Expected Results

### Success Indicators

**Connection**:
- ✅ Bridge connects on first attempt
- ✅ Process spawned with correct arguments
- ✅ Heartbeat maintains connection

**Messaging**:
- ✅ Messages send without errors
- ✅ Responses stream in real-time
- ✅ Completion detected properly

**Tools**:
- ✅ All 14 tools registered
- ✅ Tool calls execute correctly
- ✅ Results return to agent

**Security**:
- ✅ Blocked folders protected
- ✅ Write approval enforced
- ✅ Safe filename handling

**Performance**:
- ✅ Latency < 2s for simple queries
- ✅ Tool execution < 1s
- ✅ Cache improves load times

---

## Troubleshooting

### Issue: "Letta Code not found"

**Symptoms**: Process fails to spawn

**Solutions**:
1. Verify installation: `letta --version`
2. Check PATH includes npm global bin
3. Reinstall: `npm install -g @letta-ai/letta-code`

---

### Issue: Bridge disconnects frequently

**Symptoms**: "Letta Code bridge closed" in console

**Solutions**:
1. Check Letta Code logs for errors
2. Verify agent ID is correct
3. Increase process timeout
4. Check system resources (CPU/memory)

---

### Issue: Tools not executing

**Symptoms**: Tool calls logged but no results

**Solutions**:
1. Verify tool registry initialized
2. Check for console errors in tool execution
3. Ensure bridge is connected
4. Verify `sendToolReturn()` is called

---

### Issue: Slow performance

**Symptoms**: Response times > 5 seconds

**Solutions**:
1. Check local Letta server status
2. Verify cache is working
3. Profile tool execution times
4. Check for memory leaks

---

## Test Checklist

### Pre-Testing

- [ ] Letta Code installed and working
- [ ] Test vault created with sample data
- [ ] Plugin built (npm run build)
- [ ] Agent configured with ID
- [ ] Settings configured for local mode

### Core Functionality

- [ ] Connection established successfully
- [ ] Messages send and receive
- [ ] Streaming works correctly
- [ ] Multi-turn conversations work
- [ ] Tool calls execute properly

### All 14 Tools Tested

**Read Operations**:
- [ ] obsidian_read_file
- [ ] obsidian_search_vault
- [ ] obsidian_list_files
- [ ] obsidian_get_metadata

**Write Operations**:
- [ ] write_obsidian_note
- [ ] obsidian_modify_file (3 operations)

**File Management**:
- [ ] obsidian_delete_file
- [ ] obsidian_rename
- [ ] obsidian_move
- [ ] obsidian_copy_file

**Folders**:
- [ ] obsidian_create_folder

**Memory**:
- [ ] list_memory_blocks
- [ ] read_memory_block
- [ ] update_memory_block

### Security

- [ ] Blocked folders protected
- [ ] Write approval enforced
- [ ] Filenames sanitized
- [ ] Errors handled gracefully

### Advanced Features

- [ ] Multi-agent support working
- [ ] Message caching functional
- [ ] Agent switching works
- [ ] Memory blocks accessible

### Performance

- [ ] Message latency acceptable
- [ ] Tool execution fast
- [ ] Large files handled
- [ ] No memory leaks

### Cross-Platform (if applicable)

- [ ] Windows tested
- [ ] Mac tested
- [ ] Linux tested

---

## Reporting Issues

When reporting issues, include:

1. **System Info**:
   - OS and version
   - Obsidian version
   - Plugin version
   - Letta Code version

2. **Console Logs**:
   - Full error messages
   - Stack traces
   - Bridge debug logs

3. **Steps to Reproduce**:
   - Exact steps taken
   - Expected vs actual behavior
   - Frequency (always/sometimes/rare)

4. **Context**:
   - Agent configuration
   - Vault size/structure
   - Other plugins active

---

## Test Results Template

```markdown
## Test Session: [Date]

**Tester**: [Name]
**Environment**: [OS, Obsidian version, Letta Code version]
**Test Duration**: [Time]

### Categories Tested
- [ ] Connection & Setup
- [ ] Message Flow
- [ ] Vault Tools - Read
- [ ] Vault Tools - Write
- [ ] Vault Tools - File Management
- [ ] Security & Permissions
- [ ] Memory Blocks
- [ ] Multi-Agent
- [ ] Error Handling
- [ ] Performance

### Results Summary
- Tests Passed: [X/Y]
- Tests Failed: [Z]
- Critical Issues: [N]
- Minor Issues: [M]

### Issues Found
1. [Issue description]
   - Severity: [Critical/High/Medium/Low]
   - Steps to reproduce: [...]
   - Expected: [...]
   - Actual: [...]

### Notes
[Additional observations]
```

---

## Conclusion

This comprehensive testing guide covers all aspects of the Letta Code integration. Complete all test categories to ensure a production-ready implementation.

**Next**: After testing, proceed to M5 (Polish & Release) for final improvements and documentation.
