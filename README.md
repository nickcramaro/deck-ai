# Deck AI

AI gaming assistant for Steam Deck, powered by Claude Code. A [Decky Loader](https://decky.xyz/) plugin that puts Claude in your Quick Access Menu — ask questions, share screenshots, get help with any game.

## How It Works

1. **Start a game** — plugin auto-detects what you're playing
2. **Press `...`** — open the QAM, find the Deck AI panel
3. **Ask a question** — "How do I beat this boss?" / "Where's the next objective?"
4. **Attach a screenshot** — tap the camera button to capture what's on screen
5. **Get help** — Claude analyzes your question (and screenshot), searches the web if needed, and responds

Each game session maintains conversation history, so Claude remembers context like your build, progress, and prior questions.

## Architecture

```
[QAM Panel (React)] → callable → [Python Backend] → claude -p → [Claude Code CLI]
                                        ↓
                                  [grim screenshot]
```

- **Frontend**: React/TypeScript panel in the Quick Access Menu (via `@decky/ui`)
- **Backend**: Python — spawns `claude` CLI subprocess, captures screenshots with `grim`
- **Streaming**: Claude's response streams back to the UI via `decky.emit` events
- **Session continuity**: `--continue --session-id` keeps conversation context within a game session

## Prerequisites

- [Decky Loader](https://github.com/SteamDeckHomebrew/decky-loader) installed on your Steam Deck
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude` CLI available in PATH)
- `grim` installed for screenshot capture (`sudo pacman -S grim`)

## Development

```bash
# Install dependencies
pnpm install

# Build
pnpm run build

# Watch mode
pnpm run watch
```

### Sideloading

1. Build the plugin
2. Copy the plugin directory to `~/homebrew/plugins/deck-ai/` on your Steam Deck
3. Restart Decky Loader

## Project Structure

```
deck-ai/
  plugin.json        # Decky plugin metadata
  package.json       # Node dependencies
  main.py            # Python backend (claude subprocess, grim, game detection)
  src/
    index.tsx        # React QAM panel (chat UI, screenshot button)
  rollup.config.js   # Build config
  tsconfig.json
```
