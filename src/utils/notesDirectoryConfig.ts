import { config } from "../../package.json";

// Pref keys: path/folder/attachments use old obsidian keys for backward compat
// with existing user data. Nickname is a new key.
const NOTES_DIR_PATH_KEY = `${config.prefsPrefix}.obsidianVaultPath`;
const NOTES_DIR_FOLDER_KEY = `${config.prefsPrefix}.obsidianTargetFolder`;
const NOTES_DIR_ATTACHMENTS_KEY = `${config.prefsPrefix}.obsidianAttachmentsFolder`;
const NOTES_DIR_NICKNAME_KEY = `${config.prefsPrefix}.notesDirectoryNickname`;

function getPrefValue(key: string): unknown {
  if (typeof Zotero === "undefined" || !Zotero.Prefs?.get) return undefined;
  return Zotero.Prefs.get(key, true);
}

function setPrefValue(key: string, value: string): void {
  if (typeof Zotero === "undefined" || !Zotero.Prefs?.set) return;
  Zotero.Prefs.set(key, value, true);
}

export function getNotesDirectoryPath(): string {
  const value = getPrefValue(NOTES_DIR_PATH_KEY);
  return typeof value === "string" ? value : "";
}

export function setNotesDirectoryPath(value: string): void {
  setPrefValue(NOTES_DIR_PATH_KEY, value);
}

export function getNotesDirectoryFolder(): string {
  const value = getPrefValue(NOTES_DIR_FOLDER_KEY);
  return typeof value === "string" ? value : "Zotero Notes";
}

export function setNotesDirectoryFolder(value: string): void {
  setPrefValue(NOTES_DIR_FOLDER_KEY, value);
}

export function getNotesDirectoryAttachmentsFolder(): string {
  const value = getPrefValue(NOTES_DIR_ATTACHMENTS_KEY);
  return typeof value === "string" ? value : "assets";
}

export function setNotesDirectoryAttachmentsFolder(value: string): void {
  setPrefValue(NOTES_DIR_ATTACHMENTS_KEY, value);
}

export function getNotesDirectoryNickname(): string {
  const value = getPrefValue(NOTES_DIR_NICKNAME_KEY);
  return typeof value === "string" ? value : "";
}

export function setNotesDirectoryNickname(value: string): void {
  setPrefValue(NOTES_DIR_NICKNAME_KEY, value);
}

export function isNotesDirectoryConfigured(): boolean {
  return getNotesDirectoryPath().trim().length > 0;
}
