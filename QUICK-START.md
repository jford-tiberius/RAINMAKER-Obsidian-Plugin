# Quick Start - Release v2.0.0 to GitHub for BRAT

## Step 1: Commit Source Code
Run this in Command Prompt or Git Bash:
```cmd
commit-and-sync.bat
```

This will:
- Stage all changes (letta-code folder + main.ts changes)
- Create commit with full changelog
- Push to GitHub
- Create v2.0.0 tag
- Push tag to GitHub

## Step 2: Build the Plugin
Run this:
```cmd
build-release.bat
```

This will:
- Install dependencies
- Build the plugin with `npm run build`
- Verify main.js, styles.css, manifest.json exist

## Step 3: Commit Built Files
Run this:
```cmd
commit-built-files.bat
```

This will:
- Stage the built files (main.js, styles.css, manifest.json)
- Commit them
- Push to GitHub

## Step 4: Install via BRAT in Obsidian

1. Open **Obsidian**
2. Go to **Settings** → **Community Plugins**
3. Make sure **BRAT** is installed (if not, install it)
4. Click **BRAT** settings
5. Click **"Add Beta Plugin"**
6. Enter your repository URL (e.g., `username/RAINMAKER-Obsidian-Plugin`)
7. BRAT will install directly from your main branch
8. Enable the plugin

## One-Liner (All Steps)

If you prefer, run all at once:
```cmd
commit-and-sync.bat && build-release.bat && commit-built-files.bat
```

## Verify Installation

After BRAT installs:
1. Check Settings → Rainmaker Obsidian
2. Verify **Engine Mode** dropdown exists
3. Try switching to "Letta Code (Local CLI)"
4. Test connection (if you have Letta Code installed)

## Alternative: Manual Install

If BRAT doesn't work, manual install:
1. Copy `main.js`, `styles.css`, `manifest.json` to:
   ```
   <your-vault>/.obsidian/plugins/rainmaker-obsidian/
   ```
2. Reload Obsidian
3. Enable plugin in Settings

## Troubleshooting

**"Git not found"**:
- Make sure Git is installed
- Run scripts in Git Bash instead of cmd

**"npm not found"**:
- Install Node.js: https://nodejs.org
- Restart terminal

**"Build failed"**:
- Check `npm install` ran successfully
- Check for TypeScript errors
- Look at console output

**"BRAT can't find plugin"**:
- Verify repository is public
- Check manifest.json has correct version (2.0.0)
- Ensure built files are in root of repo (not subfolder)

## What's in Each Commit

**Commit 1** (Source Code):
- letta-code/ folder (12 new files)
- main.ts modifications
- Full v2.0.0 implementation

**Commit 2** (Built Files):
- main.js (compiled plugin)
- styles.css (unchanged)
- manifest.json (v2.0.0)

## Repository Structure for BRAT

```
RAINMAKER-Obsidian-Plugin/
├── main.js          ← Required for BRAT
├── styles.css       ← Required for BRAT
├── manifest.json    ← Required for BRAT
├── main.ts          ← Source code
├── letta-code/      ← New integration code
│   ├── types.ts
│   ├── bridge.ts
│   ├── tools.ts
│   └── *.md         ← Documentation
└── ...
```

## Success!

Once all steps complete:
- ✅ Source code on GitHub
- ✅ v2.0.0 tag created
- ✅ Plugin built
- ✅ Built files committed
- ✅ BRAT can install from repo
- ✅ Ready to use!

---

**Version**: 2.0.0  
**Date**: January 29, 2026  
**Status**: Ready for BRAT Installation
