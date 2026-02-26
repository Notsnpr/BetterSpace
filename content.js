(function () {
  'use strict';

  let savedNames = {};
  let debounceTimer = null;
  const observedRoots = new WeakSet();

  // ── Storage ──────────────────────────────────────────────────────────────────

  async function loadSavedNames() {
    const result = await chrome.storage.local.get(null);
    savedNames = Object.fromEntries(
      Object.entries(result).filter(([k]) => /^\d+$/.test(k))
    );
  }

  // ── Shadow DOM traversal ─────────────────────────────────────────────────────
  // Brightspace nests components ~5 shadow roots deep, so we recurse.

  function queryShadowAll(selector, root) {
    const results = [...root.querySelectorAll(selector)];
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) results.push(...queryShadowAll(selector, el.shadowRoot));
    });
    return results;
  }

  // ── Course element discovery ─────────────────────────────────────────────────
  //
  // Structure (all inside shadow roots):
  //   d2l-enrollment-card
  //     shadowRoot
  //       d2l-card [href="/d2l/home/{id}"]   ← course ID lives here
  //       d2l-organization-name              ← VISIBLE text lives here
  //         shadowRoot → text node

  function extractCourseId(dCard) {
    const match = (dCard.getAttribute('href') || '').match(/\/d2l\/home\/(\d+)/);
    return match ? match[1] : null;
  }

  function findCourseElements() {
    const results = [];
    queryShadowAll('d2l-enrollment-card', document.body).forEach((enrollCard) => {
      if (!enrollCard.shadowRoot) return;
      const dCard = enrollCard.shadowRoot.querySelector('d2l-card');
      if (!dCard) return;
      const id = extractCourseId(dCard);
      if (!id) return;
      const orgName = enrollCard.shadowRoot.querySelector('d2l-organization-name');
      if (!orgName || !orgName.shadowRoot) return;

      // Stamp the original visible name once, only after d2l-organization-name has loaded.
      if (!enrollCard.dataset.bsOriginal) {
        const text = orgName.shadowRoot.textContent.trim();
        if (text) enrollCard.dataset.bsOriginal = text;
      }

      results.push({ id, dCard, orgName, enrollCard });
    });
    return results;
  }

  // ── Apply names ──────────────────────────────────────────────────────────────

  function applyAllNames() {
    findCourseElements().forEach(({ id, dCard, orgName, enrollCard }) => {
      const customName = savedNames[id];
      const original = enrollCard.dataset.bsOriginal;
      const displayName = customName || original;
      if (!displayName) return;

      // Only write if the value is actually changing — prevents observer loops.
      if (orgName.shadowRoot.textContent.trim() !== displayName) {
        orgName.shadowRoot.textContent = displayName;
      }

      // Also update the offscreen span in d2l-card (screen reader / accessibility).
      if (dCard.getAttribute('text') !== displayName) {
        dCard.setAttribute('text', displayName);
      }
    });
  }

  // ── Course list for popup ────────────────────────────────────────────────────

  function buildCourseList() {
    return findCourseElements()
      .filter(({ enrollCard }) => enrollCard.dataset.bsOriginal) // skip not-yet-loaded
      .map(({ id, enrollCard }) => ({
        id,
        originalName: enrollCard.dataset.bsOriginal,
        savedName: savedNames[id] || '',
      }));
  }

  // ── Dark mode ────────────────────────────────────────────────────────────────

  function injectDarkModeStyles() {
    if (document.getElementById('bs-dark-mode-style')) return;
    const style = document.createElement('style');
    style.id = 'bs-dark-mode-style';
    // CSS handles light-DOM video/iframe double-invert.
    // Images are handled via JS (see applyImageCounterFilter) because shadow DOM
    // images can't be reached with CSS selectors.
    style.textContent = `
      html.bs-dark-mode {
        filter: invert(1) hue-rotate(180deg);
      }
      html.bs-dark-mode video,
      html.bs-dark-mode iframe {
        filter: invert(1) hue-rotate(180deg);
      }
    `;
    document.head.appendChild(style);
  }

  // Apply a counter-filter to every img (including inside shadow DOMs) so they
  // get double-inverted back to their original colors.
  function applyImageCounterFilter() {
    queryShadowAll('img', document.body).forEach((img) => {
      img.style.filter = 'invert(1) hue-rotate(180deg)';
    });
  }

  function removeImageCounterFilter() {
    queryShadowAll('img', document.body).forEach((img) => {
      img.style.filter = '';
    });
  }

  function applyDarkMode(enabled) {
    document.documentElement.classList.toggle('bs-dark-mode', enabled);
    if (enabled) {
      applyImageCounterFilter();
    } else {
      removeImageCounterFilter();
    }
  }

  // ── Messages ─────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_COURSES') {
      sendResponse({ courses: buildCourseList() });
    }
    if (message.type === 'APPLY_NAMES') {
      savedNames = message.names;
      applyAllNames();
      sendResponse({ ok: true });
    }
    if (message.type === 'SET_DARK_MODE') {
      applyDarkMode(message.enabled);
      sendResponse({ ok: true });
    }
  });

  // ── Recursive MutationObserver ───────────────────────────────────────────────
  // Watches all shadow roots so we catch cards that load lazily (e.g. tab switches).
  // The equality check in applyAllNames() prevents infinite observer loops.

  function scheduleApply() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      applyAllNames();
      if (document.documentElement.classList.contains('bs-dark-mode')) {
        applyImageCounterFilter();
      }
    }, 150);
  }

  function observeRoot(root) {
    if (observedRoots.has(root)) return;
    observedRoots.add(root);
    new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE && node.shadowRoot) {
            observeRoot(node.shadowRoot);
          }
        }
      }
      scheduleApply();
    }).observe(root, { childList: true, subtree: true });
    root.querySelectorAll('*').forEach((el) => {
      if (el.shadowRoot) observeRoot(el.shadowRoot);
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────────

  async function init() {
    const { darkMode } = await chrome.storage.local.get('darkMode');
    injectDarkModeStyles();
    applyDarkMode(!!darkMode);

    await loadSavedNames();
    observeRoot(document.body);
    applyAllNames();
  }

  init();
})();
