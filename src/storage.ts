import * as SecureStore from "expo-secure-store";

export type ConnectionSettings = {
  baseUrl: string;
  username: string;
  password: string;
};

const key = "openremote.connection";
const activeSessionKey = "openremote.active-session";

export async function loadConnection() {
  const value = await SecureStore.getItemAsync(key);
  if (!value) return null;
  return JSON.parse(value) as ConnectionSettings;
}

export async function saveConnection(settings: ConnectionSettings) {
  await SecureStore.setItemAsync(key, JSON.stringify(settings));
}

export async function clearConnection() {
  await SecureStore.deleteItemAsync(key);
}

export async function loadActiveSession() {
  return SecureStore.getItemAsync(activeSessionKey);
}

export async function saveActiveSession(sessionId: string) {
  await SecureStore.setItemAsync(activeSessionKey, sessionId);
}

export async function clearActiveSession() {
  await SecureStore.deleteItemAsync(activeSessionKey);
}
