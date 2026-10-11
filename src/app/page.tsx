"use client";

import { useEffect, useState, useCallback } from "react";
import { LoginScreen } from "@/components/LoginScreen";
import { ChatApp } from "@/components/ChatApp";
import { fetchMe, logout as apiLogout, type AuthMe } from "@/lib/api-client";

// ── Loading state ──────────────────────────────────────────────────────────────
function FullScreenLoader() {
  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0b",
        color: "#71717a",
        fontFamily: "var(--font-mono), monospace",
        fontSize: "12px",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div className="kfai-mark" style={{ margin: "0 auto 10px", width: 28, height: 28, fontSize: 15 }}>K</div>
        memuat KFAI…
      </div>
    </div>
  );
}

export default function Page() {
  const [bootState, setBootState] = useState<"loading" | "anonymous" | "authed">("loading");
  const [me, setMe] = useState<AuthMe | null>(null);

  // ── Bootstrap: check if we have a valid token ──────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const user = await fetchMe();
        if (cancelled) return;
        if (user) {
          setMe(user);
          setBootState("authed");
        } else {
          setBootState("anonymous");
        }
      } catch {
        if (!cancelled) setBootState("anonymous");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // ── Login success handler ──────────────────────────────────────────────────
  const onLoggedIn = useCallback(async () => {
    const user = await fetchMe();
    if (user) {
      setMe(user);
      setBootState("authed");
    } else {
      setBootState("anonymous");
    }
  }, []);

  // ── Logout handler ──────────────────────────────────────────────────────────
  const onLogout = useCallback(async () => {
    await apiLogout();
    setMe(null);
    setBootState("anonymous");
  }, []);

  if (bootState === "loading") return <FullScreenLoader />;
  if (bootState === "anonymous" || !me) return <LoginScreen onLoggedIn={onLoggedIn} />;
  return <ChatApp me={me} onLogout={onLogout} />;
}
