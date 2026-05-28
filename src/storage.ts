import * as SecureStore from "expo-secure-store";
import { Platform } from "react-native";

export type ConnectionSettings = {
  baseUrl: string;
  username: string;
  password: string;
};

export type KeepAwakeMode = "auto" | "connected" | "off";

const key = "openremote.connection";
const activeSessionKey = "openremote.active-session";
const keepAwakeModeKey = "openremote.keep-awake-mode";

export async function loadConnection() {
  const value = await getItem(key);
  if (!value) return null;
  return JSON.parse(value) as ConnectionSettings;
}

export async function saveConnection(settings: ConnectionSettings) {
  await setItem(key, JSON.stringify(settings));
}

export async function clearConnection() {
  await deleteItem(key);
}

export async function loadActiveSession() {
  return getItem(activeSessionKey);
}

export async function saveActiveSession(sessionId: string) {
  await setItem(activeSessionKey, sessionId);
}

export async function clearActiveSession() {
  await deleteItem(activeSessionKey);
}

export async function loadKeepAwakeMode() {
  const value = await getItem(keepAwakeModeKey);
  if (value === "connected" || value === "off") return value;
  return "auto";
}

export async function saveKeepAwakeMode(mode: KeepAwakeMode) {
  await setItem(keepAwakeModeKey, mode);
}

async function getItem(storageKey: string) {
  if (Platform.OS === "web") return globalThis.localStorage?.getItem(storageKey) ?? null;
  return SecureStore.getItemAsync(storageKey);
}

async function setItem(storageKey: string, value: string) {
  if (Platform.OS === "web") {
    globalThis.localStorage?.setItem(storageKey, value);
    return;
  }
  await SecureStore.setItemAsync(storageKey, value);
}

async function deleteItem(storageKey: string) {
  if (Platform.OS === "web") {
    globalThis.localStorage?.removeItem(storageKey);
    return;
  }
  await SecureStore.deleteItemAsync(storageKey);
}
