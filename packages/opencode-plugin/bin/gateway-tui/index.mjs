import { createInboxScreen, optionLabel, questionAllowsCustom, questionConfirm, questionItem, questionItemOptions, questionItems, questionSingle, questionTabCount, renderInboxScreen, selectedInboxInstance } from "./inbox.mjs";
import { createSplashScreen, renderSplashScreen } from "./splash.mjs";
import { createStatusScreen, renderStatusScreen } from "./status.mjs";
import { displayEndpoint, panelProps, profileSpan, theme } from "./common.mjs";

export async function attachGatewayOpenTui(deps) {
  const { createCliRenderer, BoxRenderable, TextRenderable, RGBA } = await import("@opentui/core");
  let status;
  let inbox = [];
  let activeTab = "status";
  let inboxIndex = 0;
  let dialogQuestionIndex = 0;
  let dialogOptionIndex = 0;
  let dialogAnswers = [];
  let customAnswers = [];
  let dialogEditing = false;
  let notice = "";
  let remotePickerOpen = false;
  let remotePickerIndex = 0;
  let commandPaletteOpen = false;
  let commandPaletteQuery = "";
  let commandPaletteIndex = 0;
  let inviteQrVisible = false;
  let inviteClientCount = 0;
  let busy = false;
  let closed = false;
  let selectedInstanceId = "";
  let selectedRowId = "";
  let selectedQuestionId = "";

  const renderer = await createCliRenderer({ exitOnCtrlC: false, clearOnShutdown: true, targetFps: 30, backgroundColor: theme.background });
  const box = (id, props = {}) => new BoxRenderable(renderer, { id, ...props });
  const text = (id, content = "", props = {}) => new TextRenderable(renderer, { id, content, fg: theme.text, wrapMode: "word", ...props });
  const root = box("gateway-root", { width: "100%", height: "100%", backgroundColor: theme.background, flexDirection: "column", paddingTop: 0, paddingLeft: 0, paddingRight: 0, gap: 0 });
  const headerPanel = box("gateway-header", { backgroundColor: theme.background, width: "auto", height: 1, flexShrink: 0, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1 });
  const headerText = text("gateway-header-text", "OpenRemote Gateway", { fg: theme.text });
  const tabsPanel = box("gateway-tabs", { backgroundColor: theme.background, width: "auto", height: 1, flexShrink: 0, flexDirection: "row", gap: 1, paddingLeft: 1, paddingRight: 1 });
  const statusTab = box("gateway-tab-status", { width: 10, height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, onMouseDown: () => void runAction("tab-status") });
  const statusTabText = text("gateway-tab-status-text", "Status", { fg: theme.text, wrapMode: "none" });
  statusTab.add(statusTabText);
  const inboxTab = box("gateway-tab-inbox", { width: 10, height: 1, flexShrink: 0, paddingLeft: 1, paddingRight: 1, onMouseDown: () => void runAction("tab-inbox") });
  const inboxTabText = text("gateway-tab-inbox-text", "Inbox", { fg: theme.text, wrapMode: "none" });
  inboxTab.add(inboxTabText);
  const headerEndpointText = text("gateway-header-endpoint", "", { fg: theme.muted, wrapMode: "none" });
  tabsPanel.add(statusTab);
  tabsPanel.add(inboxTab);
  headerPanel.add(headerText);
  headerPanel.add(headerEndpointText);
  const splash = createSplashScreen({ box, text });
  const statusScreen = createStatusScreen({ box, text });
  const inboxScreen = createInboxScreen({ box, text });
  const controlsPanel = box("gateway-controls-panel", { backgroundColor: theme.background, width: "auto", height: 1, flexShrink: 0, flexDirection: "column", paddingLeft: 1, paddingRight: 1 });
  const controlsText = text("gateway-controls-text", "", { fg: theme.muted, wrapMode: "none" });
  controlsPanel.add(controlsText);
  const modalOverlay = box("gateway-modal-overlay", { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", visible: false, zIndex: 10, backgroundColor: RGBA.fromInts(0, 0, 0, 150), alignItems: "center", justifyContent: "flex-start", onMouseUp: () => void runAction("modal-close") });
  const modal = box("gateway-remote-modal", { ...panelProps, flexDirection: "column", width: 44, height: 8, flexShrink: 0, border: true, borderColor: theme.borderActive, onMouseUp: (event) => event?.stopPropagation?.() });
  const modalHelpText = text("gateway-modal-help", "Remote Access", { fg: theme.muted });
  const offButton = box("gateway-modal-off", { width: "auto", height: 1, paddingLeft: 1, paddingRight: 1, onMouseDown: () => void runAction("remote-off") });
  const offText = text("gateway-modal-off-text", "Off");
  offButton.add(offText);
  const cloudflareButton = box("gateway-modal-cloudflare", { width: "auto", height: 1, paddingLeft: 1, paddingRight: 1, onMouseDown: () => void runAction("remote-cloudflare") });
  const cloudflareText = text("gateway-modal-cloudflare-text", "Cloudflare");
  cloudflareButton.add(cloudflareText);
  modal.add(modalHelpText);
  modal.add(offButton);
  modal.add(cloudflareButton);
  modal.add(text("gateway-modal-keys", "up/down enter esc", { fg: theme.muted }));
  modalOverlay.add(modal);
  const commandOverlay = box("gateway-command-overlay", { position: "absolute", top: 0, left: 0, width: "100%", height: "100%", visible: false, zIndex: 20, backgroundColor: RGBA.fromInts(0, 0, 0, 150), alignItems: "center", justifyContent: "flex-start", onMouseUp: () => {
    commandPaletteOpen = false;
    updateView();
  } });
  const commandModal = box("gateway-command-modal", { ...panelProps, flexDirection: "column", width: 58, height: 18, flexShrink: 0, border: true, borderColor: theme.borderActive, onMouseUp: (event) => event?.stopPropagation?.() });
  const commandTitleRow = box("gateway-command-title-row", { width: "auto", height: 1, flexShrink: 0 });
  const commandTitle = text("gateway-command-title", "Command", { fg: theme.text, wrapMode: "none" });
  commandTitleRow.add(commandTitle);
  const commandInputRow = box("gateway-command-input-row", { width: "auto", height: 1, flexShrink: 0 });
  const commandInputText = text("gateway-command-input", "> ", { fg: theme.primary, wrapMode: "none" });
  commandInputRow.add(commandInputText);
  const commandRows = [];
  commandModal.add(commandTitleRow);
  commandModal.add(commandInputRow);
  for (let index = 0; index < 11; index += 1) {
    const row = box(`gateway-command-row-${index}`, { width: "auto", height: 1, flexShrink: 0, flexDirection: "row", justifyContent: "space-between", paddingLeft: 1, paddingRight: 1, backgroundColor: theme.panel });
    const rowText = text(`gateway-command-row-text-${index}`, "", { fg: theme.text, wrapMode: "none" });
    const shortcutText = text(`gateway-command-row-shortcut-${index}`, "", { fg: theme.muted, wrapMode: "none" });
    row.add(rowText);
    row.add(shortcutText);
    commandModal.add(row);
    commandRows.push({ row, rowText, shortcutText });
  }
  const commandHelpRow = box("gateway-command-help-row", { width: "auto", height: 1, flexShrink: 0 });
  commandHelpRow.add(text("gateway-command-help", "type to filter · shortcut or enter to run · esc closes", { fg: theme.muted, wrapMode: "none" }));
  commandModal.add(commandHelpRow);
  commandOverlay.add(commandModal);
  root.add(headerPanel);
  root.add(tabsPanel);
  root.add(splash.panel);
  root.add(statusScreen.topPanels);
  root.add(inboxScreen.panels);
  root.add(controlsPanel);
  root.add(modalOverlay);
  root.add(commandOverlay);
  renderer.root.add(root);

  function selected() {
    return selectedInboxInstance(inbox, inboxIndex);
  }

  function firstDevServer() {
    for (const instance of status?.instances || []) {
      const server = Array.isArray(instance.devServers) ? instance.devServers[0] : undefined;
      if (server?.port) return { ...server, instanceId: instance.instanceId };
    }
    return undefined;
  }

  function resetDialogState() {
    dialogQuestionIndex = 0;
    dialogOptionIndex = 0;
    dialogAnswers = [];
    customAnswers = [];
    dialogEditing = false;
    selectedQuestionId = selected()?.question?.id || "";
  }

  function syncSelectedQuestion() {
    const nextQuestionId = selected()?.question?.id || "";
    if (nextQuestionId !== selectedQuestionId) resetDialogState();
  }

  function currentQuestionItem() {
    return questionItem(selected()?.question, dialogQuestionIndex);
  }

  function currentQuestionOptions() {
    return questionItemOptions(currentQuestionItem());
  }

  function currentAnswer() {
    return Array.isArray(dialogAnswers[dialogQuestionIndex]) ? dialogAnswers[dialogQuestionIndex] : [];
  }

  function currentCustomAnswer() {
    return String(customAnswers[dialogQuestionIndex] || "");
  }

  function setCurrentCustomAnswer(value) {
    const previous = currentCustomAnswer().trim();
    const next = [...customAnswers];
    next[dialogQuestionIndex] = value;
    customAnswers = next;
    if (previous && currentAnswer().includes(previous)) {
      const trimmed = value.trim();
      setCurrentAnswer(trimmed ? currentAnswer().map((item) => item === previous ? trimmed : item) : currentAnswer().filter((item) => item !== previous));
    }
  }

  function setCurrentAnswer(values) {
    const next = [...dialogAnswers];
    next[dialogQuestionIndex] = values.filter(Boolean);
    dialogAnswers = next;
  }

  function selectedDialogValue() {
    const options = currentQuestionOptions();
    if (dialogOptionIndex < options.length) return optionLabel(options[dialogOptionIndex]);
    return currentCustomAnswer().trim();
  }

  function toggleDialogSelection() {
    const item = currentQuestionItem();
    const value = selectedDialogValue();
    if (!item || !value) return false;
    const current = currentAnswer();
    if (item.multiple) {
      setCurrentAnswer(current.includes(value) ? current.filter((item) => item !== value) : [...current, value]);
    } else {
      setCurrentAnswer([value]);
    }
    return true;
  }

  function selectDialogOption() {
    const item = currentQuestionItem();
    if (!item) return { submit: false };
    const options = currentQuestionOptions();
    const isCustom = questionAllowsCustom(item) && dialogOptionIndex >= options.length;
    if (isCustom) {
      const value = currentCustomAnswer().trim();
      if (!item.multiple) {
        dialogEditing = true;
        return { submit: false };
      }
      if (value && currentAnswer().includes(value)) {
        toggleDialogSelection();
        return { submit: false };
      }
      dialogEditing = true;
      return { submit: false };
    }
    const value = selectedDialogValue();
    if (!value) return { submit: false };
    if (item.multiple) {
      toggleDialogSelection();
      return { submit: false };
    }
    setCurrentAnswer([value]);
    if (questionSingle(selected()?.question)) return { submit: true };
    dialogQuestionIndex = Math.min(questionTabCount(selected()?.question) - 1, dialogQuestionIndex + 1);
    dialogOptionIndex = 0;
    return { submit: false };
  }

  function saveCustomAnswer() {
    const item = currentQuestionItem();
    if (!item) return { submit: false };
    const value = currentCustomAnswer().trim();
    const previous = String(customAnswers[dialogQuestionIndex] || "").trim();
    if (!value) {
      if (previous) setCurrentAnswer(currentAnswer().filter((answer) => answer !== previous));
      dialogEditing = false;
      return { submit: false };
    }
    if (item.multiple) {
      const current = currentAnswer().filter((answer) => answer !== previous);
      setCurrentAnswer(current.includes(value) ? current : [...current, value]);
      dialogEditing = false;
      return { submit: false };
    }
    setCurrentAnswer([value]);
    dialogEditing = false;
    if (questionSingle(selected()?.question)) return { submit: true };
    dialogQuestionIndex = Math.min(questionTabCount(selected()?.question) - 1, dialogQuestionIndex + 1);
    dialogOptionIndex = 0;
    return { submit: false };
  }

  function answersForSelectedQuestion() {
    const items = questionItems(selected()?.question);
    return Array.from({ length: items.length }, (_, index) => Array.isArray(dialogAnswers[index]) ? dialogAnswers[index] : []);
  }

  function canSubmitAnswers() {
    const answers = answersForSelectedQuestion();
    return answers.length > 0 && answers.every((answer) => answer.length > 0);
  }

  function isCtrlC(key) {
    const name = String(key?.name || "").toLowerCase();
    const sequence = key?.sequence || key;
    return sequence === "\u0003" || (name === "c" && key?.ctrl);
  }

  function isTimeoutError(error) {
    const name = String(error?.name || "").toLowerCase();
    const message = String(error?.message || error || "").toLowerCase();
    return name.includes("timeout") || name.includes("abort") || message.includes("timed out") || message.includes("timeout");
  }

  function inviteAvailable() {
    const remote = status?.remoteAccess;
    const clients = Array.isArray(remote?.clients) ? remote.clients : [];
    const maxClients = Number(remote?.maxClients ?? 1);
    return !!remote?.enabled && !!remote.connected && (maxClients === 0 || clients.length < maxClients);
  }

  function sendAvailable() {
    const instance = selected();
    if (!instance?.question?.id) return false;
    const items = questionItems(instance.question);
    if (!items.length) return false;
    return canSubmitAnswers();
  }

  function buildCommands() {
    const instance = selected();
    return [
      { id: "status", label: "Status", shortcut: "1", action: "tab-status", enabled: activeTab !== "status" },
      { id: "inbox", label: "Inbox", shortcut: "2", action: "tab-inbox", enabled: activeTab !== "inbox" },
      { id: "gateway", label: status ? "Stop gateway" : "Start gateway", shortcut: "space", action: "toggle-gateway", enabled: true },
      { id: "restart", label: "Restart gateway", shortcut: "r", action: "restart-gateway", enabled: true },
      { id: "remote", label: "Remote access", shortcut: "t", action: "open-remote-picker", enabled: !!status },
      { id: "keep-awake", label: "Toggle keep awake", shortcut: "k", action: "toggle-keep-awake", enabled: !!status },
      { id: "client", label: "Connect client", shortcut: "c", action: "connect-client", enabled: inviteAvailable() },
      { id: "dev-server", label: "Open dev server", shortcut: "o", action: "open-dev-server", enabled: activeTab === "status" && !!firstDevServer() },
      { id: "dismiss", label: "Dismiss question", shortcut: "esc", action: "inbox-reject", enabled: activeTab === "inbox" && !!instance?.question?.id },
      { id: "send", label: "Submit answer", shortcut: "enter", action: "inbox-submit", enabled: activeTab === "inbox" && sendAvailable() },
      { id: "quit", label: "Close TUI", shortcut: "q", action: "quit", enabled: true },
    ];
  }

  function visibleCommands() {
    const query = commandPaletteQuery.trim().toLowerCase();
    const commands = buildCommands();
    if (!query) return commands;
    return commands.filter((command) => `${command.label} ${command.shortcut}`.toLowerCase().includes(query));
  }

  function updateCommandPaletteView() {
    const commands = visibleCommands();
    if (commandPaletteIndex >= commands.length) commandPaletteIndex = Math.max(0, commands.length - 1);
    commandOverlay.visible = commandPaletteOpen;
    commandInputText.content = `> ${commandPaletteQuery || ""}`;
    for (let index = 0; index < commandRows.length; index += 1) {
      const command = commands[index];
      const row = commandRows[index];
      row.row.visible = !!command;
      if (!command) {
        row.rowText.content = "";
        row.shortcutText.content = "";
        continue;
      }
      const active = index === commandPaletteIndex;
      row.row.backgroundColor = active ? theme.backgroundElement : theme.panel;
      row.rowText.fg = command.enabled ? (active ? theme.text : theme.textMuted) : theme.muted;
      row.shortcutText.fg = command.enabled ? theme.muted : theme.border;
      row.rowText.content = `${active ? "›" : " "} ${command.label}`;
      row.shortcutText.content = command.shortcut;
    }
  }

  function reconcileInboxSelection(nextInbox) {
    if (!nextInbox.length) return 0;
    const rowIndex = selectedRowId ? nextInbox.findIndex((item) => item.rowId === selectedRowId) : -1;
    if (rowIndex >= 0) return rowIndex;
    const nextIndex = selectedInstanceId ? nextInbox.findIndex((item) => item.instanceId === selectedInstanceId) : -1;
    if (nextIndex >= 0) return nextIndex;
    return Math.max(0, Math.min(nextInbox.length - 1, inboxIndex));
  }

  function updateLayout() {
    const terminalWidth = Math.max(20, renderer.terminalWidth || 80);
    const contentWidth = Math.max(20, terminalWidth - 2);
    const qr = status?.remoteAccess?.connected && !inviteQrVisible ? [] : deps.qrLines(status?.remoteAccess?.appUrl || "");
    const qrWidth = Math.max(42, Math.max(0, ...qr.map((line) => line.length)) + 6);
    const compact = contentWidth < Math.max(90, qrWidth + 48);
    statusScreen.topPanels.flexDirection = compact ? "column" : "row";
    splash.panel.width = "auto";
    splash.panel.height = "auto";
    splash.panel.flexGrow = 1;
    splash.card.width = Math.min(contentWidth, Math.max(qrWidth + 4, 62));
    splash.qr.width = splash.card.width;
    statusScreen.statusPanel.width = "auto";
    statusScreen.statusPanel.flexGrow = 0;
    statusScreen.statusPanel.flexShrink = 0;
    statusScreen.qrPanel.width = compact ? "auto" : qrWidth;
    statusScreen.qrPanel.minWidth = qrWidth;
    statusScreen.qrPanel.flexGrow = compact ? 1 : 0;
    statusScreen.qrPanel.flexShrink = 0;
    statusScreen.qrPanel.height = compact ? (qr.length > 0 ? Math.max(5, qr.length + 4) : 5) : "auto";
    statusScreen.instancesPanel.width = "auto";
    statusScreen.clientsPanel.width = "auto";
    inboxScreen.panels.flexDirection = contentWidth < 76 ? "column" : "row";
    inboxScreen.listPanel.width = contentWidth < 76 ? "auto" : 42;
    inboxScreen.detailPanel.width = "auto";
    modalOverlay.width = terminalWidth;
    modalOverlay.height = renderer.terminalHeight || 24;
    modalOverlay.paddingTop = Math.floor((renderer.terminalHeight || 24) / 4);
    modal.width = Math.min(44, contentWidth);
    commandOverlay.width = terminalWidth;
    commandOverlay.height = renderer.terminalHeight || 24;
    commandOverlay.paddingTop = Math.floor((renderer.terminalHeight || 24) / 4);
    commandModal.width = Math.min(58, contentWidth);
  }

  function updateView() {
    return profileSpan("gateway.tui.render", () => {
      const remote = status?.remoteAccess;
      const tunnel = remote?.tunnel || { status: "off", log: "off" };
      const qr = deps.qrLines(remote?.appUrl || "");
      updateLayout();
      const clients = Array.isArray(remote?.clients) ? remote.clients : [];
      const canInviteClient = inviteAvailable();
      const contentWidth = Math.max(20, (renderer.terminalWidth || 80) - 2);
      const qrFits = qr.length > 0 && Math.max(0, ...qr.map((line) => line.length)) + 6 <= contentWidth;
      const showSplash = activeTab === "status" && !!status && !!remote?.enabled && !remote.connected && clients.length === 0 && !inviteQrVisible;
      headerText.content = "OpenRemote Gateway";
      headerEndpointText.content = activeTab === "inbox" ? `${inbox.length} questions` : displayEndpoint(remote?.appUrl);
      statusTab.backgroundColor = activeTab === "status" ? theme.backgroundElement : theme.background;
      inboxTab.backgroundColor = activeTab === "inbox" ? theme.backgroundElement : theme.background;
      statusTabText.fg = activeTab === "status" ? theme.text : theme.muted;
      inboxTabText.fg = activeTab === "inbox" ? theme.text : theme.muted;
      headerPanel.visible = !showSplash;
      tabsPanel.visible = !showSplash;
      statusScreen.topPanels.visible = activeTab === "status" && !showSplash;
      inboxScreen.panels.visible = activeTab === "inbox" && !showSplash;
      controlsPanel.visible = true;
      splash.panel.visible = showSplash;
      renderSplashScreen(splash, { remote, qrLines: qr, qrFits });
      controlsText.content = activeTab === "inbox"
        ? `ctrl-p commands   ↑/↓ select   tab question   enter submit   ctrl-c quit${notice ? `   ${notice}` : ""}`
        : `ctrl-p commands   ctrl-c quit${notice ? `   ${notice}` : ""}`;
      renderStatusScreen(statusScreen, { status, remote, tunnel, qr, qrFits, canInviteClient, inviteQrVisible });
      syncSelectedQuestion();
      const inboxResult = renderInboxScreen(inboxScreen, { inbox, inboxIndex, dialogQuestionIndex, dialogOptionIndex, dialogAnswers, customAnswer: currentCustomAnswer(), dialogEditing, compactText: deps.compactText });
      dialogQuestionIndex = inboxResult.dialogQuestionIndex;
      dialogOptionIndex = inboxResult.dialogOptionIndex;
      modalOverlay.visible = remotePickerOpen;
      offButton.backgroundColor = remotePickerIndex === 0 ? theme.accent : theme.panel;
      offText.fg = remotePickerIndex === 0 ? theme.background : theme.text;
      cloudflareButton.backgroundColor = remotePickerIndex === 1 ? theme.accent : theme.panel;
      cloudflareText.fg = remotePickerIndex === 1 ? theme.background : theme.accent;
      updateCommandPaletteView();
      renderer.requestRender();
    });
  }

  async function refresh() {
    return profileSpan("gateway.tui.refresh", async () => {
      if (closed) return;
      const state = await deps.gatewayState();
      if (!state?.appPort || !state?.adminToken) {
        status = undefined;
        updateView();
        return;
      }
      try {
        status = await deps.fetchGatewayStatus(state);
      } catch (error) {
        if (isTimeoutError(error) && status) {
          updateView();
          return;
        }
        status = undefined;
        updateView();
        return;
      }
      if (activeTab === "inbox") {
        try {
          const inboxPayload = await deps.fetchGatewayInbox(state);
          const nextInbox = Array.isArray(inboxPayload.instances) ? inboxPayload.instances : inbox;
          inboxIndex = reconcileInboxSelection(nextInbox);
          inbox = nextInbox;
          selectedInstanceId = selected()?.instanceId || "";
          selectedRowId = selected()?.rowId || "";
          notice = "";
        } catch (error) {
          if (!isTimeoutError(error)) notice = error instanceof Error ? error.message : "inbox refresh failed";
        }
      }
      const nextClientCount = status?.remoteAccess?.clients?.length || 0;
      if (inviteQrVisible && nextClientCount > inviteClientCount) inviteQrVisible = false;
      updateView();
    });
  }

  function actionForKey(key) {
    const name = String(key?.name || "").toLowerCase();
    const sequence = key?.sequence || key;
    if (isCtrlC(key)) return "quit";
    if (activeTab === "inbox" && !remotePickerOpen && (name === "escape" || sequence === "\u001b")) return "inbox-reject";
    if (name === "escape" || sequence === "\u001b") return "modal-close";
    if (activeTab === "inbox" && !remotePickerOpen) {
      if (dialogEditing) {
        if (name === "return" || name === "enter" || sequence === "\r") return "custom-save";
        if (name === "backspace" || sequence === "\b" || sequence === "\u007f") return "inbox-backspace";
        return undefined;
      }
      if (name === "up" && key?.ctrl) return "inbox-up";
      if (name === "down" && key?.ctrl) return "inbox-down";
      if (name === "up") return "dialog-option-up";
      if (name === "down") return "dialog-option-down";
      if (name === "h") return "question-prev";
      if (name === "l") return "question-next";
      if (name === "k") return "dialog-option-up";
      if (name === "j") return "dialog-option-down";
      if (name === "left" || (name === "tab" && key?.shift)) return "question-prev";
      if (name === "right" || name === "tab") return "question-next";
      if (name === "space" || sequence === " ") return "inbox-submit";
      if (name === "return" || name === "enter" || sequence === "\r") return "inbox-submit";
      if (name === "backspace" || sequence === "\b" || sequence === "\u007f") return "inbox-backspace";
      const digit = Number(name || sequence);
      if (Number.isInteger(digit) && digit >= 1 && digit <= 9) return `option-${digit - 1}`;
    }
    return undefined;
  }

  function remotePickerActionForKey(key) {
    const name = String(key?.name || "").toLowerCase();
    const sequence = key?.sequence || key;
    if (isCtrlC(key)) return "quit";
    if (name === "escape" || sequence === "\u001b") return "modal-close";
    if (name === "up") return "modal-up";
    if (name === "down") return "modal-down";
    if (name === "return" || name === "enter" || sequence === "\r") return "modal-select";
    return undefined;
  }

  function isCommandPaletteKey(key) {
    const name = String(key?.name || "").toLowerCase();
    const sequence = key?.sequence || key;
    return sequence === "\u0010" || (name === "p" && key?.ctrl);
  }

  function openCommandPalette() {
    commandPaletteOpen = true;
    commandPaletteQuery = "";
    commandPaletteIndex = 0;
    remotePickerOpen = false;
    updateView();
  }

  function commandShortcutMatches(command, key) {
    const name = String(key?.name || "").toLowerCase();
    const sequence = key?.sequence || key;
    if (command.shortcut === "space") return name === "space" || sequence === " ";
    if (command.shortcut === "enter") return name === "return" || name === "enter" || sequence === "\r";
    if (command.shortcut === "esc") return name === "escape" || sequence === "\u001b";
    return name === command.shortcut || sequence === command.shortcut;
  }

  async function handleCommandPaletteKey(key) {
    const name = String(key?.name || "").toLowerCase();
    const sequence = key?.sequence || key;
    if (isCtrlC(key)) {
      await runAction("quit");
      return;
    }
    if (name === "escape" || sequence === "\u001b") {
      commandPaletteOpen = false;
      updateView();
      return;
    }
    if (name === "backspace" || sequence === "\b" || sequence === "\u007f") {
      commandPaletteQuery = commandPaletteQuery.slice(0, -1);
      commandPaletteIndex = 0;
      updateView();
      return;
    }
    const commands = visibleCommands();
    if (name === "up") {
      commandPaletteIndex = Math.max(0, commandPaletteIndex - 1);
      updateView();
      return;
    }
    if (name === "down") {
      commandPaletteIndex = Math.min(Math.max(0, commands.length - 1), commandPaletteIndex + 1);
      updateView();
      return;
    }
    if (name === "return" || name === "enter" || sequence === "\r") {
      const command = commands[commandPaletteIndex];
      if (!command?.enabled) return;
      commandPaletteOpen = false;
      await runAction(command.action);
      return;
    }
    const shortcutCommand = commands.find((command) => command.enabled && commandShortcutMatches(command, key));
    if (shortcutCommand && (!commandPaletteQuery || shortcutCommand.shortcut.length !== 1 || /[0-9]/.test(shortcutCommand.shortcut))) {
      commandPaletteOpen = false;
      await runAction(shortcutCommand.action);
      return;
    }
    if (typeof sequence === "string" && sequence.length === 1 && sequence >= " " && sequence !== "\u007f") {
      commandPaletteQuery = `${commandPaletteQuery}${sequence}`.slice(0, 80);
      commandPaletteIndex = 0;
      updateView();
    }
  }

  async function runAction(action) {
    try {
      if (action === "quit") {
        closed = true;
        renderer.destroy();
        return;
      }
      if (action === "tab-status" || action === "tab-inbox") {
        activeTab = action === "tab-inbox" ? "inbox" : "status";
        notice = activeTab;
        await refresh();
        return;
      }
      if (action === "inbox-up" || action === "inbox-down") {
        inboxIndex = action === "inbox-up" ? Math.max(0, inboxIndex - 1) : Math.min(Math.max(0, inbox.length - 1), inboxIndex + 1);
        selectedInstanceId = selected()?.instanceId || "";
        selectedRowId = selected()?.rowId || "";
        resetDialogState();
        updateView();
        return;
      }
      if (action === "dialog-option-up" || action === "dialog-option-down") {
        const item = currentQuestionItem();
        const rows = currentQuestionOptions().length + (questionAllowsCustom(item) ? 1 : 0);
        if (!rows) return;
        dialogOptionIndex = action === "dialog-option-up" ? (dialogOptionIndex - 1 + rows) % rows : (dialogOptionIndex + 1) % rows;
        updateView();
        return;
      }
      if (action === "question-prev" || action === "question-next") {
        const tabs = questionTabCount(selected()?.question);
        if (!tabs || questionSingle(selected()?.question)) return;
        dialogQuestionIndex = action === "question-prev" ? (dialogQuestionIndex - 1 + tabs) % tabs : (dialogQuestionIndex + 1) % tabs;
        dialogOptionIndex = 0;
        dialogEditing = false;
        updateView();
        return;
      }
      if (action.startsWith("option-")) {
        const index = Number(action.slice("option-".length));
        const item = currentQuestionItem();
        const rows = currentQuestionOptions().length + (questionAllowsCustom(item) ? 1 : 0);
        if (!Number.isInteger(index) || index < 0 || index >= rows) return;
        dialogOptionIndex = index;
        const result = selectDialogOption();
        if (result.submit) await runAction("inbox-submit-final");
        else updateView();
        return;
      }
      if (action === "custom-save") {
        const result = saveCustomAnswer();
        if (result.submit) await runAction("inbox-submit-final");
        else updateView();
        return;
      }
      if (action === "custom-cancel") {
        dialogEditing = false;
        updateView();
        return;
      }
      if (action === "inbox-backspace") {
        const options = currentQuestionOptions();
        const item = currentQuestionItem();
        if (questionAllowsCustom(item) && dialogOptionIndex >= options.length) setCurrentCustomAnswer(currentCustomAnswer().slice(0, -1));
        updateView();
        return;
      }
      if (action === "inbox-reject") {
        if (dialogEditing) {
          dialogEditing = false;
          updateView();
          return;
        }
        const instance = selected();
        if (!instance?.question?.id) return;
        await deps.gatewayOpenCodeFetch(`/question/${encodeURIComponent(instance.question.id)}/reject`, { method: "POST", instanceId: instance.instanceId });
        notice = "dismissed";
        resetDialogState();
        await refresh();
        return;
      }
      if (action === "inbox-submit") {
        const instance = selected();
        if (!instance?.question?.id) return;
        if (questionConfirm(instance.question, dialogQuestionIndex)) {
          if (!canSubmitAnswers()) return;
          await runAction("inbox-submit-final");
          return;
        }
        const result = selectDialogOption();
        if (!result.submit) {
          updateView();
          return;
        }
        await runAction("inbox-submit-final");
        return;
      }
      if (action === "inbox-submit-final") {
        const instance = selected();
        if (!instance?.question?.id) return;
        const answers = answersForSelectedQuestion();
        if (answers.some((answer) => !answer.length)) return;
        await deps.gatewayOpenCodeFetch(`/question/${encodeURIComponent(instance.question.id)}/reply`, { method: "POST", instanceId: instance.instanceId, body: { answers } });
        notice = "answered";
        resetDialogState();
        await refresh();
        return;
      }
      if (action === "open-remote-picker") {
        remotePickerIndex = status?.remoteAccess?.mode === "cloudflare" ? 1 : 0;
        remotePickerOpen = true;
        notice = "remote options";
        updateView();
        return;
      }
      if (action === "connect-client") {
        const remote = status?.remoteAccess;
        const clients = Array.isArray(remote?.clients) ? remote.clients : [];
        const maxClients = Number(remote?.maxClients ?? 1);
        if (!remote?.connected || (maxClients !== 0 && clients.length >= maxClients)) {
          notice = "max clients reached";
          updateView();
          return;
        }
        await deps.gatewayAdminPost("/openremote/gateway/remote/invite");
        inviteClientCount = clients.length;
        inviteQrVisible = true;
        await refresh();
        return;
      }
      if (action === "open-dev-server") {
        const server = firstDevServer();
        if (!server) return;
        const forward = await deps.gatewayForwardToken(server);
        deps.openDefaultBrowser(forward.url);
        notice = "opened dev server";
        updateView();
        return;
      }
      if (action === "modal-close") {
        remotePickerOpen = false;
        updateView();
        return;
      }
      if (action === "modal-up" || action === "modal-down") {
        remotePickerIndex = action === "modal-up" ? Math.max(0, remotePickerIndex - 1) : Math.min(1, remotePickerIndex + 1);
        notice = remotePickerIndex === 0 ? "off" : "cloudflare";
        updateView();
        return;
      }
      if (action === "modal-select") action = remotePickerIndex === 0 ? "remote-off" : "remote-cloudflare";
      if (busy) return;
      busy = true;
      if (action === "toggle-gateway") {
        if (status) await deps.stopGateway({ quiet: true });
        else await deps.startGateway({ quiet: true });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (action === "restart-gateway") {
        await deps.stopGateway({ quiet: true, preserveState: true });
        await deps.startGateway({ quiet: true });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      if (action === "remote-off") {
        if (status) await deps.gatewayAdminPost("/openremote/gateway/remote/off");
        remotePickerOpen = false;
      }
      if (action === "remote-cloudflare") {
        if (status) await deps.gatewayAdminPost("/openremote/gateway/remote/cloudflare");
        remotePickerOpen = false;
      }
      if (action === "toggle-keep-awake" && status) await deps.gatewayAdminPost("/openremote/gateway/keep-awake/toggle");
      notice = action.startsWith("remote-") ? "updated" : "refreshed";
      await refresh();
    } catch (error) {
      notice = error instanceof Error ? error.message : String(error);
      updateView();
    } finally {
      busy = false;
    }
  }

  const keypressHandler = (event) => {
    if (isCommandPaletteKey(event)) {
      event.preventDefault?.();
      event.stopPropagation?.();
      openCommandPalette();
      return;
    }
    if (commandPaletteOpen) {
      event.preventDefault?.();
      event.stopPropagation?.();
      void handleCommandPaletteKey(event);
      return;
    }
    const action = remotePickerOpen ? remotePickerActionForKey(event) : actionForKey(event);
      if (!action) {
        const sequence = event?.sequence || event;
        if (activeTab === "inbox" && typeof sequence === "string" && sequence.length === 1 && sequence >= " " && sequence !== "\u007f") {
        if (dialogEditing) {
          setCurrentCustomAnswer(`${currentCustomAnswer()}${sequence}`.slice(0, 500));
          updateView();
          event.preventDefault?.();
          event.stopPropagation?.();
        }
      }
      return;
    }
    event.preventDefault?.();
    event.stopPropagation?.();
    void runAction(action);
  };
  renderer.keyInput.on("keypress", keypressHandler);
  renderer.on("resize", updateView);
  await refresh();
  const timer = setInterval(() => void refresh(), 1000);
  timer.unref?.();
  renderer.once("destroy", () => {
    closed = true;
    clearInterval(timer);
    renderer.keyInput.off("keypress", keypressHandler);
    renderer.off("resize", updateView);
  });
  renderer.start();
  await new Promise((resolve) => renderer.once("destroy", resolve));
}
