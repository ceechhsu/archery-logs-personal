"use client";

import { CSSProperties, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import { dateIsoInSf, sfMonthLabel } from "@/lib/date-utils";
import { lifetimeStats, sessionArrows, sessionAvgPerArrow, sessionTotal } from "@/lib/metrics";
import { ShotWheelPicker } from "@/components/shot-wheel-picker";
import { End, Session, UserProfile } from "@/lib/types";
import { useArcheryApp } from "@/lib/use-archery-app";
import { reverseGeocode, uploadEndPhoto, type UploadProgress } from "@/lib/client-api";
import { shopProducts } from "@/lib/shop-products";

type Tab = "editor" | "shop" | "analytics" | "account";
type ViewMode = "dashboard" | Tab;

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="stat-card">
      <p>{label}</p>
      <strong>{value}</strong>
    </div>
  );
}

function addEnd(session: Session): Session {
  const nextIndex = session.ends.length + 1;
  const sessionShotsCount = session.ends[0]?.shots.length || 5;
  const sessionDistanceMeters = session.ends[0]?.distanceMeters ?? null;
  const newEnd: End = {
    endId: crypto.randomUUID(),
    endIndex: nextIndex,
    distanceMeters: sessionDistanceMeters,
    shots: Array.from({ length: sessionShotsCount }, (_, i) => ({
      shotId: crypto.randomUUID(),
      shotIndex: i + 1,
      score: 0,
      value: "M"
    }))
  };
  return { ...session, ends: [...session.ends, newEnd] };
}

function applySessionShotsCount(session: Session, shotsCount: number): Session {
  return {
    ...session,
    ends: session.ends.map((end) => {
      const current = end.shots;
      if (current.length === shotsCount) {
        return end;
      }

      if (current.length > shotsCount) {
        const trimmed = current.slice(0, shotsCount).map((shot, index) => ({ ...shot, shotIndex: index + 1 }));
        return { ...end, shots: trimmed };
      }

      const padded = [...current];
      for (let i = current.length; i < shotsCount; i += 1) {
        padded.push({ shotId: crypto.randomUUID(), shotIndex: i + 1, score: 0, value: "M" });
      }
      return { ...end, shots: padded };
    })
  };
}

function removeEnd(session: Session, endId: string): Session {
  if (session.ends.length <= 1) return session;
  const filtered = session.ends.filter((end) => end.endId !== endId);
  return {
    ...session,
    ends: filtered.map((end, index) => ({ ...end, endIndex: index + 1 }))
  };
}

function applyDistanceToAllEnds(session: Session, distanceMeters: number | null): Session {
  return {
    ...session,
    ends: session.ends.map((end) => ({ ...end, distanceMeters }))
  };
}

function driveThumbUrl(fileId: string): string {
  return `/api/photos/file?fileId=${encodeURIComponent(fileId)}`;
}

function uploadProgressLabel(progress: UploadProgress | null): string {
  if (!progress || progress.phase === "optimizing") return "Optimizing...";
  if (typeof progress.percent === "number") return `Uploading ${progress.percent}%...`;
  return "Uploading...";
}

export function AppShell() {
  const {
    authSession,
    meta,
    sessions,
    activeSession,
    activeSessionId,
    setActiveSessionId,
    errorMessage,
    isLoading,
    userProfile,
    updateSession,
    updateUserProfile,
    addSession,
    deleteSession,
    syncNow,
    signOut
  } = useArcheryApp();

  const [viewMode, setViewMode] = useState<ViewMode>("dashboard");
  const [uploadingEndId, setUploadingEndId] = useState<string | null>(null);
  const [uploadingEndProgress, setUploadingEndProgress] = useState<UploadProgress | null>(null);
  const [isUploadingSessionPhoto, setIsUploadingSessionPhoto] = useState(false);
  const [sessionPhotoProgress, setSessionPhotoProgress] = useState<UploadProgress | null>(null);
  const [isLocating, setIsLocating] = useState(false);
  const [locationNotice, setLocationNotice] = useState<{ type: "info" | "warn" | "error"; text: string } | null>(null);
  const [profileNotice, setProfileNotice] = useState<{ type: "info"; text: string } | null>(null);
  const [profileDraft, setProfileDraft] = useState<UserProfile>(userProfile);
  const [profileImageBroken, setProfileImageBroken] = useState(false);
  const [sessionDistanceDraft, setSessionDistanceDraft] = useState("");
  const [distanceReminder, setDistanceReminder] = useState(false);
  const [selectedCalendarDate, setSelectedCalendarDate] = useState<string | null>(null);
  const [expandedCalendarSessionId, setExpandedCalendarSessionId] = useState<string | null>(null);
  const sessionDistanceInputRef = useRef<HTMLInputElement | null>(null);
  const [calendarMonth, setCalendarMonth] = useState(() => {
    const [year, month] = dateIsoInSf().split("-");
    return {
      year: Number(year),
      month: Number(month) - 1
    };
  });

  const stats = useMemo(() => lifetimeStats(sessions), [sessions]);
  const shopByCategory = useMemo(() => {
    const grouped = new Map<string, typeof shopProducts>();
    for (const product of shopProducts) {
      const existing = grouped.get(product.category) || [];
      grouped.set(product.category, [...existing, product]);
    }
    return grouped;
  }, []);
  const publishedSessions = useMemo(() => sessions.filter((session) => !session.isLocalOnly), [sessions]);
  const sessionShotsCount = useMemo(() => {
    if (!activeSession) return 5;
    return activeSession.ends[0]?.shots.length || 5;
  }, [activeSession]);
  const sessionDistanceMeters = useMemo(() => {
    if (!activeSession) return null;
    return activeSession.ends[0]?.distanceMeters ?? null;
  }, [activeSession]);
  const sessionHasDistance = typeof sessionDistanceMeters === "number" && sessionDistanceMeters > 0;
  const maxShots = useMemo(() => {
    if (!activeSession) return 5;
    return Math.max(5, ...activeSession.ends.map((end) => end.shots.length));
  }, [activeSession]);
  const scoreTableStyle = useMemo(
    () => ({ "--shot-columns": String(maxShots) }) as CSSProperties,
    [maxShots]
  );
  const runningTotals = useMemo(() => {
    if (!activeSession) return new Map<string, number>();
    let running = 0;
    const totals = new Map<string, number>();
    for (const end of activeSession.ends) {
      running += end.shots.reduce((sum, shot) => sum + shot.score, 0);
      totals.set(end.endId, running);
    }
    return totals;
  }, [activeSession]);
  const welcomeLabel = useMemo(() => {
    const first = userProfile.firstName.trim();
    if (first) return first;
    return authSession?.user.email || "Archer";
  }, [authSession?.user.email, userProfile.firstName]);
  const welcomeAvatarUrl = useMemo(() => {
    if (!authSession?.user.sub) return "";
    return `/api/auth/avatar?size=96&u=${encodeURIComponent(authSession.user.sub)}`;
  }, [authSession?.user.sub]);
  const profileAvatarUrl = useMemo(() => {
    if (!authSession?.user.sub) return "";
    return `/api/auth/avatar?size=256&u=${encodeURIComponent(authSession.user.sub)}`;
  }, [authSession?.user.sub]);
  const calendarModel = useMemo(() => {
    const y = calendarMonth.year;
    const m = calendarMonth.month;
    const start = new Date(y, m, 1);
    const end = new Date(y, m + 1, 0);
    const startWeekday = start.getDay();
    const totalDays = end.getDate();
    const todayIso = dateIsoInSf();

    const counts = new Map<string, number>();
    for (const session of publishedSessions) {
      counts.set(session.sessionDate, (counts.get(session.sessionDate) || 0) + 1);
    }

    const cells: Array<{ date: string; day: number; inMonth: boolean; count: number; isFuture: boolean }> = [];
    for (let i = 0; i < startWeekday; i += 1) {
      cells.push({ date: "", day: 0, inMonth: false, count: 0, isFuture: false });
    }

    for (let day = 1; day <= totalDays; day += 1) {
      const date = `${y}-${String(m + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      const isFuture = date > todayIso;
      cells.push({
        date,
        day,
        inMonth: true,
        count: counts.get(date) || 0,
        isFuture
      });
    }

    while (cells.length % 7 !== 0) {
      cells.push({ date: "", day: 0, inMonth: false, count: 0, isFuture: false });
    }

    const monthKey = `${y}-${String(m + 1).padStart(2, "0")}`;
    const monthSessions = [...publishedSessions]
      .filter((session) => session.sessionDate.startsWith(monthKey))
      .sort((a, b) => b.sessionDate.localeCompare(a.sessionDate));
    const datesWithSessions = Array.from(new Set(monthSessions.map((session) => session.sessionDate))).sort((a, b) =>
      b.localeCompare(a)
    );

    return {
      monthLabel: sfMonthLabel(y, m),
      cells,
      monthSessions,
      datesWithSessions
    };
  }, [calendarMonth.month, calendarMonth.year, publishedSessions]);

  useEffect(() => {
    if (!calendarModel.datesWithSessions.length) {
      setSelectedCalendarDate(null);
      setExpandedCalendarSessionId(null);
      return;
    }

    setSelectedCalendarDate((current) =>
      current && calendarModel.datesWithSessions.includes(current) ? current : calendarModel.datesWithSessions[0]
    );
  }, [calendarModel.datesWithSessions]);

  const selectedDateSessions = useMemo(() => {
    if (!selectedCalendarDate) return [] as Session[];
    return publishedSessions
      .filter((session) => session.sessionDate === selectedCalendarDate)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }, [selectedCalendarDate, publishedSessions]);

  useEffect(() => {
    setSessionDistanceDraft("");
  }, [activeSessionId]);

  useEffect(() => {
    if (sessionHasDistance) {
      setDistanceReminder(false);
    }
  }, [sessionHasDistance]);

  useEffect(() => {
    setProfileDraft((current) => ({
      ...userProfile,
      profilePhotoDataUrl: authSession?.user.picture || current.profilePhotoDataUrl || ""
    }));
  }, [authSession?.user.picture, userProfile]);

  useEffect(() => {
    setProfileImageBroken(false);
  }, [authSession?.user.sub, profileAvatarUrl, welcomeAvatarUrl]);

  async function handlePhotoUpload(endId: string, file: File) {
    if (!meta || !activeSession) return;
    setUploadingEndId(endId);
    setUploadingEndProgress({ phase: "optimizing", percent: null });
    try {
      const uploaded = await uploadEndPhoto(meta.spreadsheetId, endId, file, {
        onProgress: setUploadingEndProgress
      });
      updateSession((session) => ({
        ...session,
        ends: session.ends.map((end) =>
          end.endId === endId
            ? {
              ...end,
              photoFileId: uploaded.fileId,
              photoName: uploaded.name,
              photoUploadedAt: new Date().toISOString(),
              photoWebViewLink: uploaded.webViewLink || null
            }
            : end
        )
      }));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Photo upload failed");
    } finally {
      setUploadingEndId(null);
      setUploadingEndProgress(null);
    }
  }

  async function handleSessionPhotoUpload(file: File) {
    if (!meta || !activeSession) return;
    setIsUploadingSessionPhoto(true);
    setSessionPhotoProgress({ phase: "optimizing", percent: null });
    try {
      const uploaded = await uploadEndPhoto(meta.spreadsheetId, activeSession.sessionId, file, {
        onProgress: setSessionPhotoProgress
      });
      const uploadedAt = new Date().toISOString();
      updateSession((session) => ({
        ...session,
        photos: [
          ...(session.photos || []),
          {
            fileId: uploaded.fileId,
            name: uploaded.name,
            webViewLink: uploaded.webViewLink || null,
            uploadedAt
          }
        ]
      }));
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Session photo upload failed");
    } finally {
      setIsUploadingSessionPhoto(false);
      setSessionPhotoProgress(null);
    }
  }

  async function handleUseCurrentLocation() {
    if (!navigator.geolocation) {
      setLocationNotice({ type: "error", text: "Geolocation is not supported by this browser." });
      return;
    }

    setIsLocating(true);
    setLocationNotice(null);
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        const lat = position.coords.latitude;
        const lng = position.coords.longitude;
        let resolvedLocation = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
        let usedAddress = false;
        let geocodeFailure: string | null = null;

        try {
          const geocoded = await reverseGeocode(lat, lng);
          if (geocoded.formattedAddress) {
            resolvedLocation = geocoded.formattedAddress;
            usedAddress = true;
          }
        } catch (error) {
          geocodeFailure = error instanceof Error ? error.message : "Unable to resolve nearest address";
          // Keep coordinate fallback if reverse geocode fails.
        }

        updateSession((session) => ({
          ...session,
          location: resolvedLocation,
          locationLat: lat,
          locationLng: lng
        }));

        setLocationNotice(
          usedAddress
            ? { type: "info", text: "Location auto-filled from nearest address." }
            : {
              type: "warn",
              text: `Could not resolve nearest address. Saved coordinates instead.${geocodeFailure ? ` (${geocodeFailure})` : ""
                }`
            }
        );

        setIsLocating(false);
      },
      (error) => {
        setLocationNotice({ type: "error", text: `Location request failed: ${error.message}` });
        setIsLocating(false);
      },
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 0
      }
    );
  }

  function handleSaveProfile() {
    const normalizedDraft: UserProfile = {
      ...profileDraft,
      profilePhotoDataUrl: authSession?.user.picture || "",
      username: profileDraft.username.trim(),
      firstName: profileDraft.firstName.trim(),
      lastName: profileDraft.lastName.trim(),
      bowStyle: profileDraft.bowStyle.trim(),
      homeRange: profileDraft.homeRange.trim(),
      trainingGoal: profileDraft.trainingGoal.trim()
    };
    updateUserProfile(() => normalizedDraft);
    setProfileNotice({ type: "info", text: "Profile saved." });
    setViewMode("dashboard");
  }

  async function handleSaveAndSync() {
    await syncNow(activeSession?.isLocalOnly ? { publishSessionId: activeSession.sessionId } : undefined);
    setViewMode("dashboard");
  }

  function leaveEditorIfUnsavedDraft(nextView: ViewMode) {
    if (viewMode === "editor" && activeSession?.isLocalOnly) {
      deleteSession(activeSession.sessionId);
    }
    setViewMode(nextView);
  }

  function handleStartNewSession() {
    if (viewMode === "editor" && activeSession?.isLocalOnly) {
      deleteSession(activeSession.sessionId);
    }
    addSession(dateIsoInSf());
    setViewMode("editor");
  }

  if (isLoading) {
    return (
      <main className="page-wrap">
        <section className="loading-card">Preparing your range log...</section>
      </main>
    );
  }

  if (!authSession) {
    return (
      <main className="page-wrap">
        <section className="hero-card hero-split">
          <div className="hero-copy">
            <span className="eyebrow">ArrowLog</span>
            <h1>Train any day. Own every session.</h1>
            <p>
              Sign in with Google, grant read/write access to your spreadsheet, and keep your archery history
              entirely in your own Drive.
            </p>
            <a className="button primary" href="/api/auth/google/start">
              Continue with Google
            </a>
          </div>
          <div
            className="hero-media"
            role="img"
            aria-label="Archer aiming at a 10-ring target during sunset"
          />
        </section>
      </main>
    );
  }

  return (
    <main className="page-wrap">
      <header className="topbar">
        <div>
          <button className="eyebrow-link" onClick={() => leaveEditorIfUnsavedDraft("dashboard")}>Personal Sheets Edition</button>
          <h1>
            <button className="title-link" onClick={() => leaveEditorIfUnsavedDraft("dashboard")}>
              ArrowLog
            </button>
          </h1>
          <p className="welcome-row">
            <button
              className="welcome-link"
              onClick={() => leaveEditorIfUnsavedDraft("account")}
              title={`Open account for ${authSession.user.email}`}
            >
              {welcomeAvatarUrl && !profileImageBroken ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={welcomeAvatarUrl}
                  alt=""
                  className="welcome-avatar"
                  aria-hidden="true"
                  onError={() => setProfileImageBroken(true)}
                />
              ) : (
                <span className="welcome-avatar-fallback" aria-hidden="true">
                  {(userProfile.firstName[0] || authSession.user.name[0] || "U").toUpperCase()}
                </span>
              )}
              <span>Welcome {welcomeLabel}</span>
            </button>
          </p>
        </div>
      </header>

      {errorMessage ? <p className="error-banner">{errorMessage}</p> : null}

      <nav className="tabbar" aria-label="Primary sections">
        {([
          ["editor", "New Session"],
          ["shop", "Shop"],
          ["analytics", "Analytics"],
          ["account", "Account"]
        ] as Array<[Tab, string]>).map(([value, label]) => (
          <button
            key={value}
            className={`tab-button ${viewMode === value ? "active" : ""}`}
            onClick={() => {
              if (value === "editor") {
                handleStartNewSession();
                return;
              }
              leaveEditorIfUnsavedDraft(value);
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      {viewMode === "dashboard" ? (
        <section className="panel dashboard-panel">
          <div className="panel-head">
            <h2>Training Calendar</h2>
            <div className="month-nav">
              <button
                className="icon-button"
                aria-label="Previous month"
                onClick={() =>
                  setCalendarMonth((current) => {
                    const nextMonth = current.month - 1;
                    if (nextMonth < 0) return { year: current.year - 1, month: 11 };
                    return { year: current.year, month: nextMonth };
                  })
                }
              >
                &lt;
              </button>
              <span>{calendarModel.monthLabel}</span>
              <button
                className="icon-button"
                aria-label="Next month"
                onClick={() =>
                  setCalendarMonth((current) => {
                    const nextMonth = current.month + 1;
                    if (nextMonth > 11) return { year: current.year + 1, month: 0 };
                    return { year: current.year, month: nextMonth };
                  })
                }
              >
                &gt;
              </button>
            </div>
          </div>
          <div className="calendar-grid-head">
            {"Sun Mon Tue Wed Thu Fri Sat".split(" ").map((name) => (
              <span key={name}>{name}</span>
            ))}
          </div>
          <div className="calendar-grid">
            {calendarModel.cells.map((cell, index) => (
              <div
                key={`${cell.date}-${index}`}
                className={`calendar-cell ${cell.inMonth ? "" : "out"} ${
                  cell.inMonth && cell.count ? "has-sessions" : ""
                } ${
                  cell.inMonth && cell.date === selectedCalendarDate ? "selected" : ""
                }`}
                onClick={() => {
                  if (!cell.inMonth || !cell.count) return;
                  setSelectedCalendarDate(cell.date);
                  setExpandedCalendarSessionId(null);
                }}
              >
                {cell.inMonth ? (
                  <>
                    <span className={`calendar-day ${cell.isFuture ? "future" : "past"}`}>{cell.day}</span>
                    {cell.count ? (
                      <button
                        type="button"
                        className="calendar-count"
                        aria-label={`${cell.count} session${cell.count > 1 ? "s" : ""}`}
                        title={`${cell.count} session${cell.count > 1 ? "s" : ""}`}
                        onClick={() => {
                          setSelectedCalendarDate(cell.date);
                          setExpandedCalendarSessionId(null);
                        }}
                      >
                        <span className="calendar-dot" aria-hidden="true" />
                        {cell.count}
                      </button>
                    ) : null}
                  </>
                ) : null}
              </div>
            ))}
          </div>
          <div className="dashboard-lists">
            <div>
              <h3>{selectedCalendarDate ? `Sessions on ${selectedCalendarDate}` : `Sessions in ${calendarModel.monthLabel}`}</h3>
              {calendarModel.datesWithSessions.length ? (
                <div className="date-chip-row" aria-label="Session dates in this month">
                  {calendarModel.datesWithSessions.map((date) => (
                    <button
                      key={date}
                      type="button"
                      className={`date-chip ${selectedCalendarDate === date ? "active" : ""}`}
                      onClick={() => {
                        setSelectedCalendarDate(date);
                        setExpandedCalendarSessionId(null);
                      }}
                    >
                      {date}
                    </button>
                  ))}
                </div>
              ) : null}
              <div className="history-list">
                {selectedDateSessions.length ? (
                  selectedDateSessions.map((session) => {
                    const isExpanded = expandedCalendarSessionId === session.sessionId;
                    return (
                      <article key={session.sessionId} className={`history-item ${isExpanded ? "active" : ""}`}>
                        <div className="history-item-head">
                          <button
                            className="history-toggle"
                            aria-expanded={isExpanded}
                            onClick={() =>
                              setExpandedCalendarSessionId((current) =>
                                current === session.sessionId ? null : session.sessionId
                              )
                            }
                          >
                            <strong className="history-date-clickable">{session.sessionDate}</strong>
                            <span>{session.ends.length} ends</span>
                            <span>{sessionArrows(session)} arrows</span>
                            <span>{sessionTotal(session)} pts</span>
                            <span className="history-expand-hint">{isExpanded ? "Hide details" : "View details"}</span>
                          </button>
                          <div className="history-item-actions">
                            <button
                              className="icon-action"
                              title={`Edit ${session.sessionDate}`}
                              aria-label={`Edit ${session.sessionDate}`}
                              onClick={() => {
                                setActiveSessionId(session.sessionId);
                                setViewMode("editor");
                              }}
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                <path d="M16.8 3.5a2.4 2.4 0 0 1 3.4 3.4l-9.6 9.6-4.4 1 1-4.4 9.6-9.6Zm-8 10.3-.4 1.8 1.8-.4 8.7-8.7-1.4-1.4-8.7 8.7Z" />
                              </svg>
                            </button>
                            <button
                              className="icon-action danger"
                              title={`Delete ${session.sessionDate}`}
                              aria-label={`Delete ${session.sessionDate}`}
                              onClick={() => deleteSession(session.sessionId)}
                            >
                              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                                <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 7h2v8h-2v-8Zm4 0h2v8h-2v-8ZM8 10h2v8H8v-8Z" />
                              </svg>
                            </button>
                          </div>
                        </div>
                        {isExpanded ? (
                          <div className="history-detail-inline">
                            <div className="panel-head">
                              <h3>{session.sessionDate} (Read Only)</h3>
                              <span>{session.location || "No location"}</span>
                            </div>
                            <p className="helper-text">{session.notes || "No notes for this session."}</p>
                            <div className="history-ends-readonly">
                              {session.ends.map((end) => (
                                <div key={end.endId} className="history-end-row">
                                  <span>End {end.endIndex}</span>
                                  <span>{end.distanceMeters == null ? "-" : `${end.distanceMeters}m`}</span>
                                  <span>{end.shots.map((shot) => shot.value).join(" ")}</span>
                                  <strong>{end.shots.reduce((sum, shot) => sum + shot.score, 0)}</strong>
                                  {end.photoWebViewLink && end.photoFileId ? (
                                    <a
                                      className="history-photo-link"
                                      href={end.photoWebViewLink}
                                      target="_blank"
                                      rel="noreferrer"
                                      title="Open full-size photo"
                                      aria-label="Open full-size photo"
                                    >
                                      <Image
                                        className="history-photo-thumb"
                                        src={driveThumbUrl(end.photoFileId)}
                                        alt={`End ${end.endIndex} photo thumbnail`}
                                        width={58}
                                        height={42}
                                        loading="lazy"
                                        unoptimized
                                      />
                                    </a>
                                  ) : (
                                    <span className="tiny-link muted">No Photo</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </article>
                    );
                  })
                ) : (
                  <p className="helper-text">Select a day with session dots to review history.</p>
                )}
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {viewMode === "editor" && activeSession ? (
        <section className="panel">
          <div className="panel-head">
            <h2>New Session</h2>
            <div className="stack-row">
              <input
                type="date"
                value={activeSession.sessionDate}
                onChange={(event) =>
                  updateSession((session) => ({ ...session, sessionDate: event.target.value || session.sessionDate }))
                }
              />
              <label className="distance-field inline">
                <input
                  type="number"
                  min={1}
                  max={300}
                  placeholder="Distance (m)"
                  value={sessionDistanceDraft || (sessionHasDistance ? String(sessionDistanceMeters) : "")}
                  ref={sessionDistanceInputRef}
                  className={!sessionHasDistance && distanceReminder ? "needs-attention" : ""}
                  onChange={(event) => {
                    const raw = event.target.value;
                    setSessionDistanceDraft(raw);

                    if (!raw.trim()) {
                      updateSession((session) => applyDistanceToAllEnds(session, null));
                      return;
                    }

                    const parsed = Number(raw);
                    if (!Number.isFinite(parsed)) return;
                    const nextMeters = Math.min(300, Math.max(1, Math.round(parsed)));
                    setDistanceReminder(false);
                    updateSession((session) => applyDistanceToAllEnds(session, nextMeters));
                  }}
                  onBlur={() => {
                    const raw = sessionDistanceDraft;
                    if (!raw.trim()) {
                      setSessionDistanceDraft("");
                      return;
                    }

                    const parsed = Number(raw);
                    if (Number.isFinite(parsed)) {
                      const nextMeters = Math.min(300, Math.max(1, Math.round(parsed)));
                      setDistanceReminder(false);
                      updateSession((session) => applyDistanceToAllEnds(session, nextMeters));
                    }
                    setSessionDistanceDraft("");
                  }}
                />
              </label>
            </div>
          </div>
          {!sessionHasDistance ? (
            <p className={`helper-text ${distanceReminder ? "warn" : ""}`}>
              Enter session distance first, then you can add shot values.
            </p>
          ) : null}

          <label className="field-label">
            Location
            <div className="location-row">
              <input
                type="text"
                value={activeSession.location}
                onChange={(event) =>
                  updateSession((session) => ({
                    ...session,
                    location: event.target.value,
                    locationLat: null,
                    locationLng: null
                  }))
                }
                onInput={() => setLocationNotice(null)}
                placeholder="Address or range name"
              />
              <button className="button" onClick={() => void handleUseCurrentLocation()} disabled={isLocating}>
                {isLocating ? "Locating..." : "Use Current Location"}
              </button>
              <a
                className={`button ${activeSession.location.trim() ? "" : "disabled-link"}`}
                href={
                  activeSession.location.trim()
                    ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(activeSession.location.trim())}`
                    : "#"
                }
                target="_blank"
                rel="noreferrer"
                onClick={(event) => {
                  if (!activeSession.location.trim()) {
                    event.preventDefault();
                  }
                }}
              >
                Open in Google Maps
              </a>
            </div>
            {locationNotice ? (
              <p className={`location-notice ${locationNotice.type}`}>{locationNotice.text}</p>
            ) : null}
          </label>

          <label className="field-label">
            Notes
            <textarea
              value={activeSession.notes}
              onChange={(event) => updateSession((session) => ({ ...session, notes: event.target.value }))}
              placeholder="Weather, focus notes, sight adjustments..."
            />
          </label>

          <section className="field-label">
            Photos
            <div className="session-photos-head">
              <input
                id="session-photo-upload"
                className="sr-only"
                type="file"
                accept="image/*"
                capture="environment"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  void handleSessionPhotoUpload(file);
                  event.currentTarget.value = "";
                }}
              />
              <label className="icon-action" htmlFor="session-photo-upload" aria-label="Take session photo" title="Take session photo">
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M7 6h3l1.4-2h5.2L18 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3Zm5 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-2.2a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6Z" />
                </svg>
              </label>
              {isUploadingSessionPhoto ? <span className="tiny-link">{uploadProgressLabel(sessionPhotoProgress)}</span> : null}
            </div>
            <div className="session-photos-grid">
              {(activeSession.photos || []).length ? (
                (activeSession.photos || []).map((photo) => (
                  <a
                    key={photo.fileId}
                    className="session-photo-thumb-link"
                    href={photo.webViewLink || "#"}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open session photo"
                    title={photo.name}
                    onClick={(event) => {
                      if (!photo.webViewLink) {
                        event.preventDefault();
                      }
                    }}
                  >
                    <Image
                      className="session-photo-thumb"
                      src={driveThumbUrl(photo.fileId)}
                      alt={photo.name || "Session photo"}
                      width={72}
                      height={56}
                      loading="lazy"
                      unoptimized
                    />
                  </a>
                ))
              ) : (
                <span className="tiny-link muted">No photos yet.</span>
              )}
            </div>
          </section>

          <div className="ends-grid">
            <div className="score-table-wrap" style={scoreTableStyle}>
              <div className="ends-toolbar">
                <p>Ends: {activeSession.ends.length}</p>
                <div className="shots-per-session-control" aria-label="Shots per end for this session">
                  <span>Shots/End</span>
                  <button
                    className="icon-button"
                    disabled={sessionShotsCount <= 3}
                    title={sessionShotsCount <= 3 ? "Minimum 3 shots per end" : "Decrease shots per end"}
                    onClick={() =>
                      updateSession((session) => applySessionShotsCount(session, Math.max(3, sessionShotsCount - 1)))
                    }
                  >
                    -
                  </button>
                  <strong>{sessionShotsCount}</strong>
                  <button
                    className="icon-button"
                    disabled={sessionShotsCount >= 12}
                    title={sessionShotsCount >= 12 ? "Maximum 12 shots per end" : "Increase shots per end"}
                    onClick={() =>
                      updateSession((session) => applySessionShotsCount(session, Math.min(12, sessionShotsCount + 1)))
                    }
                  >
                    +
                  </button>
                </div>
              </div>
              <div className="score-table-head">
                <span>End</span>
                <span>Distance (m)</span>
                <span>Shots</span>
                <span>Arrow Scores (10-ring, X/M)</span>
                <span>End Total</span>
                <span>X</span>
                <span>Running Total</span>
                <span>Actions</span>
              </div>
              {activeSession.ends.map((end) => {
                const total = end.shots.reduce((sum, shot) => sum + shot.score, 0);
                const xCount = end.shots.filter((shot) => shot.value === "X").length;
                const running = runningTotals.get(end.endId) ?? 0;

                return (
                  <article key={end.endId} className="end-card">
                    <h3>End {end.endIndex}</h3>
                    <p className="shots-count-static">{sessionHasDistance ? `${sessionDistanceMeters}m` : "-"}</p>
                    <p className="shots-count-static">{end.shots.length}</p>
                    <div className="shots-grid inline-scores">
                      {end.shots.map((shot) => (
                        <div key={shot.shotId} className="shot-input">
                          <span>{shot.shotIndex}</span>
                          <ShotWheelPicker
                            value={shot.value}
                            label={`End ${end.endIndex} Shot ${shot.shotIndex}`}
                            onOpenAttempt={() => {
                              if (sessionHasDistance) return true;
                              setDistanceReminder(true);
                              sessionDistanceInputRef.current?.focus();
                              return false;
                            }}
                            onChange={({ value, score }) => {
                              if (!sessionHasDistance) return;
                              updateSession((session) => ({
                                ...session,
                                ends: session.ends.map((currentEnd) =>
                                  currentEnd.endId === end.endId
                                    ? {
                                      ...currentEnd,
                                      shots: currentEnd.shots.map((currentShot) =>
                                        currentShot.shotId === shot.shotId
                                          ? { ...currentShot, score, value }
                                          : currentShot
                                      )
                                    }
                                    : currentEnd
                                )
                              }));
                            }}
                          />
                        </div>
                      ))}
                    </div>
                    <p className="end-total"><strong>{total}</strong></p>
                    <p className="end-total"><strong>{xCount}</strong></p>
                    <p className="end-total"><strong>{running}</strong></p>
                    <p className="mobile-end-summary">
                      <span>End Total: <strong>{total}</strong></span>
                      <span>X: <strong>{xCount}</strong></span>
                      <span>Running Total: <strong>{running}</strong></span>
                    </p>
                    <div className="end-actions">
                      <span className={`photo-indicator ${end.photoFileId ? "attached" : ""}`} aria-hidden="true" />
                      <input
                        id={`photo-upload-${end.endId}`}
                        className="sr-only"
                        type="file"
                        accept="image/*"
                        capture="environment"
                        onChange={(event) => {
                          const file = event.target.files?.[0];
                          if (!file) return;
                          void handlePhotoUpload(end.endId, file);
                          event.currentTarget.value = "";
                        }}
                      />
                      <label
                        htmlFor={`photo-upload-${end.endId}`}
                        className="icon-action"
                        title={end.photoFileId ? "Replace end photo" : "Add end photo"}
                        aria-label={end.photoFileId ? "Replace end photo" : "Add end photo"}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path d="M7 6h3l1.4-2h5.2L18 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h3Zm5 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0-2.2a2.8 2.8 0 1 1 0-5.6 2.8 2.8 0 0 1 0 5.6Z" />
                        </svg>
                      </label>
                      <a
                        className="icon-action"
                        href={end.photoWebViewLink || "#"}
                        target="_blank"
                        rel="noreferrer"
                        title={end.photoWebViewLink ? "View photo" : "No photo attached"}
                        aria-label={end.photoWebViewLink ? "View photo" : "No photo attached"}
                        aria-disabled={!end.photoWebViewLink}
                        onClick={(event) => {
                          if (!end.photoWebViewLink) {
                            event.preventDefault();
                          }
                        }}
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path d="M12 5c5.6 0 9.7 4.3 11 6.5-1.3 2.2-5.4 6.5-11 6.5S2.3 13.7 1 11.5C2.3 9.3 6.4 5 12 5Zm0 2c-4.2 0-7.4 2.8-8.8 4.5C4.6 13.2 7.8 16 12 16s7.4-2.8 8.8-4.5C19.4 9.8 16.2 7 12 7Zm0 1.6a2.9 2.9 0 1 1 0 5.8 2.9 2.9 0 0 1 0-5.8Z" />
                        </svg>
                      </a>
                      <button
                        className="icon-action danger"
                        disabled={activeSession.ends.length <= 1}
                        title={activeSession.ends.length <= 1 ? "At least one end is required" : `Remove end ${end.endIndex}`}
                        aria-label={activeSession.ends.length <= 1 ? "Cannot remove last end" : `Remove end ${end.endIndex}`}
                        onClick={() =>
                          updateSession((session) => removeEnd(session, end.endId))
                        }
                      >
                        <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                          <path d="M9 3h6l1 2h4v2H4V5h4l1-2Zm1 7h2v8h-2v-8Zm4 0h2v8h-2v-8ZM8 10h2v8H8v-8Z" />
                        </svg>
                      </button>
                      {uploadingEndId === end.endId ? (
                        <span className="tiny-link">{uploadProgressLabel(uploadingEndProgress)}</span>
                      ) : null}
                    </div>
                  </article>
                );
              })}
            </div>
            <div className="editor-actions">
              <button className="button" onClick={() => updateSession((session) => addEnd(session))}>
                + Add End
              </button>
              <button className="button primary" onClick={() => void handleSaveAndSync()}>
                Save + Sync
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {viewMode === "analytics" ? (
        <section className="panel">
          <h2>Analytics</h2>
          <div className="stats-grid">
            <StatCard label="Total Points" value={String(stats.totalPoints)} />
            <StatCard label="Rolling Avg" value={stats.avgPerArrow.toFixed(2)} />
            <StatCard label="Best Session" value={String(Math.max(0, ...sessions.map((s) => sessionTotal(s))))} />
            <StatCard label="Ends Logged" value={String(sessions.reduce((sum, s) => sum + s.ends.length, 0))} />
          </div>
          <div className="trend-bars">
            {sessions.slice(0, 12).reverse().map((session) => {
              const total = sessionTotal(session);
              return (
                <div key={session.sessionId} className="trend-bar-wrap">
                  <span>{session.sessionDate.slice(5)}</span>
                  <div className="trend-bar" style={{ height: `${Math.min(100, total)}%` }} />
                  <small>{total}</small>
                </div>
              );
            })}
          </div>
          {activeSession ? (
            <div className="active-avg-chart">
              <h3>Active Session Avg Points / Shot</h3>
              <div className="active-avg-bars">
                {activeSession.ends.map((end) => {
                  const endTotal = end.shots.reduce((sum, shot) => sum + shot.score, 0);
                  const avgPerShot = end.shots.length ? endTotal / end.shots.length : 0;
                  return (
                    <div key={end.endId} className="active-avg-bar-wrap">
                      <span>E{end.endIndex}</span>
                      <div className="active-avg-bar-track">
                        <div
                          className="active-avg-bar-fill"
                          style={{ width: `${Math.max(4, Math.min(100, (avgPerShot / 10) * 100))}%` }}
                        />
                      </div>
                      <strong>{avgPerShot.toFixed(2)}</strong>
                    </div>
                  );
                })}
              </div>
              <p className="helper-text">Active session average point/shot: {sessionAvgPerArrow(activeSession).toFixed(2)}</p>
            </div>
          ) : null}
        </section>
      ) : null}

      {viewMode === "shop" ? (
        <section className="panel">
          <h2>Shop</h2>
          <p className="affiliate-note">
            As an Amazon Associate, I earn from qualifying purchases. I only share items I would personally recommend
            to developing archers.
          </p>
          <div className="shop-groups">
            {Array.from(shopByCategory.entries()).map(([category, products]) => (
              <section key={category} className="shop-group">
                <h3>{category}</h3>
                <div className="shop-grid">
                  {products.map((product) => (
                    <article key={product.name} className="shop-card">
                      {product.imageUrl ? (
                        <Image
                          className="shop-image"
                          src={product.imageUrl}
                          alt={product.name}
                          width={240}
                          height={160}
                          loading="lazy"
                          unoptimized
                        />
                      ) : null}
                      <div className="shop-card-copy">
                        <strong>{product.name}</strong>
                        <p className="helper-text">
                          <strong>Best for:</strong> {product.bestFor}
                        </p>
                        <p className="helper-text">{product.why}</p>
                        {product.caution ? (
                          <p className="helper-text">
                            <strong>Note:</strong> {product.caution}
                          </p>
                        ) : null}
                        <div className="shop-card-foot">
                          <a
                            className="button tiny primary"
                            href={product.url}
                            target="_blank"
                            rel="nofollow sponsored noopener noreferrer"
                          >
                            Buy on Amazon
                          </a>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </section>
      ) : null}

      {viewMode === "account" ? (
        <section className="panel">
          <h2>Account & Profile</h2>
          <p>
            Signed in as <strong>{authSession.user.email}</strong>
          </p>
          <div className="profile-layout">
            <section className="profile-photo-card">
              <div className="profile-photo-wrap">
                {profileAvatarUrl && !profileImageBroken ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={profileAvatarUrl}
                    alt="Profile"
                    className="profile-photo"
                    onError={() => setProfileImageBroken(true)}
                  />
                ) : (
                  <div className="profile-photo-fallback" aria-hidden="true">
                    {(profileDraft.firstName[0] || authSession.user.name[0] || "U").toUpperCase()}
                  </div>
                )}
              </div>
              <p className="helper-text">Using your Google profile image.</p>
              {profileNotice ? (
                <p className={`profile-notice ${profileNotice.type}`}>{profileNotice.text}</p>
              ) : null}
            </section>

            <section className="profile-form-grid">
              <label className="field-label compact">
                Username
                <input
                  type="text"
                  value={profileDraft.username}
                  onChange={(event) =>
                    setProfileDraft((profile) => ({ ...profile, username: event.target.value.trimStart() }))
                  }
                  placeholder="ceech-archer"
                />
              </label>
              <label className="field-label compact">
                First Name
                <input
                  type="text"
                  value={profileDraft.firstName}
                  onChange={(event) =>
                    setProfileDraft((profile) => ({ ...profile, firstName: event.target.value.trimStart() }))
                  }
                  placeholder="Ceech"
                />
              </label>
              <label className="field-label compact">
                Last Name
                <input
                  type="text"
                  value={profileDraft.lastName}
                  onChange={(event) =>
                    setProfileDraft((profile) => ({ ...profile, lastName: event.target.value.trimStart() }))
                  }
                  placeholder="Hsueh"
                />
              </label>
              <label className="field-label compact">
                Started Archery
                <input
                  type="date"
                  value={profileDraft.startedArcheryOn}
                  onChange={(event) =>
                    setProfileDraft((profile) => ({ ...profile, startedArcheryOn: event.target.value }))
                  }
                />
              </label>
              <label className="field-label compact">
                Handedness
                <select
                  value={profileDraft.handedness}
                  onChange={(event) =>
                    setProfileDraft((profile) => ({
                      ...profile,
                      handedness: event.target.value as "right" | "left" | "switch"
                    }))
                  }
                >
                  <option value="right">Right-handed</option>
                  <option value="left">Left-handed</option>
                  <option value="switch">Switch</option>
                </select>
              </label>
              <label className="field-label compact">
                Dominant Eye
                <select
                  value={profileDraft.dominantEye}
                  onChange={(event) =>
                    setProfileDraft((profile) => ({
                      ...profile,
                      dominantEye: event.target.value as "right" | "left" | "both"
                    }))
                  }
                >
                  <option value="right">Right eye</option>
                  <option value="left">Left eye</option>
                  <option value="both">Both</option>
                </select>
              </label>
              <label className="field-label compact">
                Bow Style
                <input
                  type="text"
                  value={profileDraft.bowStyle}
                  onChange={(event) =>
                    setProfileDraft((profile) => ({ ...profile, bowStyle: event.target.value.trimStart() }))
                  }
                  placeholder="Olympic recurve"
                />
              </label>
              <label className="field-label compact">
                Home Range / Club
                <input
                  type="text"
                  value={profileDraft.homeRange}
                  onChange={(event) =>
                    setProfileDraft((profile) => ({ ...profile, homeRange: event.target.value.trimStart() }))
                  }
                  placeholder="Golden Gate Park Archers"
                />
              </label>
              <label className="field-label compact full">
                Training Goal
                <textarea
                  value={profileDraft.trainingGoal}
                  onChange={(event) =>
                    setProfileDraft((profile) => ({ ...profile, trainingGoal: event.target.value }))
                  }
                  placeholder="Example: Hold 8.5+ avg at 70m by end of season"
                />
              </label>
              <div className="profile-save-row">
                <button className="button primary" onClick={handleSaveProfile}>Save</button>
              </div>
            </section>
          </div>

          <h3>Storage</h3>
          <p>
            Linked Sheet: <strong>{meta?.spreadsheetTitle || "Not linked"}</strong>
          </p>
          <p>
            Spreadsheet ID: <code>{meta?.spreadsheetId || "-"}</code>
          </p>
          <p>Last Sync: {meta?.lastSyncedAt || "No successful sync yet"}</p>
          <div className="stack-row">
            <button className="button" onClick={() => void syncNow()}>
              Re-sync
            </button>
            <button
              className="button"
              onClick={() => {
                const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: "application/json" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "archery-sessions.json";
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export JSON
            </button>
            <button
              className="button"
              onClick={() => {
                const rows = [
                  "session_date,location,total_points,arrows,avg_per_arrow,notes",
                  ...sessions.map(
                    (s) =>
                      `${s.sessionDate},"${s.location.replaceAll('"', '""')}",${sessionTotal(s)},${sessionArrows(s)},${sessionAvgPerArrow(s).toFixed(2)},"${s.notes.replaceAll('"', '""')}"`
                  )
                ];
                const blob = new Blob([rows.join("\n")], { type: "text/csv" });
                const url = URL.createObjectURL(blob);
                const link = document.createElement("a");
                link.href = url;
                link.download = "archery-sessions.csv";
                link.click();
                URL.revokeObjectURL(url);
              }}
            >
              Export CSV
            </button>
          </div>
          <p className="privacy-note">
            Privacy default: this app does not keep a centralized log database. Your practice data lives in your
            personal Google Sheet. Profile settings are stored in this browser for now.
          </p>
          <div className="stack-row">
            <button className="button" onClick={() => void signOut()}>
              Log out
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
