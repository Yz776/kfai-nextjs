"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { login, setToken, collectDeviceFingerprint, startBehavioralTracking } from "@/lib/api-client";

type Props = {
  onLoggedIn: () => void;
};

export function LoginScreen({ onLoggedIn }: Props) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fpProgress, setFpProgress] = useState(0); // 0-100
  const [fpStage, setFpStage] = useState<string>("Menunggu");
  const [ready, setReady] = useState(false);
  // Honeypot — invisible to humans, bots fill it
  const [honeypot, setHoneypot] = useState("");
  // Time-trap: when the page was rendered. Submit must be > 1.5s after.
  const renderTsRef = useRef<number>(0);

  // ── Collect device fingerprint in background with progress display ──────────
  const collectFingerprint = useCallback(async () => {
    setFpStage("Memindai canvas");
    setFpProgress(15);
    await new Promise((r) => setTimeout(r, 200));

    setFpStage("Menganalisis WebGL + GPU");
    setFpProgress(30);
    await new Promise((r) => setTimeout(r, 200));

    setFpStage("Memeriksa audio device");
    setFpProgress(45);
    await new Promise((r) => setTimeout(r, 200));

    setFpStage("Mendeteksi font");
    setFpProgress(60);
    await new Promise((r) => setTimeout(r, 200));

    setFpStage("Mengukur presisi CPU");
    setFpProgress(75);
    await new Promise((r) => setTimeout(r, 200));

    setFpStage("Memverifikasi hardware + battery");
    setFpProgress(90);
    await new Promise((r) => setTimeout(r, 200));

    // Actually collect fingerprint (this is fast, the delays above are just UX)
    try {
      await collectDeviceFingerprint();
      setFpProgress(100);
      setFpStage("Perangkat terverifikasi");
      setReady(true);
    } catch (e: any) {
      setError("Gagal memverifikasi perangkat: " + (e?.message || "unknown"));
      setReady(true); // allow retry
    }
  }, []);

  useEffect(() => {
    // Start behavioral tracking immediately (mouse moves, key timings)
    startBehavioralTracking();
    // Reset time-trap
    renderTsRef.current = Date.now();
    // Collect fingerprint
    collectFingerprint();
  }, [collectFingerprint]);

  const onSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();

    // Honeypot check (client-side) — if filled, silent fail
    if (honeypot.trim().length > 0) return;

    if (!ready) return;

    // Time-trap: enforce min 1.5s elapsed (anti-instant-submit bot)
    const elapsed = Date.now() - renderTsRef.current;
    if (elapsed < 1500) {
      await new Promise((r) => setTimeout(r, 1500 - elapsed));
    }

    setSubmitting(true);
    setError(null);
    try {
      const r = await login(renderTsRef.current);
      setToken(r.token);
      onLoggedIn();
    } catch (e: any) {
      setError(e?.message || "Login gagal");
      // Re-collect fingerprint on failure
      collectFingerprint();
    } finally {
      setSubmitting(false);
    }
  }, [honeypot, ready, onLoggedIn, collectFingerprint]);

  return (
    <div className="kfai-login">
      <form className="kfai-login-card" onSubmit={onSubmit}>
        <div className="kfai-login-brand">
          <div className="kfai-mark">K</div>
          <div>
            <div className="kfai-login-title">KFAI</div>
            <div className="kfai-login-sub">{"// device-bound · anti-abuse"}</div>
          </div>
        </div>

        {/* ── Fingerprint collection progress ── */}
        <div className="kfai-login-section">
          <label className="kfai-login-label">Verifikasi Perangkat</label>
          <div className="kfai-fp-progress">
            <div
              className="kfai-fp-bar"
              style={{ width: `${fpProgress}%` }}
            />
          </div>
          <div className="kfai-fp-stage">
            {ready ? "✓" : "⟳"} {fpStage}
            {!ready && <span className="kfai-fp-spinner" />}
          </div>
          <div className="kfai-fp-signals">
            <span>Canvas</span>
            <span>WebGL2</span>
            <span>Audio</span>
            <span>Fonts</span>
            <span>Screen</span>
            <span>Battery</span>
            <span>Media</span>
            <span>Perf</span>
            <span>Behavior</span>
          </div>
        </div>

        {/* ── Honeypot field (hidden from humans, bots fill it) ── */}
        <input
          type="text"
          name="company"
          tabIndex={-1}
          autoComplete="off"
          aria-hidden="true"
          value={honeypot}
          onChange={(e) => setHoneypot(e.target.value)}
          style={{
            position: 'absolute',
            left: '-9999px',
            top: '-9999px',
            width: 1,
            height: 1,
            opacity: 0,
            pointerEvents: 'none',
          }}
        />

        <button
          type="submit"
          className="kfai-login-btn"
          disabled={submitting || !ready}
          title={ready ? "" : "Menunggu verifikasi perangkat..."}
        >
          {submitting ? "Memverifikasi..." : ready ? "Masuk" : "Memverifikasi perangkat..."}
        </button>

        {error && <div className="kfai-login-error">{error}</div>}

        <div className="kfai-login-hint">
          <b>1 IP = 1 session · Device-bound · No captcha</b>
          <br />
          Login diproteksi 40+ sinyal perangkat.<br />
          Tidak perlu captcha — fingerprint cukup.
        </div>
      </form>
    </div>
  );
}
