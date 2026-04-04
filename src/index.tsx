import {
  ButtonItem,
  PanelSection,
  PanelSectionRow,
  staticClasses,
  TextField,
} from "@decky/ui";
import {
  addEventListener,
  removeEventListener,
  callable,
  definePlugin,
  toaster,
} from "@decky/api";
import { useState, useEffect, useRef, useCallback, type FC } from "react";
import { FaRobot, FaCamera, FaPaperPlane } from "react-icons/fa";

// ── Backend callables ────────────────────────────────────────────

const askClaude = callable<[question: string, include_screenshot: boolean], void>("ask");
const setGame = callable<[game_name: string, app_id: number], boolean>("set_game");
const clearGame = callable<[], boolean>("clear_game");
const getStatus = callable<[], { session_active: boolean; current_game: string | null; current_app_id: number | null }>("get_status");
// ── Types ────────────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant" | "error";
  content: string;
  hasScreenshot?: boolean;
}

// ── Chat Panel ───────────────────────────────────────────────────

const ChatPanel: FC = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [currentGame, setCurrentGame] = useState<string | null>(null);
  const [attachScreenshot, setAttachScreenshot] = useState(false);
  const streamBuffer = useRef("");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Fetch initial status
  useEffect(() => {
    getStatus().then((status) => {
      if (status.current_game) {
        setCurrentGame(status.current_game);
      }
    });
  }, []);

  // Listen for streaming response events from Python backend
  useEffect(() => {
    const onStart = addEventListener("response_start", () => {
      streamBuffer.current = "";
      setIsLoading(true);
      setMessages((prev) => [...prev, { role: "assistant", content: "" }]);
    });

    const onChunk = addEventListener<[chunk: string]>("response_chunk", (chunk: string) => {
      streamBuffer.current += chunk;
      const text = streamBuffer.current;
      setMessages((prev) => {
        const updated = [...prev];
        const last = updated[updated.length - 1];
        if (last && last.role === "assistant") {
          updated[updated.length - 1] = { ...last, content: text };
        }
        return updated;
      });
    });

    const onDone = addEventListener("response_done", () => {
      setIsLoading(false);
      streamBuffer.current = "";
    });

    const onError = addEventListener<[error: string]>("response_error", (error: string) => {
      setIsLoading(false);
      streamBuffer.current = "";
      setMessages((prev) => [...prev, { role: "error", content: error }]);
    });

    return () => {
      removeEventListener("response_start", onStart);
      removeEventListener("response_chunk", onChunk);
      removeEventListener("response_done", onDone);
      removeEventListener("response_error", onError);
    };
  }, []);

  // Listen for game lifecycle events from Steam
  useEffect(() => {
    const registerGameDetection = () => {
      try {
        // @ts-ignore — SteamClient is a global provided by Steam
        const reg = SteamClient.GameSessions.RegisterForAppLifetimeNotifications(
          (info: { unAppID: number; nInstanceID: number; bRunning: boolean }) => {
            if (info.bRunning) {
              // @ts-ignore
              const appDetails = appStore.GetAppOverviewByAppID(info.unAppID);
              const gameName = appDetails?.display_name || `App ${info.unAppID}`;
              setCurrentGame(gameName);
              setGame(gameName, info.unAppID);
              setMessages([]);
              toaster.toast({
                title: "Deck AI",
                body: `Ready to help with ${gameName}`,
              });
            } else {
              setCurrentGame(null);
              clearGame();
            }
          },
        );
        return reg;
      } catch (e) {
        console.error("Failed to register game detection:", e);
        return null;
      }
    };

    const reg = registerGameDetection();
    return () => {
      if (reg?.unregister) reg.unregister();
    };
  }, []);

  const handleSend = useCallback(async () => {
    const question = input.trim();
    if (!question || isLoading) return;

    setMessages((prev) => [
      ...prev,
      { role: "user", content: question, hasScreenshot: attachScreenshot },
    ]);
    setInput("");

    const withScreenshot = attachScreenshot;
    setAttachScreenshot(false);

    await askClaude(question, withScreenshot);
  }, [input, isLoading, attachScreenshot]);

  return (
    <div>
      {/* Game status */}
      <PanelSection title={currentGame ? `Playing: ${currentGame}` : "No game detected"}>
        {!currentGame && (
          <PanelSectionRow>
            <span style={{ fontSize: "12px", color: "#8b8b8b" }}>
              Start a game and Deck AI will be ready to help.
            </span>
          </PanelSectionRow>
        )}
      </PanelSection>

      {/* Chat messages */}
      <PanelSection title="Chat">
        <div
          style={{
            maxHeight: "300px",
            overflowY: "auto",
            padding: "4px",
          }}
        >
          {messages.length === 0 && (
            <div style={{ fontSize: "12px", color: "#8b8b8b", padding: "8px 0" }}>
              Ask me anything about your game. Tap the camera to include a screenshot.
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              style={{
                padding: "6px 8px",
                marginBottom: "4px",
                borderRadius: "4px",
                backgroundColor:
                  msg.role === "user"
                    ? "#1a4a7a"
                    : msg.role === "error"
                      ? "#7a1a1a"
                      : "#2a2a2a",
                fontSize: "13px",
                lineHeight: "1.4",
                wordBreak: "break-word",
              }}
            >
              {msg.role === "user" && (
                <div style={{ fontSize: "11px", color: "#6ba3d6", marginBottom: "2px" }}>
                  You {msg.hasScreenshot ? "(+ screenshot)" : ""}
                </div>
              )}
              {msg.role === "assistant" && (
                <div style={{ fontSize: "11px", color: "#6bd67a", marginBottom: "2px" }}>
                  Deck AI
                </div>
              )}
              {msg.role === "error" && (
                <div style={{ fontSize: "11px", color: "#d66b6b", marginBottom: "2px" }}>
                  Error
                </div>
              )}
              <div style={{ whiteSpace: "pre-wrap" }}>{msg.content}</div>
              {msg.role === "assistant" && msg.content === "" && isLoading && (
                <span style={{ color: "#6bd67a" }}>Thinking...</span>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>
      </PanelSection>

      {/* Input area */}
      <PanelSection>
        <PanelSectionRow>
          <TextField
            label="Ask Deck AI"
            value={input}
            onChange={(e) => setInput(e?.target.value ?? "")}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleSend();
            }}
            disabled={isLoading}
          />
        </PanelSectionRow>
        <PanelSectionRow>
          <div style={{ display: "flex", gap: "8px", width: "100%" }}>
            <ButtonItem
              layout="below"
              onClick={() => setAttachScreenshot(!attachScreenshot)}
              disabled={isLoading}
            >
              <FaCamera style={{ marginRight: "6px" }} />
              {attachScreenshot ? "Screenshot ON" : "Screenshot"}
            </ButtonItem>
            <ButtonItem
              layout="below"
              onClick={handleSend}
              disabled={isLoading || !input.trim()}
            >
              <FaPaperPlane style={{ marginRight: "6px" }} />
              {isLoading ? "Thinking..." : "Send"}
            </ButtonItem>
          </div>
        </PanelSectionRow>
      </PanelSection>
    </div>
  );
};

// ── Plugin registration ──────────────────────────────────────────

export default definePlugin(() => {
  console.log("Deck AI plugin loaded");

  return {
    name: "Deck AI",
    titleView: (
      <div className={staticClasses.Title}>
        <FaRobot style={{ marginRight: "8px" }} />
        Deck AI
      </div>
    ),
    content: <ChatPanel />,
    icon: <FaRobot />,
    onDismount() {
      console.log("Deck AI plugin unmounted");
    },
  };
});
