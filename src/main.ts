import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, UserAttentionType } from "@tauri-apps/api/window";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

type Mode = "idle" | "work" | "break";

type Settings = {
  workMinutes: number;
  breakMinutes: number;
  longBreakMinutes: number;
  longBreakEvery: number; // number of work->break loops before long break
};

type Awaiting = "none" | "break" | "work";

type State = {
  mode: Mode;
  awaiting: Awaiting;
  running: boolean;
  endsAtMs: number | null;
  remainingMs: number; // only used when paused/idle
  // feature: long break
  loopsSinceLongBreak: number;
  isNextBreakLong: boolean;
  // feature: next task prompt
  nextTask: string;
  settings: Settings;
};

const DEFAULTS: Settings = {
  workMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4,
};

const LS_SETTINGS = "breakTimer.settings.v2";
const LS_STATE = "breakTimer.state.v2";

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
      longBreakMinutes: clamp(
        Number(j.longBreakMinutes ?? DEFAULTS.longBreakMinutes),
        1,
        240
      ),
      longBreakEvery: clamp(
        Number(j.longBreakEvery ?? DEFAULTS.longBreakEvery),
        2,
        20
      ),
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
      return {
        mode: "idle",
        awaiting: "none",
        running: false,
        endsAtMs: null,
        remainingMs: 0,
        loopsSinceLongBreak: 0,
        isNextBreakLong: false,
        nextTask: "",
      };
    }
    const j = JSON.parse(raw);
    return {
      mode: (j.mode as Mode) ?? "idle",
      awaiting: (j.awaiting as Awaiting) ?? "none",
      running: Boolean(j.running),
      endsAtMs: typeof j.endsAtMs === "number" ? j.endsAtMs : null,
      remainingMs: typeof j.remainingMs === "number" ? j.remainingMs : 0,
      loopsSinceLongBreak:
        typeof j.loopsSinceLongBreak === "number" ? j.loopsSinceLongBreak : 0,
      isNextBreakLong: Boolean(j.isNextBreakLong),
      nextTask: typeof j.nextTask === "string" ? j.nextTask : "",
    };
  } catch {
    return {
      mode: "idle",
      awaiting: "none",
      running: false,
      endsAtMs: null,
      remainingMs: 0,
      loopsSinceLongBreak: 0,
      isNextBreakLong: false,
      nextTask: "",
    };
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
    const granted = await isPermissionGranted();
    if (!granted) {
      await requestPermission();
    }
  } catch {
    // ignore
  }
}

async function notificationsEnabled(): Promise<boolean> {
  try {
    return await isPermissionGranted();
  } catch {
    return false;
  }
}

function notify(title: string, body?: string) {
  try {
    sendNotification({ title, body });
  } catch {
    // ignore
  }
}

function alarm() {
  // Loud-ish repeating beeps; still respects system volume.
  try {
    const AudioCtx = (window.AudioContext || (window as any).webkitAudioContext) as typeof AudioContext;
    const ctx = new AudioCtx();
    const master = ctx.createGain();
    master.gain.value = 0.18;
    master.connect(ctx.destination);

    const startAt = ctx.currentTime + 0.01;
    for (let i = 0; i < 10; i++) {
      const t0 = startAt + i * 0.25;
      const t1 = t0 + 0.14;

      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = "square";
      o.frequency.setValueAtTime(880, t0);
      o.frequency.linearRampToValueAtTime(1040, t1);

      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(1.0, t0 + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, t1);

      o.connect(g);
      g.connect(master);
      o.start(t0);
      o.stop(t1 + 0.01);
    }

    setTimeout(() => {
      ctx.close().catch(() => {});
    }, 3200);
  } catch {
    // ignore
  }
}

function computeRemaining(state: State, nowMs: number) {
  if (state.running && state.endsAtMs != null) {
    return state.endsAtMs - nowMs;
  }
  return state.remainingMs;
}

async function focusAndTop() {
  try {
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setAlwaysOnTop(true);
    await w.setFocus();
    await w.requestUserAttention(UserAttentionType.Critical);
  } catch {
    // ignore
  }
}

async function dropTop() {
  try {
    const w = getCurrentWindow();
    await w.setAlwaysOnTop(false);
  } catch {
    // ignore
  }
}

function modeLabel(mode: Mode) {
  if (mode === "work") return "Working";
  if (mode === "break") return "Break";
  return "Ready";
}

function hintLabel(state: State) {
  if (state.mode === "work") return "Focus time.";
  if (state.mode === "break") return state.isNextBreakLong ? "Long break." : "Pause time.";
  return "Set your durations, then press Start.";
}

let popupContext: "work-ended" | "break-ended" | null = null;
let nagTimer: number | null = null;

function stopNag() {
  if (nagTimer != null) {
    window.clearInterval(nagTimer);
    nagTimer = null;
  }
}

function startNag(kind: "break" | "work") {
  stopNag();
  nagTimer = window.setInterval(async () => {
    try {
      const w = getCurrentWindow();
      await w.requestUserAttention(UserAttentionType.Critical);
    } catch {
      // ignore
    }

    if (kind === "break") {
      notify("Break timer", "Time for a break");
    } else {
      notify("Break timer", "Break is done — back to work");
    }
  }, 30_000);
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
    loopsSinceLongBreak: persisted.loopsSinceLongBreak,
    isNextBreakLong: persisted.isNextBreakLong,
    nextTask: persisted.nextTask,
  };

  // normalize
  if (!state.running && state.remainingMs <= 0 && state.awaiting === "none") {
    state.mode = "idle";
    state.remainingMs = msFromMinutes(state.settings.workMinutes);
  }

  // UI refs
  const modeEl = $("mode");
  const timeEl = $("time");
  const hintEl = $("hint");
  const workMinEl = $("work-min");
  const breakMinEl = $("break-min");
  const longBreakMinEl = $("long-break-min");
  const longBreakEveryEl = $("long-break-every");

  const btnStart = $("btn-start") as HTMLButtonElement;
  const btnPause = $("btn-pause") as HTMLButtonElement;
  const btnReset = $("btn-reset") as HTMLButtonElement;

  const settingsModal = $("settings") as HTMLElement;
  const btnSettings = $("btn-settings") as HTMLButtonElement;
  const setWork = $("set-work") as HTMLInputElement;
  const setBreak = $("set-break") as HTMLInputElement;
  const setLongBreak = $("set-long-break") as HTMLInputElement;
  const setLongBreakEvery = $("set-long-break-every") as HTMLInputElement;
  const btnSettingsCancel = $("btn-settings-cancel") as HTMLButtonElement;
  const btnSettingsSave = $("btn-settings-save") as HTMLButtonElement;
  const btnResetData = $("btn-reset-data") as HTMLButtonElement;
  const notifStatus = $("notif-status") as HTMLElement;
  const btnTestNotif = $("btn-test-notif") as HTMLButtonElement;

  const popup = $("popup") as HTMLElement;
  const btnSnooze = $("btn-snooze") as HTMLButtonElement;
  const btnBreak = $("btn-break") as HTMLButtonElement;
  const nextTaskWrap = $("next-task-wrap") as HTMLElement;
  const nextTaskInput = $("next-task") as HTMLInputElement;
  const taskReminder = $("task-reminder") as HTMLElement;
  const taskReminderText = $("task-reminder-text") as HTMLElement;

  function persist() {
    writeSettings(state.settings);
    writeState({
      mode: state.mode,
      awaiting: state.awaiting,
      running: state.running,
      endsAtMs: state.endsAtMs,
      remainingMs: state.remainingMs,
      loopsSinceLongBreak: state.loopsSinceLongBreak,
      isNextBreakLong: state.isNextBreakLong,
      nextTask: state.nextTask,
    });
  }

  function syncUi() {
    modeEl.textContent = modeLabel(state.mode);
    hintEl.textContent = hintLabel(state);

    workMinEl.textContent = String(state.settings.workMinutes);
    breakMinEl.textContent = String(state.settings.breakMinutes);
    longBreakMinEl.textContent = String(state.settings.longBreakMinutes);
    longBreakEveryEl.textContent = String(state.settings.longBreakEvery);

    btnStart.disabled = state.running;
    btnPause.disabled = !state.running;

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
    state.running = false;
    state.endsAtMs = null;
    if (state.mode === "break") {
      state.remainingMs = msFromMinutes(
        state.isNextBreakLong ? state.settings.longBreakMinutes : state.settings.breakMinutes
      );
    } else {
      state.remainingMs = msFromMinutes(state.settings.workMinutes);
    }
    persist();
    syncUi();
  }

  function computeNextBreakIsLong() {
    // long break after N completed work sessions
    const nextLoops = state.loopsSinceLongBreak + 1;
    return nextLoops % state.settings.longBreakEvery === 0;
  }

  async function showBreakPopup() {
    popupContext = "work-ended";
    // decide long break for next break
    state.isNextBreakLong = computeNextBreakIsLong();

    nextTaskInput.value = "";
    show(nextTaskWrap);
    hide(taskReminder);

    ( $("popup-title") as HTMLElement).textContent = state.isNextBreakLong ? "Time for a long break" : "Time for a break";
    ( $("popup-text") as HTMLElement).textContent = "Before the break starts, write what you will do after the break.";
    ( $("btn-break") as HTMLButtonElement).textContent = state.isNextBreakLong ? "Start long break" : "Start break";

    show(popup);
    await ensureNotificationPermission();
    await focusAndTop();
    alarm();
    notify("Break timer", state.isNextBreakLong ? "Time for a long break" : "Time for a break");
    startNag("break");
    persist();
    syncUi();
  }

  async function showBackToWorkPopup() {
    popupContext = "break-ended";

    hide(nextTaskWrap);
    if (state.nextTask.trim()) {
      taskReminderText.textContent = state.nextTask.trim();
      show(taskReminder);
    } else {
      hide(taskReminder);
    }

    ( $("popup-title") as HTMLElement).textContent = "Back to work";
    ( $("popup-text") as HTMLElement).textContent = state.nextTask.trim()
      ? "Go start the thing you wrote."
      : "Break is done. Ready for another round?";
    ( $("btn-break") as HTMLButtonElement).textContent = "Start work";

    show(popup);
    await ensureNotificationPermission();
    await focusAndTop();
    alarm();
    notify("Break timer", "Break is done — back to work");
    startNag("work");
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
  btnSettings.addEventListener("click", async () => {
    setWork.value = String(state.settings.workMinutes);
    setBreak.value = String(state.settings.breakMinutes);
    setLongBreak.value = String(state.settings.longBreakMinutes);
    setLongBreakEvery.value = String(state.settings.longBreakEvery);

    const enabled = await notificationsEnabled();
    notifStatus.textContent = enabled
      ? "Enabled"
      : "Disabled (allow notifications in system settings)";

    show(settingsModal);
  });

  btnSettingsCancel.addEventListener("click", () => hide(settingsModal));

  btnTestNotif.addEventListener("click", async () => {
    await ensureNotificationPermission();
    notify("Break timer", "This is a test notification.");
    const enabled = await notificationsEnabled();
    notifStatus.textContent = enabled
      ? "Enabled"
      : "Disabled (allow notifications in system settings)";
  });

  btnResetData.addEventListener("click", () => {
    localStorage.removeItem(LS_SETTINGS);
    localStorage.removeItem(LS_STATE);

    state.settings = { ...DEFAULTS };
    state.mode = "idle";
    state.awaiting = "none";
    state.running = false;
    state.endsAtMs = null;
    state.remainingMs = msFromMinutes(state.settings.workMinutes);
    state.loopsSinceLongBreak = 0;
    state.isNextBreakLong = false;
    state.nextTask = "";

    persist();
    syncUi();
    hide(settingsModal);
  });

  btnSettingsSave.addEventListener("click", () => {
    state.settings = {
      workMinutes: clamp(Number(setWork.value || DEFAULTS.workMinutes), 1, 240),
      breakMinutes: clamp(Number(setBreak.value || DEFAULTS.breakMinutes), 1, 120),
      longBreakMinutes: clamp(
        Number(setLongBreak.value || DEFAULTS.longBreakMinutes),
        1,
        240
      ),
      longBreakEvery: clamp(
        Number(setLongBreakEvery.value || DEFAULTS.longBreakEvery),
        2,
        20
      ),
    };

    if (!state.running) {
      if (state.mode === "break") {
        state.remainingMs = msFromMinutes(
          state.isNextBreakLong ? state.settings.longBreakMinutes : state.settings.breakMinutes
        );
      } else {
        state.remainingMs = msFromMinutes(state.settings.workMinutes);
      }
    }

    persist();
    syncUi();
    hide(settingsModal);
  });

  // Main controls
  btnStart.addEventListener("click", () => {
    stopNag();

    if (state.awaiting === "break") {
      state.mode = "break";
      const dur = msFromMinutes(
        state.isNextBreakLong ? state.settings.longBreakMinutes : state.settings.breakMinutes
      );
      startCountdown(dur);
      return;
    }

    if (state.awaiting === "work") {
      state.mode = "work";
      startCountdown(msFromMinutes(state.settings.workMinutes));
      return;
    }

    if (state.mode === "idle") state.mode = "work";
    startCountdown(state.remainingMs || msFromMinutes(state.settings.workMinutes));
  });

  btnPause.addEventListener("click", () => pauseCountdown());
  btnReset.addEventListener("click", () => resetCountdown());

  // Popup controls
  btnSnooze.addEventListener("click", async () => {
    stopNag();
    popupContext = null;
    state.awaiting = "none";
    hide(popup);

    state.mode = "work";
    startCountdown(msFromMinutes(5));

    await dropTop();
  });

  btnBreak.addEventListener("click", async () => {
    stopNag();
    hide(popup);

    if (popupContext === "break-ended" || state.awaiting === "work") {
      popupContext = null;
      // Clear task after we show it.
      state.nextTask = "";
      state.mode = "work";
      startCountdown(msFromMinutes(state.settings.workMinutes));
      await dropTop();
      return;
    }

    // work ended -> start break
    popupContext = null;

    // Store next task (one-shot)
    state.nextTask = nextTaskInput.value.trim();

    // Update loops counter; reset when long break is taken
    state.loopsSinceLongBreak += 1;
    const longNow = state.isNextBreakLong;
    if (longNow) {
      state.loopsSinceLongBreak = 0;
    }

    state.mode = "break";
    const dur = msFromMinutes(longNow ? state.settings.longBreakMinutes : state.settings.breakMinutes);
    startCountdown(dur);

    await dropTop();
  });

  // (no-op; used by tray)
  (window as any).__breakTimerShow = async () => {
    await invoke("show_main_window");
  };

  // Tick loop
  syncUi();

  window.setInterval(async () => {
    const now = Date.now();
    const remaining = computeRemaining(state, now);
    timeEl.textContent = fmt(remaining);

    if (!state.running) return;

    if (remaining <= 0) {
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
