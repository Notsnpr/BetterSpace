(function () {
  'use strict';

  const courseListEl = document.getElementById('course-list');
  const emptyStateEl = document.getElementById('empty-state');
  const errorStateEl = document.getElementById('error-state');
  const saveBtn      = document.getElementById('save-btn');
  const darkToggle   = document.getElementById('dark-mode-toggle');

  const pendingEdits = {};
  const pendingImageEdits = {};
  let savedImages = {};
  let currentTab = null;

  const DEFAULT_THEME = {
    background: '#121212',
    surface:    '#1e1e1e',
    border:     '#2d2d2d',
    accent:     '#4d9de0',
  };
  const THEME_GROUPS = ['background', 'surface', 'border', 'accent'];
  const HEX_RE = /^#[0-9a-fA-F]{6}$/;

  // ── Tab helpers ──────────────────────────────────────────────────────────────

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToContentScript(tab, message) {
    return chrome.tabs.sendMessage(tab.id, message);
  }

  // ── Course list ──────────────────────────────────────────────────────────────

  function renderCourseList(courses) {
    courseListEl.innerHTML = '';

    if (courses.length === 0) {
      emptyStateEl.hidden = false;
      saveBtn.disabled = true;
      return;
    }

    emptyStateEl.hidden = true;
    saveBtn.disabled = false;

    const fragment = document.createDocumentFragment();
    courses.forEach(({ id, originalName, savedName }) => {
      const row = document.createElement('div');
      row.className = 'course-row';

      const label = document.createElement('label');
      label.className = 'original-name';
      label.textContent = originalName;
      label.setAttribute('for', `input-${id}`);

      const input = document.createElement('input');
      input.type = 'text';
      input.id = `input-${id}`;
      input.className = 'name-input';
      input.placeholder = originalName;
      input.value = savedName;
      input.setAttribute('aria-label', `Custom name for ${originalName}`);
      input.addEventListener('input', () => {
        pendingEdits[id] = input.value.trim();
        saveBtn.disabled = false;
      });

      const imageRow = document.createElement('div');
      imageRow.className = 'image-row';

      const imageInput = document.createElement('input');
      imageInput.type = 'text';
      imageInput.className = 'image-url-input';
      imageInput.placeholder = 'Background image URL…';
      imageInput.value = savedImages[id] || '';
      imageInput.addEventListener('input', () => {
        pendingImageEdits[id] = imageInput.value.trim();
        saveBtn.disabled = false;
      });

      const clearBtn = document.createElement('button');
      clearBtn.className = 'image-clear-btn';
      clearBtn.textContent = '✕';
      clearBtn.title = 'Clear image';
      clearBtn.addEventListener('click', () => {
        imageInput.value = '';
        pendingImageEdits[id] = '';
        saveBtn.disabled = false;
      });

      imageRow.appendChild(imageInput);
      imageRow.appendChild(clearBtn);

      row.appendChild(label);
      row.appendChild(input);
      row.appendChild(imageRow);
      fragment.appendChild(row);
    });

    courseListEl.appendChild(fragment);
  }

  async function saveNames(tab) {
    const existing = await chrome.storage.local.get(null);
    const allNames = { ...existing };

    for (const [id, name] of Object.entries(pendingEdits)) {
      if (name === '') {
        delete allNames[id];
      } else {
        allNames[id] = name;
      }
    }

    // Merge image edits
    const existingImages = { ...(existing.cardImages || {}) };
    for (const [id, url] of Object.entries(pendingImageEdits)) {
      if (url === '') delete existingImages[id];
      else existingImages[id] = url;
    }
    allNames.cardImages = existingImages;

    await chrome.storage.local.set(allNames);

    const courseNames = Object.fromEntries(
      Object.entries(allNames).filter(([k]) => /^\d+$/.test(k))
    );

    try {
      await sendToContentScript(tab, { type: 'APPLY_NAMES', names: courseNames });
    } catch { /* persisted, applies on next reload */ }

    try {
      await sendToContentScript(tab, { type: 'APPLY_IMAGES', images: existingImages });
    } catch { /* persisted, applies on next reload */ }

    savedImages = existingImages;
    saveBtn.disabled = true;
    Object.keys(pendingEdits).forEach((k) => delete pendingEdits[k]);
    Object.keys(pendingImageEdits).forEach((k) => delete pendingImageEdits[k]);
  }

  // ── Dark mode toggle ─────────────────────────────────────────────────────────

  async function initDarkMode() {
    const { darkMode } = await chrome.storage.local.get('darkMode');
    darkToggle.checked = !!darkMode;

    darkToggle.addEventListener('change', async () => {
      const enabled = darkToggle.checked;
      await chrome.storage.local.set({ darkMode: enabled });
      if (currentTab) {
        try {
          await sendToContentScript(currentTab, { type: 'SET_DARK_MODE', enabled });
        } catch { /* not a Brightspace tab */ }
      }
    });
  }

  // ── Theme panel ──────────────────────────────────────────────────────────────

  function normalizeHex(raw) {
    const val = raw.trim();
    if (/^[0-9a-fA-F]{6}$/.test(val)) return `#${val}`;
    if (HEX_RE.test(val)) return val.toLowerCase();
    return null;
  }

  function setColorRow(key, hex) {
    document.getElementById(`theme-input-${key}`).value = hex;
    document.getElementById(`swatch-${key}`).style.background = hex;
  }

  async function broadcastTheme(colors) {
    const tabs = await chrome.tabs.query({
      url: ['*://*.brightspace.com/*', '*://brightspace.utrgv.edu/*'],
    });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: 'APPLY_THEME', colors }).catch(() => {});
    }
  }

  async function initTheme() {
    const toggleBtn  = document.getElementById('theme-toggle');
    const content    = document.getElementById('theme-content');
    const arrow      = document.getElementById('theme-arrow');
    const applyBtn   = document.getElementById('theme-apply-btn');
    const resetBtn   = document.getElementById('theme-reset-btn');

    // Collapse / expand
    toggleBtn.addEventListener('click', () => {
      const opening = content.hidden;
      content.hidden = !opening;
      arrow.innerHTML = opening ? '&#9660;' : '&#9658;';
    });

    // Load saved colors
    const { themeColors } = await chrome.storage.local.get('themeColors');
    const saved = { ...DEFAULT_THEME, ...(themeColors || {}) };
    THEME_GROUPS.forEach((key) => setColorRow(key, saved[key]));

    // Live swatch update on input
    THEME_GROUPS.forEach((key) => {
      document.getElementById(`theme-input-${key}`).addEventListener('input', (e) => {
        const hex = normalizeHex(e.target.value);
        if (hex) {
          document.getElementById(`swatch-${key}`).style.background = hex;
          e.target.classList.remove('invalid');
        } else {
          e.target.classList.toggle('invalid', e.target.value.length > 0);
        }
        applyBtn.disabled = false;
      });
    });

    // Apply
    applyBtn.addEventListener('click', async () => {
      const colors = {};
      let allValid = true;
      for (const key of THEME_GROUPS) {
        const hex = normalizeHex(document.getElementById(`theme-input-${key}`).value);
        if (!hex) {
          document.getElementById(`theme-input-${key}`).classList.add('invalid');
          allValid = false;
        } else {
          setColorRow(key, hex); // normalize in place
          colors[key] = hex;
        }
      }
      if (!allValid) return;

      await chrome.storage.local.set({ themeColors: colors });
      await broadcastTheme(colors);
      applyBtn.disabled = true;
    });

    // Reset
    resetBtn.addEventListener('click', () => {
      THEME_GROUPS.forEach((key) => setColorRow(key, DEFAULT_THEME[key]));
      applyBtn.disabled = false;
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    initDarkMode();
    initTheme();

    const { cardImages } = await chrome.storage.local.get('cardImages');
    savedImages = cardImages || {};

    let tab;
    try {
      tab = await getActiveTab();
      currentTab = tab;
    } catch {
      errorStateEl.hidden = false;
      return;
    }

    let response;
    try {
      response = await sendToContentScript(tab, { type: 'GET_COURSES' });
    } catch {
      errorStateEl.hidden = false;
      return;
    }

    renderCourseList(response.courses);
    saveBtn.addEventListener('click', () => saveNames(tab));
  }

  init();
})();
