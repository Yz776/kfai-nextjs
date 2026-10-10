"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { fetchCaptcha, login, setToken, collectDeviceFingerprint } from "@/lib/api-client";

type Props = {
  onLoggedIn: () => void;
};

export function LoginScreen({ onLoggedIn }: Props) {
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [captchaSvg, setCaptchaSvg] = useState<string | null>(null);
  const [answer, setAnswer] = useState("");
  const [loadingCaptcha, setLoadingCaptcha] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Honeypot — invisible to humans, bots fill it
  const [honeypot, setHoneypot] = useState("");
  // Time-trap: when the captcha was rendered. Submit must be > 2s after.
  const renderTsRef = useRef<number>(0);
  // Pre-warm device fingerprint while user looks at captcha
  const [fpReady, setFpReady] = useState(false);

  const loadCaptcha = useCallback(async () => {
    setLoadingCaptcha(true);
    setError(null);
    setAnswer("");
    try {
      const c = await fetchCaptcha();
      setChallengeId(c.challengeId);
      setCaptchaSvg(c.svg);
      // Reset the time-trap — start counting from when the new captcha renders
      renderTsRef.current = Date.now();
    } catch (e: any) {
      setError(e?.message || "Gagal memuat captcha");
    } finally {
      setLoadingCaptcha(false);
    }
  }, []);

  useEffect(() => {
    // Pre-compute device fingerprint in the background while captcha loads.
    // This is invisible to the user but ensures the fingerprint is ready
    // by the time they submit.
    collectDeviceFingerprint().then(() => setFpReady(true)).catch(() => setFpReady(true));
    loadCaptcha();
  }, [loadCaptcha]);

  const onSubmit = useCallback(async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!challengeId) return;
    const ans = answer.trim();
    if (!ans) {
      setError("Jawaban captcha kosong");
      return;
    }
    // ── Honeypot check (client-side) — if filled, do nothing (silent fail) ──
    if (honeypot.trim().length > 0) {
      // Bot detected — pretend success but don't send anything
      return;
    }
    // ── Time-trap: enforce min 2s elapsed ──
    const elapsed = Date.now() - renderTsRef.current;
    if (elapsed < 2000) {
      // Wait the remaining time before submitting
      await new Promise((r) => setTimeout(r, 2000 - elapsed));
    }

    setSubmitting(true);
    setError(null);
    try {
      const r = await login(challengeId, ans, renderTsRef.current);
      setToken(r.token);
      onLoggedIn();
    } catch (e: any) {
      setError(e?.message || "Login gagal");
      loadCaptcha();
    } finally {
      setSubmitting(false);
    }
  }, [challengeId, answer, honeypot, onLoggedIn, loadCaptcha]);

  return (
    <div className="kfai-login">
      <form className="kfai-login-card" onSubmit={onSubmit}>
        <div className="kfai-login-brand">
          <div className="kfai-mark">K</div>
          <div>
            <div className="kfai-login-title">KFAI</div>
            <div className="kfai-login-sub">{"// captcha-verified · device-bound"}</div>
          </div>
        </div>

        <div className="kfai-login-section">
          <label className="kfai-login-label">Verifikasi Captcha</label>
          <div className="kfai-captcha-box">
            {loadingCaptcha || !captchaSvg ? (
              <span className="kfai-captcha-loading">memuat captcha…</span>
            ) : (
              <span
                dangerouslySetInnerHTML={{ __html: captchaSvg }}
              />
            )}
          </div>
          <button
            type="button"
            className="kfai-captcha-refresh"
            onClick={loadCaptcha}
            tabIndex={-1}
          >
            ↻ refresh captcha
          </button>
          <input
            type="text"
            inputMode="numeric"
            autoFocus
            className={`kfai-login-input ${error ? "error" : ""}`}
            placeholder="jawaban (angka)"
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            disabled={submitting}
            aria-label="Captcha answer"
            autoComplete="off"
          />
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
          disabled={submitting || loadingCaptcha || !challengeId || !fpReady}
          title={fpReady ? "" : "menyiapkan verifikasi perangkat…"}
        >
          {submitting ? "memverifikasi…" : fpReady ? "verifikasi & masuk" : "menyiapkan…"}
        </button>

        {error && <div className="kfai-login-error">{error}</div>}

        <div className="kfai-login-hint">
          <b>1 IP = 1 session · Device-bound · Anti-scraping</b>
          <br />
          Setiap user memiliki environment terisolasi.<br />
          History pesan tersimpan per user.
        </div>
      </form>
    </div>
  );
}
