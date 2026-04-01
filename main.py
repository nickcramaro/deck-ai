import os
import asyncio
import subprocess
import json
import base64
import decky

SYSTEM_PROMPT = """You are Deck AI, a gaming assistant running on a Steam Deck. The user is currently playing a game and can send you screenshots of what they're seeing.

Your job:
- Help with gameplay questions: boss strategies, puzzle solutions, item locations, build advice, quest guidance
- When given a screenshot, analyze what's on screen: identify the game state, UI elements, enemies, items, objectives, map position — whatever is relevant to helping
- Search the web for up-to-date game info when needed (wikis, guides, patch notes, builds)
- Be concise — the user is reading on a small screen while gaming. Get to the point fast.
- Remember context within the session — if they said they're doing a stealth build, keep that in mind
- If you're not sure what game mechanic they're asking about, ask a quick clarifying question rather than guessing wrong

The user is playing: {game_name}
"""

SCREENSHOT_DIR = os.path.join(
    os.environ.get("DECKY_PLUGIN_RUNTIME_DIR", "/tmp/deck-ai"),
    "screenshots",
)


class Plugin:
    claude_proc: asyncio.subprocess.Process | None = None
    current_game: str | None = None
    current_app_id: int | None = None
    session_id: str | None = None
    session_active: bool = False
    first_message: bool = True

    # ── Claude session management ──────────────────────────────────

    async def start_session(self, game_name: str, app_id: int) -> bool:
        """Start a Claude Code session for the current game."""
        self.current_game = game_name
        self.current_app_id = app_id
        self.session_id = f"deck-ai-{app_id}-{int(asyncio.get_event_loop().time())}"
        self.session_active = True
        self.first_message = True

        os.makedirs(SCREENSHOT_DIR, exist_ok=True)

        decky.logger.info(f"Session started for {game_name} (app {app_id}), session {self.session_id}")
        return True

    async def end_session(self) -> bool:
        """End the current Claude session."""
        if self.claude_proc and self.claude_proc.returncode is None:
            self.claude_proc.terminate()
            try:
                await asyncio.wait_for(self.claude_proc.wait(), timeout=5)
            except asyncio.TimeoutError:
                self.claude_proc.kill()
            self.claude_proc = None

        self.session_active = False
        self.current_game = None
        self.current_app_id = None
        decky.logger.info("Session ended")
        return True

    async def ask(self, question: str, include_screenshot: bool = False) -> None:
        """Send a question to Claude. Streams response via 'response_chunk' events."""
        if not self.session_active:
            await decky.emit("response_error", "No active session. Start a game first.")
            return

        # Build the claude command
        cmd = ["claude", "-p", "--output-format", "stream-json"]

        # System prompt with game context (sent every time — claude -p is stateless per invocation)
        prompt = SYSTEM_PROMPT.format(game_name=self.current_game or "Unknown")
        cmd.extend(["--system-prompt", prompt])

        # Session continuity: --continue resumes prior conversation, --session-id scopes it
        if self.session_id:
            cmd.extend(["--session-id", self.session_id])
            if not self.first_message:
                cmd.append("--continue")

        # Screenshot handling
        screenshot_path = None
        if include_screenshot:
            screenshot_path = await self._capture_screenshot()
            if screenshot_path:
                cmd.extend(["--image", screenshot_path])

        # The question itself
        cmd.append(question)

        self.first_message = False

        # Spawn and stream
        self.loop.create_task(self._stream_response(cmd))

    async def _stream_response(self, cmd: list[str]) -> None:
        """Run claude subprocess and stream response chunks to the frontend."""
        try:
            await decky.emit("response_start")

            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                env={**os.environ, "TERM": "dumb"},
            )
            self.claude_proc = proc

            full_response = ""
            async for line in proc.stdout:
                decoded = line.decode("utf-8").strip()
                if not decoded:
                    continue

                try:
                    event = json.loads(decoded)
                except json.JSONDecodeError:
                    continue

                # stream-json emits {"type": "content", "content": "text"} among others
                if event.get("type") == "content":
                    chunk = event.get("content", "")
                    full_response += chunk
                    await decky.emit("response_chunk", chunk)
                elif event.get("type") == "result":
                    # Final result event
                    result_text = event.get("result", "")
                    if result_text and not full_response:
                        full_response = result_text
                        await decky.emit("response_chunk", result_text)

            await proc.wait()

            if proc.returncode != 0 and not full_response:
                stderr = ""
                if proc.stderr:
                    stderr = (await proc.stderr.read()).decode("utf-8")
                await decky.emit("response_error", f"Claude exited with code {proc.returncode}: {stderr[:500]}")
            else:
                await decky.emit("response_done")

        except Exception as e:
            decky.logger.error(f"Stream error: {e}")
            await decky.emit("response_error", str(e))
        finally:
            self.claude_proc = None

    # ── Screenshot capture ─────────────────────────────────────────

    async def capture_screenshot(self) -> str:
        """Capture a screenshot and return the path. Callable from frontend."""
        path = await self._capture_screenshot()
        return path or ""

    async def _capture_screenshot(self) -> str | None:
        """Capture the current game screen via grim on Gamescope."""
        os.makedirs(SCREENSHOT_DIR, exist_ok=True)

        filename = f"capture_{int(asyncio.get_event_loop().time())}.png"
        filepath = os.path.join(SCREENSHOT_DIR, filename)

        try:
            proc = await asyncio.create_subprocess_exec(
                "grim", "-o", filepath,
                env={**os.environ, "WAYLAND_DISPLAY": "gamescope-0"},
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
            await proc.wait()

            if proc.returncode == 0 and os.path.exists(filepath):
                decky.logger.info(f"Screenshot captured: {filepath}")
                return filepath
            else:
                stderr = (await proc.stderr.read()).decode("utf-8") if proc.stderr else ""
                decky.logger.error(f"grim failed: {stderr}")
                return None
        except FileNotFoundError:
            decky.logger.error("grim not found — install with: pacman -S grim")
            return None

    # ── Game info ──────────────────────────────────────────────────

    async def set_game(self, game_name: str, app_id: int) -> bool:
        """Called by frontend when game detection fires."""
        return await self.start_session(game_name, app_id)

    async def clear_game(self) -> bool:
        """Called by frontend when game exits."""
        return await self.end_session()

    async def get_status(self) -> dict:
        """Return current plugin state."""
        return {
            "session_active": self.session_active,
            "current_game": self.current_game,
            "current_app_id": self.current_app_id,
        }

    # ── Lifecycle ──────────────────────────────────────────────────

    async def _main(self):
        self.loop = asyncio.get_event_loop()
        os.makedirs(SCREENSHOT_DIR, exist_ok=True)
        decky.logger.info("Deck AI loaded")

    async def _unload(self):
        await self.end_session()
        decky.logger.info("Deck AI unloaded")

    async def _uninstall(self):
        decky.logger.info("Deck AI uninstalled")
