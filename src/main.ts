import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";

type Mode = "idle" | "work" | "break";

type Settings = {
  workMinutes: number;
  breakMinutes: number;
};

type Awaiting = "none" | "break" | "work";

type State = {
  mode: Mode;
  awaiting: Awaiting;
  running: boolean;
  endsAtMs: number | null;
  remainingMs: number; // only used when paused/idle
  settings: Settings;
};

const DEFAULTS: Settings = { workMinutes: 25, breakMinutes: 5 };

const LS_SETTINGS = "breakTimer.settings.v1";
const LS_STATE = "breakTimer.state.v1";

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function readSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_SETTINGS);
    if (!raw) return DEFAULTS;
    const j = JSON.parse(raw);
    return {
      workMinutes: clamp(Number(j.workMinutes ?? DEFAULTS.workMinutes), 1, 240),
      breakMinutes: clamp(Number(j.breakMinutes ?? DEFAULTS.breakMinutes), 1, 120),
    };
  } catch {
    return DEFAULTS;
  }
}

function writeSettings(s: Settings) {
  localStorage.setItem(LS_SETTINGS, JSON.stringify(s));
}

function readState(): Omit<State, "settings"> {
  try {
    const raw = localStorage.getItem(LS_STATE);
    if (!raw) {
      return { mode: "idle", awaiting: "none", running: false, endsAtMs: null, remainingMs: 0 };
    }
    const j = JSON.parse(raw);
    return {
      mode: (j.mode as Mode) ?? "idle",
      awaiting: (j.awaiting as Awaiting) ?? "none",
      running: Boolean(j.running),
      endsAtMs: typeof j.endsAtMs === "number" ? j.endsAtMs : null,
      remainingMs: typeof j.remainingMs === "number" ? j.remainingMs : 0,
    };
  } catch {
    return { mode: "idle", awaiting: "none", running: false, endsAtMs: null, remainingMs: 0 };
  }
}

function writeState(s: Omit<State, "settings">) {
  localStorage.setItem(LS_STATE, JSON.stringify(s));
}

function msFromMinutes(mins: number) {
  return Math.round(mins * 60_000);
}

function fmt(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function $(id: string) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function show(el: HTMLElement) {
  el.classList.remove("hidden");
}

function hide(el: HTMLElement) {
  el.classList.add("hidden");
}

async function ensureNotificationPermission() {
  try {
    if ("Notification" in window && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch {
    // ignore
  }
}

function notify(title: string, body?: string) {
  try {
    if ("Notification" in window && Notification.permission === "granted") {
      new Notification(title, body ? { body } : undefined);
    }
  } catch {
    // ignore
  }
}

function beep() {
  const audio = document.getElementById("beep") as HTMLAudioElement | null;
  audio?.play().catch(() => {
    // ignore autoplay restrictions
  });
}

function computeRemaining(state: State, nowMs: number) {
  if (state.running && state.endsAtMs != null) {
    return state.endsAtMs - nowMs;
  }
  return state.remainingMs;
}

async function focusAndTop() {
  const w = getCurrentWindow();
  await w.show();
  await w.setFocus();
  await w.setAlwaysOnTop(true);
}

async function dropTop() {
  const w = getCurrentWindow();
  await w.setAlwaysOnTop(false);
}

function modeLabel(mode: Mode) {
  if (mode === "work") return "Working";
  if (mode === "break") return "Break";
  return "Ready";
}

function hintLabel(state: State) {
  if (state.mode === "work") return "Focus time.";
  if (state.mode === "break") return "Pause time.";
  return "Set your durations, then press Start.";
}

function nextDurationMs(state: State) {
  if (state.mode === "break") return msFromMinutes(state.settings.breakMinutes);
  return msFromMinutes(state.settings.workMinutes);
}

// (removed unused helper)

let popupContext: "work-ended" | "break-ended" | null = null;

async function showBreakPopup() {
  popupContext = "work-ended";
  const popup = $("popup") as HTMLElement;
  ($("popup-title") as HTMLElement).textContent = "Time for a break";
  ($("popup-text") as HTMLElement).textContent = "Stand up, move a bit, drink water.";
  ($("btn-break") as HTMLButtonElement).textContent = "Start break";
  show(popup);
  await focusAndTop();
  beep();
  notify("Break timer", "Time for a break");
}

async function showBackToWorkPopup() {
  popupContext = "break-ended";
  const popup = $("popup") as HTMLElement;
  ($("popup-title") as HTMLElement).textContent = "Back to work";
  ($("popup-text") as HTMLElement).textContent = "Break is done. Ready for another round?";
  ($("btn-break") as HTMLButtonElement).textContent = "Start work";
  show(popup);
  await focusAndTop();
  beep();
  notify("Break timer", "Break is done — back to work");
}

async function main() {
  await ensureNotificationPermission();

  const settings = readSettings();
  const persisted = readState();

  const state: State = {
    settings,
    mode: persisted.mode,
    awaiting: persisted.awaiting,
    running: persisted.running,
    endsAtMs: persisted.endsAtMs,
    remainingMs: persisted.remainingMs,
  };

  // Normalize persisted state (avoid getting stuck showing WORKING 00:00 after reload).
  // If we are not running and not explicitly awaiting an action, show a sane default.
  if (!state.running && state.awaiting === "none") {
    if (state.remainingMs <= 0) {
      state.mode = "idle";
      state.endsAtMs = null;
      state.remainingMs = msFromMinutes(settings.workMinutes);
    }
  }

  // If idle, ensure it has a countdown value.
  if (state.mode === "idle" && state.remainingMs <= 0) {
    state.remainingMs = msFromMinutes(settings.workMinutes);
  }

  // UI refs
  const modeEl = $("mode");
  const timeEl = $("time");
  const hintEl = $("hint");
  const workMinEl = $("work-min");
  const breakMinEl = $("break-min");

  const btnStart = $("btn-start") as HTMLButtonElement;
  const btnPause = $("btn-pause") as HTMLButtonElement;
  const btnReset = $("btn-reset") as HTMLButtonElement;

  const settingsModal = $("settings") as HTMLElement;
  const btnSettings = $("btn-settings") as HTMLButtonElement;
  const setWork = $("set-work") as HTMLInputElement;
  const setBreak = $("set-break") as HTMLInputElement;
  const btnSettingsCancel = $("btn-settings-cancel") as HTMLButtonElement;
  const btnSettingsSave = $("btn-settings-save") as HTMLButtonElement;

  const popup = $("popup") as HTMLElement;
  const btnSnooze = $("btn-snooze") as HTMLButtonElement;
  const btnBreak = $("btn-break") as HTMLButtonElement;

  function persist() {
    writeSettings(state.settings);
    writeState({
      mode: state.mode,
      awaiting: state.awaiting,
      running: state.running,
      endsAtMs: state.endsAtMs,
      remainingMs: state.remainingMs,
    });
  }

  function syncUi() {
    modeEl.textContent = modeLabel(state.mode);
    hintEl.textContent = hintLabel(state);

    workMinEl.textContent = String(state.settings.workMinutes);
    breakMinEl.textContent = String(state.settings.breakMinutes);

    btnStart.disabled = state.running;
    btnPause.disabled = !state.running;

    // reset to appropriate default for current mode
    const now = Date.now();
    const remaining = computeRemaining(state, now);
    timeEl.textContent = fmt(remaining);
  }

  function startCountdown(durationMs: number) {
    state.running = true;
    state.endsAtMs = Date.now() + durationMs;
    state.remainingMs = durationMs;
    state.awaiting = "none";
    persist();
    syncUi();
  }

  function pauseCountdown() {
    const now = Date.now();
    state.remainingMs = computeRemaining(state, now);
    state.running = false;
    state.endsAtMs = null;
    persist();
    syncUi();
  }

  function resetCountdown() {
    const dur = nextDurationMs(state);
    state.running = false;
    state.endsAtMs = null;
    state.remainingMs = dur;
    persist();
    syncUi();
  }

  async function onWorkEnded() {
    state.running = false;
    state.endsAtMs = null;
    state.remainingMs = 0;
    state.awaiting = "break";
    persist();
    syncUi();
    await showBreakPopup();
  }

  async function onBreakEnded() {
    state.running = false;
    state.endsAtMs = null;
    state.remainingMs = 0;
    state.awaiting = "work";
    persist();
    syncUi();
    await showBackToWorkPopup();
  }

  // Settings
  btnSettings.addEventListener("click", () => {
    setWork.value = String(state.settings.workMinutes);
    setBreak.value = String(state.settings.breakMinutes);
    show(settingsModal);
  });
  btnSettingsCancel.addEventListener("click", () => hide(settingsModal));
  btnSettingsSave.addEventListener("click", () => {
    const w = clamp(Number(setWork.value || 25), 1, 240);
    const b = clamp(Number(setBreak.value || 5), 1, 120);
    state.settings = { workMinutes: w, breakMinutes: b };

    // If idle, update displayed default.
    if (!state.running) {
      if (state.mode === "idle") {
        state.remainingMs = msFromMinutes(w);
      } else if (state.mode === "work") {
        state.remainingMs = msFromMinutes(w);
      } else {
        state.remainingMs = msFromMinutes(b);
      }
    }

    persist();
    syncUi();
    hide(settingsModal);
  });

  // Main controls
  btnStart.addEventListener("click", () => {
    // If we're waiting for an action after a popup, Start should do the right thing.
    if (state.awaiting === "break") {
      state.mode = "break";
      startCountdown(msFromMinutes(state.settings.breakMinutes));
      return;
    }
    if (state.awaiting === "work") {
      state.mode = "work";
      startCountdown(msFromMinutes(state.settings.workMinutes));
      return;
    }

    if (state.mode === "idle") state.mode = "work";
    startCountdown(state.remainingMs || nextDurationMs(state));
  });

  btnPause.addEventListener("click", () => pauseCountdown());
  btnReset.addEventListener("click", () => {
    if (state.mode === "idle") {
      state.remainingMs = msFromMinutes(state.settings.workMinutes);
    }
    resetCountdown();
  });

  // Popup controls
  btnSnooze.addEventListener("click", async () => {
    // Snooze means: keep working for 5 more minutes.
    popupContext = null;
    state.awaiting = "none";
    hide(popup);
    await dropTop();
    state.mode = "work";
    startCountdown(msFromMinutes(5));
  });

  btnBreak.addEventListener("click", async () => {
    hide(popup);
    await dropTop();

    if (popupContext === "break-ended" || state.awaiting === "work") {
      popupContext = null;
      state.mode = "work";
      startCountdown(msFromMinutes(state.settings.workMinutes));
      return;
    }

    // default: work ended → start break
    popupContext = null;
    state.mode = "break";
    startCountdown(msFromMinutes(state.settings.breakMinutes));
  });

  // Allow Rust tray menu to bring the window back
  // (no-op if not called)
  (window as any).__breakTimerShow = async () => {
    await invoke("show_main_window");
  };

  // Tick loop
  syncUi();

  setInterval(async () => {
    const now = Date.now();
    const remaining = computeRemaining(state, now);

    // update time display
    timeEl.textContent = fmt(remaining);

    if (!state.running) return;

    if (remaining <= 0) {
      // stop running and trigger state transitions
      if (state.mode === "work") {
        await onWorkEnded();
      } else if (state.mode === "break") {
        await onBreakEnded();
      }
    }
  }, 250);
}

main().catch((e) => {
  console.error(e);
});
