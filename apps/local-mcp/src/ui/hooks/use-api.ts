import { useCallback, useEffect, useRef, useState } from "react";
import type { ApprovalRequest, CredentialSummary, SessionInfo } from "../lib/types";

const POLL_INTERVAL = 3000;

async function fetchJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json() as Promise<T>;
}

function usePolling<T>(fetcher: () => Promise<T>, interval = POLL_INTERVAL) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);
  const requestIdRef = useRef(0);
  const refreshingRef = useRef(false);

  const refresh = useCallback(async () => {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    const requestId = ++requestIdRef.current;
    try {
      const result = await fetcher();
      if (mountedRef.current && requestId === requestIdRef.current) {
        setData(result);
        setError(null);
      }
    } catch (err) {
      if (mountedRef.current && requestId === requestIdRef.current) {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      refreshingRef.current = false;
    }
  }, [fetcher]);

  useEffect(() => {
    mountedRef.current = true;
    void refresh();
    const id = setInterval(() => void refresh(), interval);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [refresh, interval]);

  return { data, error, refresh };
}

export function useSession() {
  const fetcher = useCallback(() => fetchJson<SessionInfo>("/api/session"), []);
  return usePolling(fetcher, 30_000);
}

export function useApprovals() {
  const fetcher = useCallback(
    () => fetchJson<{ approvals: ApprovalRequest[] }>("/api/approvals").then((r) => r.approvals),
    [],
  );
  return usePolling(fetcher);
}

export function useCredentials() {
  const fetcher = useCallback(
    () => fetchJson<{ credentials: CredentialSummary[] }>("/api/credentials").then((r) => r.credentials),
    [],
  );
  return usePolling(fetcher);
}

export function useNonce() {
  const fetcher = useCallback(() => fetchJson<{ nonce: string }>("/api/nonce").then((r) => r.nonce), []);
  return usePolling(fetcher, 60_000);
}

export async function approveRequest(requestId: string, nonce: string): Promise<void> {
  const res = await fetch(`/api/approvals/${encodeURIComponent(requestId)}/approve`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ nonce }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((body.error as string) ?? `${res.status} ${res.statusText}`);
  }
}

export async function denyRequest(requestId: string, nonce: string): Promise<void> {
  const res = await fetch(`/api/approvals/${encodeURIComponent(requestId)}/deny`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ nonce }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((body.error as string) ?? `${res.status} ${res.statusText}`);
  }
}

export async function saveCredentialSecret(credentialId: string, value: string, nonce: string): Promise<void> {
  const res = await fetch(`/api/credentials/${encodeURIComponent(credentialId)}`, {
    method: "PUT",
    headers: {
      "content-type": "application/json",
      "x-tokenspace-nonce": nonce,
    },
    body: JSON.stringify({ value }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((body.error as string) ?? `${res.status} ${res.statusText}`);
  }
}

export async function deleteCredentialSecret(credentialId: string, nonce: string): Promise<void> {
  const res = await fetch(`/api/credentials/${encodeURIComponent(credentialId)}`, {
    method: "DELETE",
    headers: { "x-tokenspace-nonce": nonce },
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    throw new Error((body.error as string) ?? `${res.status} ${res.statusText}`);
  }
}
