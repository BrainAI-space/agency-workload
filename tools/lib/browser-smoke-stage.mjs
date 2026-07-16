export const browserSmokeStages = Object.freeze([
  "startup",
  "login-transition",
  "otp-wait",
  "desktop-schedule-transition",
  "desktop-schedule-ready",
  "desktop-admin-transition",
  "desktop-admin-ready",
  "mobile-schedule-transition",
  "mobile-schedule-ready",
  "mobile-more-transition",
  "mobile-leave-transition",
  "mobile-leave-ready",
  "mobile-admin-transition",
  "mobile-admin-ready",
  "keyboard-focus",
]);

export const browserSmokeNavigationTransitionStages = Object.freeze([
  "login-transition",
  "desktop-schedule-transition",
  "desktop-admin-transition",
  "mobile-schedule-transition",
  "mobile-more-transition",
  "mobile-leave-transition",
  "mobile-admin-transition",
]);

export const browserSmokeReadyStages = Object.freeze([
  "otp-wait",
  "desktop-schedule-ready",
  "desktop-admin-ready",
  "mobile-schedule-ready",
  "mobile-leave-ready",
  "mobile-admin-ready",
  "keyboard-focus",
]);

const allowedStages = new Set(browserSmokeStages);
const transitionStages = new Set(browserSmokeNavigationTransitionStages);
for (const readyStage of browserSmokeReadyStages) {
  if (transitionStages.has(readyStage))
    throw new Error("Browser smoke ready stage is transitional");
}

export function safeBrowserSmokeStage(value) {
  return allowedStages.has(value) ? value : "unknown";
}
