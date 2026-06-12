import path from "node:path";
import { sidebarProps, shortPath, splitBorder, theme } from "./common.mjs";

const MAX_INBOX_ROWS = 12;
const MAX_QUESTION_TABS = 8;
const MAX_QUESTION_OPTIONS = 10;

export function createInboxScreen({ box, text }) {
  const panels = box("gateway-inbox-panels", { width: "auto", height: "auto", flexDirection: "row", flexGrow: 1, flexShrink: 1, gap: 0, alignItems: "stretch" });
  const listPanel = box("gateway-inbox-list", { ...sidebarProps, flexDirection: "column", flexGrow: 0, flexShrink: 0, width: 42, minWidth: 0 });
  const listTitle = text("gateway-inbox-list-title", "Inbox", { fg: theme.text, wrapMode: "none" });
  const listText = text("gateway-inbox-list-text", "");
  listPanel.add(listTitle);
  listPanel.add(listText);
  const listRows = [];
  for (let index = 0; index < MAX_INBOX_ROWS; index += 1) {
    const row = box(`gateway-inbox-row-${index}`, { width: "auto", height: 2, flexShrink: 0, paddingLeft: 1, paddingRight: 1, backgroundColor: theme.backgroundPanel });
    const rowText = text(`gateway-inbox-row-text-${index}`, "", { fg: theme.text, wrapMode: "none" });
    row.add(rowText);
    listPanel.add(row);
    listRows.push({ row, rowText });
  }
  const detailPanel = box("gateway-inbox-detail", { backgroundColor: theme.background, flexDirection: "column", flexGrow: 1, flexShrink: 1, width: "auto", minWidth: 0, paddingTop: 1, paddingBottom: 1, paddingLeft: 2, paddingRight: 2, gap: 1 });
  const detailTitle = text("gateway-inbox-detail-title", "Instance", { fg: theme.text, wrapMode: "none" });
  const detailCard = box("gateway-inbox-detail-card", { ...splitBorder, borderColor: theme.accent, backgroundColor: theme.backgroundPanel, flexDirection: "column", flexGrow: 1, flexShrink: 1, width: "auto", paddingLeft: 1, paddingRight: 3, paddingTop: 1, paddingBottom: 1, gap: 1 });
  const emptyText = text("gateway-inbox-empty", "", { fg: theme.textMuted });
  const tabRow = box("gateway-inbox-question-tabs", { flexDirection: "row", gap: 1, flexShrink: 0, paddingLeft: 1 });
  const tabs = [];
  for (let index = 0; index < MAX_QUESTION_TABS; index += 1) {
    const tab = box(`gateway-inbox-question-tab-${index}`, { height: 1, width: "auto", flexShrink: 0, paddingLeft: 1, paddingRight: 1, backgroundColor: theme.backgroundPanel });
    const tabText = text(`gateway-inbox-question-tab-text-${index}`, "", { fg: theme.textMuted, wrapMode: "none" });
    tab.add(tabText);
    tabRow.add(tab);
    tabs.push({ tab, tabText });
  }
  const bodyBox = box("gateway-inbox-question-body", { width: "auto", flexGrow: 1, flexShrink: 1, flexDirection: "column", paddingLeft: 1, gap: 1 });
  const questionText = text("gateway-inbox-question-text", "", { fg: theme.text, wrapMode: "word" });
  const optionBox = box("gateway-inbox-question-options", { width: "auto", flexGrow: 1, flexShrink: 1, flexDirection: "column" });
  const optionRows = [];
  for (let index = 0; index < MAX_QUESTION_OPTIONS; index += 1) {
    const row = box(`gateway-inbox-question-option-${index}`, { width: "auto", flexShrink: 0, flexDirection: "column" });
    const line = box(`gateway-inbox-question-option-line-${index}`, { width: "auto", height: 1, flexShrink: 0, flexDirection: "row" });
    const prefix = box(`gateway-inbox-question-option-prefix-box-${index}`, { width: "auto", height: 1, flexShrink: 0, paddingRight: 1 });
    const prefixText = text(`gateway-inbox-question-option-prefix-${index}`, "", { fg: theme.textMuted, wrapMode: "none" });
    const label = box(`gateway-inbox-question-option-label-box-${index}`, { width: "auto", height: 1, flexShrink: 0 });
    const labelText = text(`gateway-inbox-question-option-label-${index}`, "", { fg: theme.text, wrapMode: "none" });
    const checkText = text(`gateway-inbox-question-option-check-${index}`, "", { fg: theme.success, wrapMode: "none" });
    const descText = text(`gateway-inbox-question-option-desc-${index}`, "", { fg: theme.textMuted, wrapMode: "word" });
    prefix.add(prefixText);
    label.add(labelText);
    line.add(prefix);
    line.add(label);
    line.add(checkText);
    row.add(line);
    row.add(descText);
    optionBox.add(row);
    optionRows.push({ row, prefix, prefixText, label, labelText, checkText, descText });
  }
  const reviewBox = box("gateway-inbox-question-review", { width: "auto", flexGrow: 1, flexShrink: 1, flexDirection: "column", paddingLeft: 1, gap: 1 });
  const reviewTitle = text("gateway-inbox-question-review-title", "Review", { fg: theme.text, wrapMode: "none" });
  const reviewRows = [];
  reviewBox.add(reviewTitle);
  for (let index = 0; index < MAX_QUESTION_OPTIONS; index += 1) {
    const reviewText = text(`gateway-inbox-question-review-${index}`, "", { fg: theme.text, wrapMode: "word" });
    reviewBox.add(reviewText);
    reviewRows.push(reviewText);
  }
  bodyBox.add(questionText);
  bodyBox.add(optionBox);
  const actionRow = box("gateway-inbox-question-actions", { flexDirection: "row", flexShrink: 0, gap: 2, paddingLeft: 1, paddingRight: 3, paddingBottom: 0 });
  const actionText = text("gateway-inbox-question-action-text", "", { fg: theme.text, wrapMode: "none" });
  actionRow.add(actionText);
  detailCard.add(emptyText);
  detailCard.add(tabRow);
  detailCard.add(bodyBox);
  detailCard.add(reviewBox);
  detailCard.add(actionRow);
  detailPanel.add(detailTitle);
  detailPanel.add(detailCard);
  panels.add(listPanel);
  panels.add(detailPanel);
  return { panels, listPanel, detailPanel, detailCard, listTitle, listText, listRows, detailTitle, emptyText, tabRow, tabs, bodyBox, questionText, optionBox, optionRows, reviewBox, reviewRows, actionRow, actionText };
}

export function questionItems(question) {
  return Array.isArray(question?.questions) ? question.questions : [];
}

export function questionItem(question, index) {
  const items = questionItems(question);
  return items[Math.max(0, Math.min(Math.max(0, items.length - 1), index))];
}

export function questionItemOptions(item) {
  return Array.isArray(item?.options) ? item.options : [];
}

export function questionAllowsCustom(item) {
  return item?.custom !== false;
}

export function questionSingle(question) {
  const items = questionItems(question);
  return items.length === 1 && items[0]?.multiple !== true;
}

export function questionTabCount(question) {
  const items = questionItems(question);
  return questionSingle(question) ? 1 : items.length + 1;
}

export function questionConfirm(question, tab) {
  const items = questionItems(question);
  return !questionSingle(question) && tab === items.length;
}

export function optionLabel(option) {
  return String(option?.label ?? option?.value ?? option ?? "").trim();
}

export function optionDescription(option) {
  return String(option?.description ?? "").trim();
}

export function selectedInboxInstance(inbox, index) {
  if (!inbox.length) return undefined;
  return inbox[Math.max(0, Math.min(inbox.length - 1, index))];
}

function answerText(values) {
  return Array.isArray(values) && values.length ? values.join(", ") : "(not answered)";
}

export function renderInboxScreen(screen, { inbox, inboxIndex, dialogQuestionIndex, dialogOptionIndex, dialogAnswers, customAnswer, dialogEditing, compactText }) {
  const selected = selectedInboxInstance(inbox, inboxIndex);
  screen.listTitle.content = `Inbox (${inbox.length})`;
  screen.listText.content = inbox.length ? "" : "No questions waiting.\nPending OpenCode dialogs appear here.";
  for (let index = 0; index < screen.listRows.length; index += 1) {
    const item = inbox[index];
    const row = screen.listRows[index];
    row.row.visible = !!item;
    if (!item) continue;
    const active = index === inboxIndex;
    const label = item.workspaceLabel || path.basename(item.cwd || "") || item.instanceId || "instance";
    const count = questionItems(item.question).length;
    row.row.backgroundColor = active ? theme.backgroundElement : theme.backgroundPanel;
    row.rowText.fg = active ? theme.text : theme.textMuted;
    row.rowText.content = `${active ? "›" : " "} ${label}\n  question ${count ? `1/${count}` : ""}  ${shortPath(item.cwd || "")}`;
  }
  screen.detailTitle.content = selected ? (selected.selectedSessionTitle || selected.selectedSessionId || selected.workspaceLabel || path.basename(selected.cwd || "") || "Question") : "Question";
  if (!selected) {
    screen.emptyText.content = "No questions waiting.";
    screen.emptyText.visible = true;
    screen.tabRow.visible = false;
    screen.bodyBox.visible = false;
    screen.reviewBox.visible = false;
    screen.actionRow.visible = false;
    return { selected, dialogQuestionIndex: 0, dialogOptionIndex: 0 };
  }
  screen.emptyText.visible = false;
  screen.detailCard.borderColor = theme.accent;
  const items = questionItems(selected.question);
  const tabCount = questionTabCount(selected.question);
  const nextDialogQuestionIndex = Math.max(0, Math.min(Math.max(0, tabCount - 1), dialogQuestionIndex));
  const confirm = questionConfirm(selected.question, nextDialogQuestionIndex);
  const item = items[nextDialogQuestionIndex];
  const options = questionItemOptions(item);
  const allowCustom = questionAllowsCustom(item);
  const rowCount = options.length + (allowCustom ? 1 : 0);
  const nextDialogOptionIndex = Math.max(0, Math.min(Math.max(0, rowCount - 1), dialogOptionIndex));
  const answers = Array.isArray(dialogAnswers?.[nextDialogQuestionIndex]) ? dialogAnswers[nextDialogQuestionIndex] : [];

  screen.tabRow.visible = !questionSingle(selected.question);
  for (let index = 0; index < screen.tabs.length; index += 1) {
    const tab = screen.tabs[index];
    const isConfirm = index === items.length;
    const tabItem = items[index];
    const visible = !questionSingle(selected.question) && index < tabCount;
    tab.tab.visible = visible;
    if (!visible) continue;
    const active = index === nextDialogQuestionIndex;
    const answered = isConfirm ? false : (Array.isArray(dialogAnswers[index]) && dialogAnswers[index].length > 0);
    tab.tab.backgroundColor = active ? theme.accent : theme.backgroundPanel;
    tab.tabText.fg = active ? theme.background : answered ? theme.text : theme.textMuted;
    tab.tabText.content = isConfirm ? "Confirm" : compactText(tabItem?.header || `Question ${index + 1}`, 18);
  }

  screen.bodyBox.visible = !confirm;
  screen.reviewBox.visible = confirm;
  screen.actionRow.visible = true;
  if (confirm) {
    for (let index = 0; index < screen.reviewRows.length; index += 1) {
      const row = screen.reviewRows[index];
      const reviewItem = items[index];
      row.visible = !!reviewItem;
      if (!reviewItem) continue;
      const values = dialogAnswers[index];
      const answered = Array.isArray(values) && values.length > 0;
      row.fg = answered ? theme.text : theme.error;
      row.content = `${reviewItem.header || `Question ${index + 1}`}: ${answerText(values)}`;
    }
    screen.actionText.content = "enter submit   esc dismiss";
    return { selected, dialogQuestionIndex: nextDialogQuestionIndex, dialogOptionIndex: nextDialogOptionIndex };
  }

  screen.questionText.content = `${item?.question || "Answer required"}${item?.multiple ? " (select all that apply)" : ""}`;
  const rows = options.map((option, index) => ({ type: "option", option, index })).concat(allowCustom ? [{ type: "custom", index: options.length }] : []);
  for (let index = 0; index < screen.optionRows.length; index += 1) {
    const row = screen.optionRows[index];
    const value = rows[index];
    row.row.visible = !!value;
    if (!value) continue;
    const active = value.index === nextDialogOptionIndex;
    const label = value.type === "custom" ? "Type your own answer" : optionLabel(value.option);
    const picked = value.type === "custom" ? !!customAnswer.trim() && answers.includes(customAnswer.trim()) : answers.includes(label);
    const description = value.type === "custom" ? (customAnswer ? compactText(customAnswer, 120) : dialogEditing && active ? "_" : "") : optionDescription(value.option);
    row.prefix.backgroundColor = active ? theme.backgroundElement : undefined;
    row.label.backgroundColor = active ? theme.backgroundElement : undefined;
    row.prefixText.fg = active ? theme.secondary : theme.textMuted;
    row.labelText.fg = active ? theme.secondary : picked ? theme.success : theme.text;
    row.prefixText.content = `${value.index + 1}.`;
    row.labelText.content = item?.multiple && value.type !== "custom" ? `[${picked ? "x" : " "}] ${label}` : item?.multiple && value.type === "custom" ? `[${picked ? "x" : " "}] ${label}` : label;
    row.checkText.content = !item?.multiple && picked ? " ✓" : "";
    row.descText.visible = !!description;
    row.descText.content = description ? `   ${description}` : "";
  }
  screen.actionText.content = dialogEditing ? "enter save   esc cancel" : `${questionSingle(selected.question) ? "" : "⇆ tab   "}↑↓ select   enter ${item?.multiple ? "toggle" : questionSingle(selected.question) ? "submit" : "confirm"}   esc dismiss`;
  return { selected, dialogQuestionIndex: nextDialogQuestionIndex, dialogOptionIndex: nextDialogOptionIndex };
}
