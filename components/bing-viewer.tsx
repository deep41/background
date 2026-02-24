"use client";

import type { TransitionEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const BASE_URL = "https://bing.npanuhin.me/US/en";
const HIDE_DELAY_MS = 2500;
const PRELOAD_OFFSETS = [-2, -1, 1, 2] as const;
const SLIDE_DURATION_MS = 150;
const DAY_MS = 24 * 60 * 60 * 1000;
const SLOT_COUNT = 5;
const SLOT_CENTER_INDEX = 2;

type ImageSlot = {
  id: number;
  date: string | null;
  url: string | null;
};

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function formatUtcDate(date: Date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(
    date.getUTCDate(),
  )}`;
}

/**
 * The archive publishes each day's wallpaper at 08:02 UTC.
 * We add a 5-minute buffer (08:07 UTC) before treating today as available.
 * Before that cutoff, yesterday is the latest available date.
 */
const ARCHIVE_READY_UTC_HOUR = 8;
const ARCHIVE_READY_UTC_MINUTE = 7;

function getLatestAvailableDate(): string {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const todayReady =
    utcH > ARCHIVE_READY_UTC_HOUR ||
    (utcH === ARCHIVE_READY_UTC_HOUR && utcM >= ARCHIVE_READY_UTC_MINUTE);
  if (!todayReady) {
    // Today's image not published yet — fall back to yesterday in UTC
    const yesterday = new Date(now);
    yesterday.setUTCDate(yesterday.getUTCDate() - 1);
    return formatUtcDate(yesterday);
  }
  return formatUtcDate(now);
}

function parseDateString(value: string) {
  return new Date(`${value}T00:00:00Z`);
}

function shiftDate(value: string, days: number) {
  const date = parseDateString(value);
  date.setUTCDate(date.getUTCDate() + days);
  return formatUtcDate(date);
}

function formatLabel(value: string) {
  const date = parseDateString(value);
  return new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function getImageUrl(date: string) {
  return `${BASE_URL}/${date}.jpg`;
}

function diffDays(fromDate: string, toDate: string) {
  return Math.round(
    (parseDateString(toDate).getTime() - parseDateString(fromDate).getTime()) / DAY_MS,
  );
}

function mod(value: number, base: number) {
  return ((value % base) + base) % base;
}

function getRingOffset(index: number, activeIndex: number) {
  let offset = index - activeIndex;
  if (offset > SLOT_CENTER_INDEX) offset -= SLOT_COUNT;
  if (offset < -SLOT_CENTER_INDEX) offset += SLOT_COUNT;
  return offset;
}

function buildSlotsForActive(
  activeIndex: number,
  activeDate: string,
  today: string,
  prevSlots?: ImageSlot[],
) {
  return Array.from({ length: SLOT_COUNT }, (_, index) => {
    const offset = getRingOffset(index, activeIndex);
    const candidate = shiftDate(activeDate, offset);
    const date = candidate > today ? null : candidate;
    const url = date ? getImageUrl(date) : null;
    const prev = prevSlots?.[index];
    if (prev && prev.date === date && prev.url === url) return prev;
    return { id: prev?.id ?? index, date, url };
  });
}

function isValidDateParam(value: string | null, today: string): value is string {
  return Boolean(value && /^\d{4}-\d{2}-\d{2}$/.test(value) && value <= today);
}

export function BingViewer() {
  const today = useMemo(() => getLatestAvailableDate(), []);

  const [selectedDate, setSelectedDate] = useState(() => {
    if (typeof window === "undefined") return today;
    const param = new URLSearchParams(window.location.search).get("date");
    return isValidDateParam(param, today) ? param : today;
  });

  // On mount, sync selected date from the browser URL (pure React + browser API).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const param = params.get("date");
    if (isValidDateParam(param, today)) {
      if (param !== selectedDate) setSelectedDate(param);
    } else {
      window.history.replaceState(null, "", `?date=${selectedDate}`);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [today]);

  useEffect(() => {
    const onPopState = () => {
      const param = new URLSearchParams(window.location.search).get("date");
      setSelectedDate(isValidDateParam(param, today) ? param : today);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [today]);

  const [slots, setSlots] = useState<ImageSlot[]>(() =>
    buildSlotsForActive(SLOT_CENTER_INDEX, selectedDate, today),
  );
  const [activeSlotIndex, setActiveSlotIndex] = useState(SLOT_CENTER_INDEX);
  const [imageError, setImageError] = useState(false);
  const [isImageLoading, setIsImageLoading] = useState(false);
  const [visible, setVisible] = useState(true);
  const [isTrackAnimating, setIsTrackAnimating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const preloadCacheRef = useRef<Map<string, Promise<void>>>(new Map());
  const pendingSlideTargetRef = useRef<string | null>(null);
  const dateRef = useRef(selectedDate);
  useEffect(() => { dateRef.current = selectedDate; }, [selectedDate]);
  const displayedDate = slots[activeSlotIndex]?.date ?? selectedDate;
  const dateLabel = useMemo(() => formatLabel(displayedDate), [displayedDate]);

  const preloadDateImage = useCallback(
    (date: string, priority: "high" | "low" = "low") => {
      const url = getImageUrl(date);
      const cached = preloadCacheRef.current.get(url);
      if (cached) return cached;

      const request = new Promise<void>((resolve, reject) => {
        const img = new window.Image();
        img.decoding = "async";
        img.fetchPriority = priority;
        img.onload = () => {
          const decodePromise =
            typeof img.decode === "function" ? img.decode() : Promise.resolve();
          decodePromise.catch(() => undefined).finally(resolve);
        };
        img.onerror = () => reject(new Error(`Failed to preload ${url}`));
        img.src = url;
      });

      const tracked = request.catch((error) => {
        preloadCacheRef.current.delete(url);
        throw error;
      });
      preloadCacheRef.current.set(url, tracked);
      return tracked;
    },
    [],
  );

  // Preload/decode the requested image before switching the visible slot.
  useEffect(() => {
    if (!displayedDate || selectedDate === displayedDate || isTrackAnimating) return;

    let active = true;
    setIsImageLoading(true);
    const offsetFromDisplayed = diffDays(displayedDate, selectedDate);
    const canSlide = offsetFromDisplayed === -1 || offsetFromDisplayed === 1;

    void preloadDateImage(selectedDate, "high")
      .then(() => {
        if (!active) return;
        setImageError(false);
        if (canSlide) {
          const targetSlotIndex = mod(
            activeSlotIndex + (offsetFromDisplayed > 0 ? 1 : -1),
            SLOT_COUNT,
          );
          if (slots[targetSlotIndex]?.date !== selectedDate) {
            setSlots((prev) =>
              buildSlotsForActive(activeSlotIndex, selectedDate, today, prev),
            );
            return;
          }

          pendingSlideTargetRef.current = selectedDate;
          setIsTrackAnimating(true);
          setActiveSlotIndex(targetSlotIndex);
          return;
        }
        setSlots((prev) =>
          buildSlotsForActive(activeSlotIndex, selectedDate, today, prev),
        );
      })
      .catch(() => {
        if (!active) return;
        setImageError(true);
        setSlots((prev) =>
          buildSlotsForActive(activeSlotIndex, selectedDate, today, prev),
        );
      })
      .finally(() => {
        if (!active) return;
        setIsImageLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    activeSlotIndex,
    displayedDate,
    isTrackAnimating,
    preloadDateImage,
    selectedDate,
    slots,
    today,
  ]);

  // Keep near neighbors hot. ±1 is eager/high priority, ±2 stays warm in the background.
  useEffect(() => {
    if (!displayedDate) return;
    PRELOAD_OFFSETS.forEach((offset) => {
      const candidate = shiftDate(displayedDate, offset);
      if (candidate > today) return;
      void preloadDateImage(candidate, Math.abs(offset) === 1 ? "high" : "low").catch(
        () => undefined,
      );
    });
  }, [displayedDate, preloadDateImage, today]);

  const resetHideTimer = useCallback(() => {
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
  }, []);

  useEffect(() => {
    timerRef.current = setTimeout(() => setVisible(false), HIDE_DELAY_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleSlideTransitionEnd = useCallback(
    (e: TransitionEvent<HTMLDivElement>) => {
      if (e.target !== e.currentTarget || e.propertyName !== "transform") return;
      if (!isTrackAnimating) return;

      const targetDate = pendingSlideTargetRef.current;
      pendingSlideTargetRef.current = null;
      if (!targetDate) {
        setIsTrackAnimating(false);
        return;
      }

      setSlots((prev) => buildSlotsForActive(activeSlotIndex, targetDate, today, prev));
      setIsTrackAnimating(false);
    },
    [activeSlotIndex, isTrackAnimating, today],
  );

  /** Update state and silently reflect the date in the URL (no re-render). */
  const navigateTo = useCallback((newDate: string) => {
    if (newDate > today) return;
    setImageError(false);
    setSelectedDate(newDate);
    window.history.replaceState(null, "", `?date=${newDate}`);
  }, [today]);

  const goToPrev = useCallback(() => {
    const next = shiftDate(dateRef.current, -1);
    navigateTo(next);
  }, [navigateTo]);

  const goToNext = useCallback(() => {
    const next = shiftDate(dateRef.current, 1);
    navigateTo(next);
  }, [navigateTo]);

  const warmPrev = useCallback(() => {
    const prev = shiftDate(displayedDate, -1);
    void preloadDateImage(prev, "high").catch(() => undefined);
  }, [displayedDate, preloadDateImage]);

  const warmNext = useCallback(() => {
    const next = shiftDate(displayedDate, 1);
    if (next > today) return;
    void preloadDateImage(next, "high").catch(() => undefined);
  }, [displayedDate, preloadDateImage, today]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowLeft") { goToPrev(); resetHideTimer(); }
      else if (e.key === "ArrowRight") { goToNext(); resetHideTimer(); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goToPrev, goToNext, resetHideTimer]);

  const ctrl = visible
    ? "opacity-100 pointer-events-auto"
    : "opacity-0 pointer-events-none";

  return (
    <div
      className="relative w-screen h-screen overflow-hidden bg-black"
      onMouseMove={resetHideTimer}
      style={{ cursor: visible ? "default" : "none" }}
    >
      {/* 5 stable slots act as a ring buffer around the active image */}
      <div className="absolute inset-0 overflow-hidden z-0">
        {slots.map((slot, index) => {
          const offset = getRingOffset(index, activeSlotIndex);
          const isActiveSlot = offset === 0;
          const absOffset = Math.abs(offset);
          const transition =
            isTrackAnimating
              ? `transform ${SLIDE_DURATION_MS}ms cubic-bezier(0.22, 1, 0.36, 1)`
              : "none";

          return (
            <div
              key={slot.id}
              className="absolute inset-0 bg-black will-change-transform"
              onTransitionEnd={isTrackAnimating && isActiveSlot ? handleSlideTransitionEnd : undefined}
              style={{
                transform: `translate3d(${offset * 100}vw, 0, 0)`,
                transition,
                zIndex: 1 + (SLOT_CENTER_INDEX - absOffset),
              }}
            >
              {slot.url && (
                <img
                  src={slot.url}
                  alt={`Bing wallpaper for ${slot.date}`}
                  loading={isActiveSlot || absOffset === 1 ? "eager" : "lazy"}
                  decoding="async"
                  fetchPriority={isActiveSlot || absOffset === 1 ? "high" : "low"}
                  draggable={false}
                  className="absolute inset-0 h-full w-full object-cover select-none"
                  onError={isActiveSlot ? () => setImageError(true) : undefined}
                  onLoad={isActiveSlot ? () => setImageError(false) : undefined}
                />
              )}
            </div>
          );
        })}
      </div>

      {/* Error state */}
      {imageError && (
        <div className="absolute inset-0 z-40 grid place-items-center bg-black/60 text-center px-6">
          <div className="space-y-1">
            <p className="text-sm font-medium text-white">No image available for this date.</p>
            <p className="font-mono text-xs text-white/40">Use arrows or the date picker to navigate.</p>
          </div>
        </div>
      )}

      {/* Bottom gradient vignette */}
      <div
        className={`absolute inset-x-0 bottom-0 z-20 h-52 bg-gradient-to-t from-black/75 via-black/20 to-transparent transition-opacity duration-700 ${ctrl}`}
      />

      {isImageLoading && selectedDate !== displayedDate && (
        <div className="absolute top-7 left-1/2 z-30 -translate-x-1/2 rounded-full border border-white/15 bg-black/45 px-3 py-1.5 text-[10px] uppercase tracking-[0.22em] text-white/75 backdrop-blur-md">
          Loading {selectedDate}
        </div>
      )}

      {/* Bottom bar — title + date picker */}
      <div
        className={`absolute inset-x-0 bottom-0 z-30 flex items-end justify-between px-10 pb-9 transition-all duration-700 ${ctrl} ${visible ? "translate-y-0" : "translate-y-3"}`}
      >
        <div>
          <p className="text-[9px] uppercase tracking-[0.35em] text-white/40 mb-1.5">
            Bing Wallpaper
          </p>
          <h1 className="text-2xl font-light text-white tracking-wide leading-none">
            {dateLabel}
          </h1>
        </div>

        <input
          type="date"
          value={selectedDate}
          onChange={(e) => {
            if (!e.target.value) return;
            navigateTo(e.target.value);
          }}
          className="bg-white/10 backdrop-blur-md text-white/80 text-xs px-3 py-2 rounded-lg outline-none focus:bg-white/15 transition-colors [color-scheme:dark]"
        />
      </div>

      {/* Left arrow */}
      <button
        onClick={() => { goToPrev(); resetHideTimer(); }}
        aria-label="Previous day (←)"
        onMouseEnter={warmPrev}
        onFocus={warmPrev}
        className={`group absolute left-5 top-1/2 z-30 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md text-white/70 hover:bg-white/20 hover:text-white transition-all duration-700 ${ctrl} ${visible ? "translate-x-0" : "-translate-x-3"}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M15 18l-6-6 6-6" />
        </svg>
      </button>

      {/* Right arrow */}
      <button
        onClick={() => { goToNext(); resetHideTimer(); }}
        aria-label="Next day (→)"
        onMouseEnter={warmNext}
        onFocus={warmNext}
        className={`group absolute right-5 top-1/2 z-30 -translate-y-1/2 w-11 h-11 flex items-center justify-center rounded-full bg-white/10 backdrop-blur-md text-white/70 hover:bg-white/20 hover:text-white transition-all duration-700 ${ctrl} ${visible ? "translate-x-0" : "translate-x-3"}`}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 18l6-6-6-6" />
        </svg>
      </button>

      {/* Keyboard hint — top right */}
      <div
        className={`absolute top-7 right-9 z-30 text-[9px] uppercase tracking-[0.3em] text-white/25 transition-all duration-700 ${ctrl} ${visible ? "translate-y-0" : "-translate-y-2"}`}
      >
        ← → to navigate
      </div>
    </div>
  );
}
