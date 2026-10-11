"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { login, setToken, collectDeviceFingerprint, startBehavioralTracking } from "@/lib/api-client";

type Props = {
  onLoggedIn: () => void;
};

export function LoginScreen({ onLoggedIn }: Props) {
  const [progress, setProgress] = useState(0);
  const [stage, setStage] = useState("Memulai verifikasi...");
  const [error, setError] = useState<string | null>(null);
  const renderTsRef = useRef<number>(0);
  const loginAttemptedRef = useRef(false);
  const retryCountRef = useRef(0);
  const onLoggedInRef = useRef(onLoggedIn);
  onLoggedInRef.current = onLoggedIn;

  // ── Collect fingerprint + auto-login (no button click needed) ───────────────
  const runAutoLogin = useCallback(async () => {
    setError(null);
    retryCountRef.current++;

    // Collect fingerprint in background while showing progress
    setStage("Memindai canvas + GPU");
    setProgress(10);
    const fpPromise = collectDeviceFingerprint();

    // Animate progress while fingerprint collects
    const stages: [string, number][] = [
      ["Menganalisis WebGL + shader", 25],
      ["Memeriksa audio + codec", 40],
      ["Mendeteksi font + media", 55],
      ["Memverifikasi hardware + sensors", 70],
      ["Mengukur presisi CPU", 82],
      ["Memverifikasi jaringan + perilaku", 92],
    ];
    for (const [label, pct] of stages) {
      setStage(label);
      setProgress(pct);
      await new Promise((r) => setTimeout(r, 100));
    }

    // Wait for fingerprint (10s timeout)
    try {
      await Promise.race([
        fpPromise,
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10000)),
      ]);
      setProgress(100);
      setStage("Perangkat terverifikasi");

      if (loginAttemptedRef.current) return;
      loginAttemptedRef.current = true;

      // Wait for time-trap minimum (1.5s)
      const elapsed = Date.now() - renderTsRef.current;
      if (elapsed < 1500) {
        await new Promise((r) => setTimeout(r, 1500 - elapsed));
      }

      setStage("Masuk...");
      const r = await login(renderTsRef.current);
      setToken(r.token);
      onLoggedInRef.current();
    } catch (e: any) {
      const msg = e?.message || "Gagal verifikasi perangkat";
      setError(msg);
      // Retry up to 3 times, then show manual retry button
      if (retryCountRef.current < 3) {
        setStage("Mencoba lagi...");
        loginAttemptedRef.current = false;
        setTimeout(() => runAutoLogin(), 2000);
      } else {
        setStage("Gagal — klik untuk coba lagi");
      }
    }
  }, []);

  useEffect(() => {
    startBehavioralTracking();
    renderTsRef.current = Date.now();
    runAutoLogin();
  }, [runAutoLogin]);

  const manualRetry = () => {
    retryCountRef.current = 0;
    loginAttemptedRef.current = false;
    runAutoLogin();
  };

  return (
    <div className="kfai-login">
      <div className="kfai-login-card" style={{ textAlign: "center" }}>
        <div className="kfai-login-brand" style={{ justifyContent: "center", marginBottom: 28 }}>
          <div className="kfai-mark">K</div>
          <div>
            <div className="kfai-login-title">KFAI</div>
            <div className="kfai-login-sub">{"// device-bound"}</div>
          </div>
        </div>

        {/* Progress bar */}
        <div className="kfai-fp-progress">
          <div className="kfai-fp-bar" style={{ width: `${progress}%` }} />
        </div>

        {/* Stage indicator */}
        <div className="kfai-fp-stage" style={{ justifyContent: "center" }}>
          {progress < 100 && !error && <span className="kfai-fp-spinner" />}
          {progress === 100 && !error && <span style={{ color: "#10b981" }}>✓</span>}
          {error && retryCountRef.current >= 3 && <span style={{ color: "#f59e0b" }}>⚠</span>}
          <span>{stage}</span>
        </div>

        {/* Signal chips */}
        <div className="kfai-fp-signals" style={{ justifyContent: "center" }}>
          <span>Canvas</span>
          <span>WebGL</span>
          <span>Audio</span>
          <span>Fonts</span>
          <span>Screen</span>
          <span>Media</span>
          <span>WebRTC</span>
          <span>Behavior</span>
        </div>

        {/* Manual retry button — appears after 3 failed attempts */}
        {error && retryCountRef.current >= 3 && (
          <button
            onClick={manualRetry}
            style={{
              marginTop: 16,
              background: "#f59e0b",
              color: "#0a0a0b",
              border: "none",
              borderRadius: 6,
              padding: "10px 24px",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              fontFamily: "monospace",
              textTransform: "uppercase",
            }}
          >
            Coba Lagi
          </button>
        )}

        {error && retryCountRef.current < 3 && (
          <div className="kfai-login-error" style={{ marginTop: 12 }}>
            {error}
          </div>
        )}

        <div className="kfai-login-hint" style={{ marginTop: 20 }}>
          <b>Verifikasi otomatis · 1 IP = 1 session</b>
          <br />
          Tidak perlu klik — verifikasi perangkat berjalan otomatis.
        </div>
      </div>
    </div>
  );
}
