"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const ITEM_HEIGHT = 44;
const SHOT_OPTIONS = ["M", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "X"] as const;

function tokenToScore(token: string): number {
  if (token === "M") return 0;
  if (token === "X") return 10;
  return Number(token);
}

interface ShotWheelPickerProps {
  value: string;
  label: string;
  disabled?: boolean;
  onOpenAttempt?: () => boolean;
  onChange: (next: { value: string; score: number }) => void;
}

export function ShotWheelPicker({ value, label, disabled = false, onOpenAttempt, onChange }: ShotWheelPickerProps) {
  const [open, setOpen] = useState(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const scrollDebounceRef = useRef<number | null>(null);
  const lastHapticIndexRef = useRef<number>(0);
  const currentValue = value || "M";

  const currentIndex = useMemo(() => {
    const idx = SHOT_OPTIONS.indexOf(currentValue as (typeof SHOT_OPTIONS)[number]);
    return idx >= 0 ? idx : 0;
  }, [currentValue]);

  useEffect(() => {
    if (!open || !viewportRef.current) return;
    viewportRef.current.scrollTo({ top: currentIndex * ITEM_HEIGHT, behavior: "auto" });
    lastHapticIndexRef.current = currentIndex;
  }, [open, currentIndex]);

  useEffect(() => {
    return () => {
      if (scrollDebounceRef.current) {
        window.clearTimeout(scrollDebounceRef.current);
      }
    };
  }, []);

  function triggerHaptic() {
    if (typeof navigator === "undefined") return;
    if (typeof navigator.vibrate !== "function") return;
    navigator.vibrate(8);
  }

  function commitByIndex(index: number) {
    const safeIndex = Math.max(0, Math.min(SHOT_OPTIONS.length - 1, index));
    const nextValue = SHOT_OPTIONS[safeIndex];
    onChange({ value: nextValue, score: tokenToScore(nextValue) });
  }

  function handleScroll() {
    if (!viewportRef.current) return;
    const index = Math.round(viewportRef.current.scrollTop / ITEM_HEIGHT);
    if (index !== lastHapticIndexRef.current) {
      lastHapticIndexRef.current = index;
      triggerHaptic();
    }

    if (scrollDebounceRef.current) {
      window.clearTimeout(scrollDebounceRef.current);
    }
    scrollDebounceRef.current = window.setTimeout(() => {
      if (!viewportRef.current) return;
      const index = Math.round(viewportRef.current.scrollTop / ITEM_HEIGHT);
      viewportRef.current.scrollTo({ top: index * ITEM_HEIGHT, behavior: "smooth" });
      commitByIndex(index);
    }, 110);
  }

  return (
    <div>
      <button
        className="shot-wheel-trigger"
        onClick={() => {
          if (onOpenAttempt && !onOpenAttempt()) return;
          setOpen(true);
        }}
        aria-haspopup="dialog"
        aria-label={label}
        disabled={disabled}
      >
        {currentValue}
      </button>

      <label className="sr-only">
        {label}
        <select
          value={currentValue}
          disabled={disabled}
          onChange={(event) => {
            const nextValue = event.target.value;
            onChange({ value: nextValue, score: tokenToScore(nextValue) });
          }}
        >
          {SHOT_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </label>

      {open ? (
        <div className="wheel-overlay" role="dialog" aria-modal="true" aria-label={`${label} picker`}>
          <button className="wheel-backdrop" type="button" onClick={() => setOpen(false)} aria-label="Close picker" />
          <div className="wheel-sheet">
            <div className="wheel-header">
              <p>{label}</p>
            </div>
            <div className="wheel-viewport" ref={viewportRef} onScroll={handleScroll}>
              {SHOT_OPTIONS.map((option, index) => (
                <button
                  key={option}
                  type="button"
                  className={`wheel-item ${currentValue === option ? "active" : ""}`}
                  onClick={() => {
                    if (!viewportRef.current) return;
                    viewportRef.current.scrollTo({ top: index * ITEM_HEIGHT, behavior: "smooth" });
                    commitByIndex(index);
                    triggerHaptic();
                    setOpen(false);
                  }}
                >
                  {option}
                </button>
              ))}
            </div>
            <div className="wheel-focus-band" aria-hidden="true" />
          </div>
        </div>
      ) : null}
    </div>
  );
}
