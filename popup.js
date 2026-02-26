(function () {
  'use strict';

  const courseListEl = document.getElementById('course-list');
  const emptyStateEl = document.getElementById('empty-state');
  const errorStateEl = document.getElementById('error-state');
  const saveBtn = document.getElementById('save-btn');
  const darkToggle = document.getElementById('dark-mode-toggle');

  // Tracks edits made in the popup before the user hits Save.
  const pendingEdits = {};

  // Tab reference shared between dark mode and course rename logic.
  let currentTab = null;

  // ── Tab helpers ──────────────────────────────────────────────────────────────

  async function getActiveTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function sendToContentScript(tab, message) {
    return chrome.tabs.sendMessage(tab.id, message);
  }

  // ── Rendering ────────────────────────────────────────────────────────────────

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

      row.appendChild(label);
      row.appendChild(input);
      fragment.appendChild(row);
    });

    courseListEl.appendChild(fragment);
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  async function saveNames(tab) {
    // Merge pending edits on top of what's already in storage.
    const existing = await chrome.storage.local.get(null);
    const allNames = { ...existing };

    for (const [id, name] of Object.entries(pendingEdits)) {
      if (name === '') {
        delete allNames[id]; // Empty = remove override, restore original.
      } else {
        allNames[id] = name;
      }
    }

    await chrome.storage.local.set(allNames);

    // Send only course-ID entries to the content script.
    const courseNames = Object.fromEntries(
      Object.entries(allNames).filter(([k]) => /^\d+$/.test(k))
    );

    try {
      await sendToContentScript(tab, { type: 'APPLY_NAMES', names: courseNames });
    } catch {
      // Content script may have unloaded; names are persisted and will apply on reload.
    }

    saveBtn.disabled = true;
    Object.keys(pendingEdits).forEach((k) => delete pendingEdits[k]);
  }

  // ── Dark mode ─────────────────────────────────────────────────────────────────

  async function initDarkMode() {
    const { darkMode } = await chrome.storage.local.get('darkMode');
    darkToggle.checked = !!darkMode;

    darkToggle.addEventListener('change', async () => {
      const enabled = darkToggle.checked;
      await chrome.storage.local.set({ darkMode: enabled });
      if (currentTab) {
        try {
          await sendToContentScript(currentTab, { type: 'SET_DARK_MODE', enabled });
        } catch {
          // Not a Brightspace tab or content script unavailable; preference saved for next load.
        }
      }
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    initDarkMode(); // runs in parallel — dark mode works even if course list fails

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
