(function () {
  'use strict';

  // In-memory cache of saved names, populated on startup and after APPLY_NAMES.
  let savedNames = {};

  // ── Storage helpers ──────────────────────────────────────────────────────────

  async function loadSavedNames() {
    const result = await chrome.storage.local.get(null);
    // Only keep numeric-keyed entries (course IDs).
    savedNames = Object.fromEntries(
      Object.entries(result).filter(([k]) => /^\d+$/.test(k))
    );
  }

  // ── Course ID extraction ─────────────────────────────────────────────────────

  function extractCourseId(card) {
    const href = card.getAttribute('href') || '';
    const match = href.match(/\/d2l\/home\/(\d+)/);
    return match ? match[1] : null;
  }

  function getOriginalText(card) {
    // Stamp the original Brightspace name once, before we ever mutate the attribute.
    if (!card.dataset.bsOriginal) {
      card.dataset.bsOriginal = card.getAttribute('text') || '';
    }
    return card.dataset.bsOriginal;
  }

  // ── Shadow DOM rename ────────────────────────────────────────────────────────

  function applyNameToCard(card, newName) {
    const displayName = newName || card.dataset.bsOriginal || card.getAttribute('text') || '';

    // Step A: update the host attribute so LitElement re-renders with our name.
    card.setAttribute('text', displayName);

    // Step B: update the shadow span immediately to avoid the async re-render flash.
    const shadowRoot = card.shadowRoot;
    if (shadowRoot) {
      const span = shadowRoot.querySelector('.d2l-card-link-text');
      if (span) {
        span.textContent = displayName;
      }
    }
  }

  function restoreCard(card) {
    applyNameToCard(card, card.dataset.bsOriginal || '');
  }

  // ── Apply all saved names to all current cards ───────────────────────────────

  function applyAllNames() {
    const cards = document.querySelectorAll('d2l-card');
    cards.forEach((card) => {
      const id = extractCourseId(card);
      if (!id) return;

      // Preserve original before any mutation.
      getOriginalText(card);

      if (savedNames[id]) {
        applyNameToCard(card, savedNames[id]);
      } else {
        restoreCard(card);
      }
    });
  }

  // ── Course list builder (for popup) ─────────────────────────────────────────

  function buildCourseList() {
    const cards = document.querySelectorAll('d2l-card');
    const courses = [];
    cards.forEach((card) => {
      const id = extractCourseId(card);
      if (!id) return;
      courses.push({
        id,
        originalName: getOriginalText(card),
        savedName: savedNames[id] || '',
      });
    });
    return courses;
  }

  // ── Message listener ─────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'GET_COURSES') {
      sendResponse({ courses: buildCourseList() });
    }

    if (message.type === 'APPLY_NAMES') {
      savedNames = message.names;
      applyAllNames();
      sendResponse({ ok: true });
    }
  });

  // ── MutationObserver ─────────────────────────────────────────────────────────

  // Debounce to batch a full page of cards rendering at once (SPA navigation).
  let debounceTimer = null;

  function scheduleApply() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyAllNames, 150);
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        const hasCard =
          node.tagName === 'D2L-CARD' ||
          node.querySelector?.('d2l-card') !== null;
        if (hasCard) {
          scheduleApply();
          return;
        }
      }
    }
  });

  // ── Initialization ───────────────────────────────────────────────────────────

  async function init() {
    await loadSavedNames();
    applyAllNames();
    observer.observe(document.body, { childList: true, subtree: true });
  }

  init();
})();
