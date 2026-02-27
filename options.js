(function () {
  'use strict';

  const DEFAULT_THEME = {
    background: '#121212',
    surface:    '#1e1e1e',
    border:     '#2d2d2d',
    accent:     '#4d9de0',
  };

  const GROUPS = ['background', 'surface', 'border', 'accent'];
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;

  // ── DOM refs ─────────────────────────────────────────────────────────────────

  const saveBtn  = document.getElementById('save-btn');
  const resetBtn = document.getElementById('reset-btn');

  function inputEl(key)  { return document.getElementById(`input-${key}`);  }
  function swatchEl(key) { return document.getElementById(`swatch-${key}`); }

  // ── Helpers ───────────────────────────────────────────────────────────────────

  function normalizeHex(raw) {
    const val = raw.trim();
    // Accept with or without leading #
    if (/^[0-9a-fA-F]{6}$/.test(val)) return `#${val}`;
    if (HEX_RE.test(val)) return val.toLowerCase();
    return null;
  }

  function setRow(key, hex) {
    const input  = inputEl(key);
    const swatch = swatchEl(key);
    input.value       = hex;
    swatch.style.background = hex;
    input.classList.remove('invalid');
  }

  function readCurrentColors() {
    const colors = {};
    for (const key of GROUPS) {
      const hex = normalizeHex(inputEl(key).value);
      colors[key] = hex || DEFAULT_THEME[key];
    }
    return colors;
  }

  function hasChanges(stored) {
    for (const key of GROUPS) {
      if (inputEl(key).value !== (stored[key] || DEFAULT_THEME[key])) return true;
    }
    return false;
  }

  // ── Apply to all open Brightspace tabs ───────────────────────────────────────

  async function broadcastTheme(colors) {
    const tabs = await chrome.tabs.query({
      url: ['*://*.brightspace.com/*', '*://brightspace.utrgv.edu/*'],
    });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'APPLY_THEME', colors }).catch(() => {});
    }
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  async function save() {
    // Validate all inputs first
    let allValid = true;
    for (const key of GROUPS) {
      const hex = normalizeHex(inputEl(key).value);
      if (!hex) {
        inputEl(key).classList.add('invalid');
        allValid = false;
      } else {
        setRow(key, hex); // normalize in place
      }
    }
    if (!allValid) return;

    const colors = readCurrentColors();
    await chrome.storage.local.set({ themeColors: colors });
    await broadcastTheme(colors);

    saveBtn.disabled = true;
  }

  // ── Reset ─────────────────────────────────────────────────────────────────────

  function reset() {
    for (const key of GROUPS) {
      setRow(key, DEFAULT_THEME[key]);
    }
    saveBtn.disabled = false;
  }

  // ── Input listeners ──────────────────────────────────────────────────────────

  function wireInputs(stored) {
    for (const key of GROUPS) {
      inputEl(key).addEventListener('input', (e) => {
        const raw = e.target.value;
        const hex = normalizeHex(raw);
        if (hex) {
          swatchEl(key).style.background = hex;
          e.target.classList.remove('invalid');
        } else {
          e.target.classList.toggle('invalid', raw.length > 0);
        }
        saveBtn.disabled = !hasChanges(stored);
      });
    }
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    const { themeColors } = await chrome.storage.local.get('themeColors');
    const saved = { ...DEFAULT_THEME, ...(themeColors || {}) };

    for (const key of GROUPS) {
      setRow(key, saved[key]);
    }

    wireInputs(saved);
    saveBtn.addEventListener('click', save);
    resetBtn.addEventListener('click', reset);
  }

  init();
})();
