"use client";

import { get, set, del } from "idb-keyval";
import { supabase } from "./supabase";

// ── Sync status ──────────────────────────────────────────────────────
export type SyncStatus = "idle" | "syncing" | "synced" | "error";

let currentSyncStatus: SyncStatus = "idle";
const statusListeners = new Set<(s: SyncStatus) => void>();

function emitSyncStatus(s: SyncStatus) {
  currentSyncStatus = s;
  statusListeners.forEach((fn) => fn(s));
}

export function getSyncStatus(): SyncStatus {
  return currentSyncStatus;
}

export function subscribeSyncStatus(fn: (s: SyncStatus) => void): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

// ── Debounced Supabase writes ────────────────────────────────────────
const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();

async function upsertWithRetry(key: string, value: unknown, attempts = 3): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const { error } = await supabase!
      .from("app_data")
      .upsert({ key, value, updated_at: new Date().toISOString() });
    if (!error) return;
    if (i < attempts - 1) {
      await new Promise((r) => setTimeout(r, 500 * 2 ** i)); // 500ms, 1s, 2s
    } else {
      throw error;
    }
  }
}

function scheduleSupabaseSync(key: string, value: unknown) {
  clearTimeout(pendingTimers.get(key));
  pendingTimers.set(
    key,
    setTimeout(async () => {
      emitSyncStatus("syncing");
      try {
        await upsertWithRetry(key, value);
        emitSyncStatus("synced");
        setTimeout(() => emitSyncStatus("idle"), 3000);
      } catch {
        emitSyncStatus("error");
      }
    }, 800),
  );
}

// ── Public API ───────────────────────────────────────────────────────

/**
 * Load state — Supabase is the source of truth when available.
 * Falls back to IndexedDB → localStorage for offline or pre-migration data.
 */
export async function loadSovereignValue<T>(key: string, fallback: T): Promise<T> {
  // 1. Try Supabase first (cloud, authoritative)
  if (supabase) {
    try {
      const { data, error } = await supabase
        .from("app_data")
        .select("value")
        .eq("key", key)
        .maybeSingle();

      if (!error && data?.value !== undefined) {
        await set(key, data.value).catch(() => {});
        return data.value as T;
      }
    } catch {
      // Network error — fall through to local cache
    }
  }

  // 2. Fall back to IndexedDB (local cache / offline)
  try {
    const indexed = await get<T>(key);
    if (indexed !== undefined) return indexed;

    // 3. Fall back to localStorage (legacy data from older versions)
    const localRaw = window.localStorage.getItem(key);
    if (localRaw) {
      const parsed = JSON.parse(localRaw) as T;
      await set(key, parsed).catch(() => {});
      return parsed;
    }
  } catch {
    try {
      const localRaw = window.localStorage.getItem(key);
      if (localRaw) return JSON.parse(localRaw) as T;
    } catch { /* give up */ }
  }

  return fallback;
}

/**
 * Save state — writes to IndexedDB immediately (fast, local cache),
 * then debounces and retries a sync to Supabase (cloud persistence).
 */
export async function saveSovereignValue<T>(key: string, value: T): Promise<void> {
  // Always write locally first so the UI never waits on the network
  await set(key, value);

  // localStorage best-effort cache
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  }

  // Debounced, retriable sync to Supabase — coalesces rapid state changes
  if (supabase) {
    scheduleSupabaseSync(key, value);
  }
}

export async function clearSovereignStore(key: string): Promise<void> {
  try { window.localStorage.removeItem(key); } catch { /* ignore */ }
  await del(key);

  if (supabase) {
    emitSyncStatus("syncing");
    try {
      const { error } = await supabase.from("app_data").delete().eq("key", key);
      if (error) throw error;
      emitSyncStatus("synced");
      setTimeout(() => emitSyncStatus("idle"), 3000);
    } catch {
      emitSyncStatus("error");
    }
  }
}
