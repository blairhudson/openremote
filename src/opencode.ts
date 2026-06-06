import { createOpencodeClient, type AssistantMessage, type Command, type Event as OpencodeEvent, type FileDiff, type GlobalEvent, type Message, type Part, type Session, type SessionStatus } from "@opencode-ai/sdk/client";
import EventSource from "react-native-sse";

import type { ConnectionSettings } from "./storage";

export type { AssistantMessage, Command, FileDiff, Message, OpencodeEvent, Part, Session, SessionStatus };
export type PermissionRequest = {
  id: string;
  sessionID: string;
  permission: string;
  patterns: string[];
  metadata: Record<string, unknown>;
  always: string[];
  tool?: { messageID: string; callID: string };
};
export type QuestionOption = { label: string; description: string };
export type QuestionInfo = {
  question: string;
  header: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};
export type QuestionRequest = {
  id: string;
  sessionID: string;
  questions: QuestionInfo[];
  tool?: { messageID: string; callID: string };
};
export type ShellBody = { command: string; agent?: string; model?: SelectedModel };
type PermissionAskedEvent = { id: string; type: "permission.asked"; properties: PermissionRequest };
type PermissionRepliedEvent = { id: string; type: "permission.replied"; properties: { sessionID: string; requestID: string; reply: "once" | "always" | "reject" } };
type QuestionAskedEvent = { id: string; type: "question.asked"; properties: QuestionRequest };
type QuestionRepliedEvent = { id: string; type: "question.replied"; properties: { sessionID: string; requestID: string; answers: string[][] } };
type QuestionRejectedEvent = { id: string; type: "question.rejected"; properties: { sessionID: string; requestID: string } };
type TuiToastEvent = { id?: string; type: "tui.toast.show"; properties?: { message?: string; title?: string }; message?: string };
export type StreamEvent = (OpencodeEvent | PermissionAskedEvent | PermissionRepliedEvent | QuestionAskedEvent | QuestionRepliedEvent | QuestionRejectedEvent | TuiToastEvent) & { serverDirectory?: string };

export type Health = { healthy: boolean; version: string };
export type OpenRemoteStatus = { instanceId: string; activeSessionIds: string[]; allowNewSessions?: boolean; connected: boolean; lastHeartbeatAt: number };
export type MessageBundle = {
  info?: Message;
  parts?: Part[];
};
export type ModelLimits = Record<string, number>;
export type ProviderCatalog = {
  all: Array<{
    id: string;
    name: string;
    models: Record<string, { id?: string; name?: string; limit?: { context?: number }; reasoning?: boolean; status?: string }>;
  }>;
  default?: Record<string, string>;
  connected?: string[];
};
export type AgentInfo = {
  name: string;
  description?: string;
  mode?: string;
  builtIn?: boolean;
};
export type AppConfig = {
  theme?: string;
  model?: string;
  [key: string]: unknown;
};
export type SelectedModel = { providerID: string; modelID: string; reasoning?: boolean; variant?: string };

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.trim().replace(/\/+$/, "");
}

function authHeader(settings: ConnectionSettings) {
  return `Basic ${btoa(`${settings.username}:${settings.password}`)}`;
}

function authHeaders(settings: ConnectionSettings): Record<string, string> {
  if (!settings.password) return {};
  return { Authorization: authHeader(settings) };
}

export class OpencodeClient {
  private settings: ConnectionSettings;
  private client: ReturnType<typeof createOpencodeClient>;

  constructor(settings: ConnectionSettings) {
    this.settings = { ...settings, baseUrl: normalizeBaseUrl(settings.baseUrl) };
    this.client = createOpencodeClient({
      baseUrl: this.settings.baseUrl,
      responseStyle: "data",
      throwOnError: true,
      fetch: (request) => {
        const headers = new Headers(request.headers);
        if (this.settings.password) headers.set("Authorization", authHeader(this.settings));
        return fetch(new Request(request, { headers }));
      },
    });
  }

  private async request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.settings.baseUrl}${path}`, {
      ...init,
      headers: {
        ...authHeaders(this.settings),
        Accept: "application/json",
        "Content-Type": "application/json",
        ...init.headers,
      },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  private async unwrap<T>(promise: Promise<T | { data?: T; error?: unknown }>) {
    const result = await promise;
    if (!result || typeof result !== "object" || !("data" in result || "error" in result)) return result as T;
    if (result.error) throw result.error;
    return result.data as T;
  }

  health() {
    return this.request<Health>("/global/health");
  }

  sessions() {
    return this.unwrap<Session[]>(this.client.session.list());
  }

  sessionStatus() {
    return this.unwrap<Record<string, SessionStatus>>(this.client.session.status());
  }

  async commands() {
    const commands = await this.unwrap<Command[]>(this.client.command.list({}));
    return commands.sort((left, right) => left.name.localeCompare(right.name));
  }

  async modelLimits() {
    const providers = await this.providers();
    const limits: ModelLimits = {};

    for (const provider of providers.all) {
      for (const [key, model] of Object.entries(provider.models)) {
        const context = model.limit?.context;
        if (!context) continue;
        limits[`${provider.id}:${key}`] = context;
        if (model.id) limits[`${provider.id}:${model.id}`] = context;
      }
    }

    return limits;
  }

  providers() {
    return this.unwrap<ProviderCatalog>(this.client.provider.list({}));
  }

  agents() {
    return this.unwrap<AgentInfo[]>(this.client.app.agents({}));
  }

  config() {
    return this.unwrap<AppConfig>(this.client.config.get({}));
  }

  updateConfig(config: AppConfig) {
    return this.unwrap<AppConfig>(this.client.config.update({ body: config }));
  }

  createSession() {
    return this.unwrap<Session>(this.client.session.create({ body: {} }));
  }

  messages(sessionId: string) {
    return this.unwrap<MessageBundle[]>(this.client.session.messages({ path: { id: sessionId }, query: { limit: 100 } }));
  }

  sessionDiff(sessionId: string, messageId: string) {
    return this.unwrap<FileDiff[]>(this.client.session.diff({ path: { id: sessionId }, query: { messageID: messageId } }));
  }

  permissions() {
    return this.request<PermissionRequest[]>("/permission");
  }

  questions() {
    return this.request<QuestionRequest[]>("/question");
  }

  async openRemoteStatus() {
    try {
      return await this.request<OpenRemoteStatus>("/openremote/status");
    } catch {
      return null;
    }
  }

  async heartbeat() {
    try {
      return await this.request<OpenRemoteStatus>("/openremote/heartbeat", { method: "POST", body: JSON.stringify({}) });
    } catch {
      return null;
    }
  }

  replyPermission(requestId: string, reply: "once" | "always" | "reject", message?: string) {
    return this.request<boolean>(`/permission/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ reply, message: message?.trim() || undefined }),
    });
  }

  replyQuestion(requestId: string, answers: string[][]) {
    return this.request<boolean>(`/question/${encodeURIComponent(requestId)}/reply`, {
      method: "POST",
      body: JSON.stringify({ answers }),
    });
  }

  rejectQuestion(requestId: string) {
    return this.request<boolean>(`/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" });
  }

  sendPrompt(sessionId: string, text: string, agent: string, model?: SelectedModel) {
    const selectedModel = model ? { providerID: model.providerID, modelID: model.modelID } : undefined;
    return this.unwrap<void>(this.client.session.promptAsync({ path: { id: sessionId }, body: { agent, model: selectedModel, variant: model?.variant, parts: [{ type: "text", text }] } as never }));
  }

  runCommand(sessionId: string, command: string, args: string, agent: string, model?: SelectedModel) {
    return this.unwrap<MessageBundle>(this.client.session.command({ path: { id: sessionId }, body: { agent, model: model ? `${model.providerID}/${model.modelID}` : undefined, variant: model?.variant, command, arguments: args } as never }));
  }

  shell(sessionId: string, path: string | undefined, body: ShellBody) {
    const selectedModel = body.model ? { providerID: body.model.providerID, modelID: body.model.modelID } : undefined;
    return this.unwrap<AssistantMessage>(this.client.session.shell({ path: { id: sessionId }, query: { directory: path }, body: { agent: body.agent ?? "build", model: selectedModel, command: body.command } } as never));
  }

  revertMessage(sessionId: string, messageId: string) {
    return this.unwrap<Session>(this.client.session.revert({ path: { id: sessionId }, body: { messageID: messageId } }));
  }

  forkSession(sessionId: string, messageId: string) {
    return this.unwrap<Session>(this.client.session.fork({ path: { id: sessionId }, body: { messageID: messageId } }));
  }

  abortSession(sessionId: string) {
    return this.unwrap<boolean>(this.client.session.abort({ path: { id: sessionId } }));
  }

  updateSession(sessionId: string, title: string) {
    return this.unwrap<Session>(this.client.session.update({ path: { id: sessionId }, body: { title } }));
  }

  tui(action: "append-prompt" | "submit-prompt" | "clear-prompt" | "open-help" | "open-sessions" | "open-themes" | "open-models", body?: { text: string }) {
    if (action === "append-prompt") return this.unwrap<boolean>(this.client.tui.appendPrompt({ body }));
    if (action === "submit-prompt") return this.unwrap<boolean>(this.client.tui.submitPrompt());
    if (action === "clear-prompt") return this.unwrap<boolean>(this.client.tui.clearPrompt());
    if (action === "open-help") return this.unwrap<boolean>(this.client.tui.openHelp());
    if (action === "open-sessions") return this.unwrap<boolean>(this.client.tui.openSessions());
    if (action === "open-themes") return this.unwrap<boolean>(this.client.tui.openThemes());
    return this.unwrap<boolean>(this.client.tui.openModels());
  }

  executeTuiCommand(command: string) {
    return this.unwrap<boolean>(this.client.tui.executeCommand({ body: { command } }));
  }

  cycleDesktopAgent() {
    return this.executeTuiCommand("agent_cycle");
  }

  showToast(message: string) {
    return this.unwrap<boolean>(this.client.tui.showToast({ body: { title: "openremote", message, variant: "info", duration: 2500 } }));
  }

  events(onEvent: (event: StreamEvent) => void, onUnknown: () => void) {
    const source = new EventSource(`${this.settings.baseUrl}/global/event`, {
      headers: authHeaders(this.settings),
    } as never);

    const handleEvent = (event: { data?: string; type?: string }) => {
      const parsed = parseEvent(event);
      if (parsed) onEvent(parsed);
      else onUnknown();
    };

    source.addEventListener("message", handleEvent as never);
    return () => {
      try {
        source.removeEventListener("message", handleEvent as never);
      } finally {
        source.close();
      }
    };
  }
}

function parseEvent(event: { data?: string; type?: string }) {
  if (!event.data) {
    if (event.type === "server.connected") return { type: "server.connected", properties: {} } as OpencodeEvent;
    return undefined;
  }

  try {
    const data = JSON.parse(event.data) as GlobalEvent | OpencodeEvent;
    const payload = "payload" in data ? data.payload : data;
    const type = payload && typeof payload === "object" && "type" in payload ? String(payload.type) : undefined;
    if (type === "sync") return undefined;
    if (payload && typeof payload === "object" && "type" in payload) {
      const directory = "directory" in data && typeof data.directory === "string" ? data.directory : undefined;
      return { ...(payload as OpencodeEvent), serverDirectory: directory } as StreamEvent;
    }
  } catch {
    return undefined;
  }
}
