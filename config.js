// Committed config — safe to deploy ONLY if this key is restricted in Google
// Cloud Console (HTTP-referrer + PageSpeed Insights API only). It ships in the
// public page source, so an unrestricted key here can be abused by anyone.
// A local config.local.js (git-ignored) will override this if present.
window.BCAI_PSI_KEY = window.BCAI_PSI_KEY || 'AIzaSyBH6R8fKwrb7eAPOFOTCBxsuh7IHcckAwk';
