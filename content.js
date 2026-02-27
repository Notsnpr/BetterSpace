(function () {
  'use strict';

  let savedNames = {};
  let debounceTimer = null;
  let isDarkMode = false;
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
    const elements = findCourseElements();
    elements.forEach(({ id, dCard, orgName, enrollCard }) => {
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

    if (isDarkMode) applyCardEnhancements(elements);
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

  // ── Card visual enhancements ─────────────────────────────────────────────────
  //
  // Each course card gets a unique vibrant gradient assigned by course ID.
  // Styles are injected into d2l-card's shadow root via adoptedStyleSheets so
  // they survive Lit re-renders without observer loops.
  // CSS custom property --bs-card-gradient is set on the host element and
  // inherits into the shadow root automatically.

  const CARD_GRADIENTS = [
    'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',  // pink → red
    'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',  // blue → cyan
    'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',  // green → teal
    'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',  // pink → yellow
    'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',  // purple → pink
    'linear-gradient(135deg, #fccb90 0%, #d57eeb 100%)',  // orange → purple
    'linear-gradient(135deg, #a1c4fd 0%, #c2e9fb 100%)',  // periwinkle → sky
    'linear-gradient(135deg, #84fab0 0%, #8fd3f4 100%)',  // mint → sky blue
  ];

  function getCardGradient(courseId) {
    return CARD_GRADIENTS[parseInt(courseId, 10) % CARD_GRADIENTS.length];
  }

  let bsCardSheet = null;

  function getBsCardSheet() {
    if (bsCardSheet) return bsCardSheet;
    bsCardSheet = new CSSStyleSheet();
    bsCardSheet.replaceSync(`
      :host {
        position: relative !important;
        border-radius: 14px !important;
        overflow: hidden !important;
        box-shadow: 0 2px 14px rgba(0, 0, 0, 0.4) !important;
        transition: transform 0.2s ease, box-shadow 0.2s ease !important;
        display: block !important;
      }

      /* Gradient accent stripe along the top of each card */
      :host::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: 4px;
        background: var(--bs-card-gradient, linear-gradient(135deg, #4facfe, #00f2fe));
        z-index: 10;
        pointer-events: none;
      }

      :host(:hover) {
        transform: translateY(-4px) !important;
        box-shadow:
          0 8px 30px rgba(0, 0, 0, 0.55),
          0 0 0 1px rgba(255, 255, 255, 0.08) !important;
      }

      /* If Brightspace passes a header image/thumbnail as slotted content,
         replace it with the gradient for a full-height colored header. */
      ::slotted([class*="image"]),
      ::slotted([class*="header"]),
      ::slotted([class*="thumbnail"]),
      ::slotted([class*="banner"]) {
        background: var(--bs-card-gradient, linear-gradient(135deg, #4facfe, #00f2fe)) !important;
      }
    `);
    return bsCardSheet;
  }

  function applyCardEnhancements(elements) {
    const sheet = getBsCardSheet();
    elements.forEach(({ id, dCard }) => {
      // Set gradient on host — CSS custom property inherits into shadow root.
      dCard.style.setProperty('--bs-card-gradient', getCardGradient(id));

      if (dCard.shadowRoot && !dCard.shadowRoot.adoptedStyleSheets.includes(sheet)) {
        dCard.shadowRoot.adoptedStyleSheets = [...dCard.shadowRoot.adoptedStyleSheets, sheet];
      }
    });
  }

  function removeCardEnhancements(elements) {
    elements.forEach(({ dCard }) => {
      dCard.style.removeProperty('--bs-card-gradient');
      if (dCard.shadowRoot && bsCardSheet) {
        dCard.shadowRoot.adoptedStyleSheets =
          dCard.shadowRoot.adoptedStyleSheets.filter((s) => s !== bsCardSheet);
      }
    });
  }

  // ── Dark mode ────────────────────────────────────────────────────────────────
  //
  // Strategy: CSS custom properties inherit across Shadow DOM boundaries, so
  // overriding Brightspace's own design tokens on :root propagates into every
  // d2l-* component without needing JS tricks or filter hacks.

  const DEFAULT_THEME = {
    background: '#121212',
    surface:    '#1e1e1e',
    border:     '#2d2d2d',
    accent:     '#4d9de0',
  };

  function buildDarkModeCSS(colors) {
    const c = { ...DEFAULT_THEME, ...colors };
    return `
      /* ── Body & page structure ───────────────────────────────────────────────── */
      html.bs-dark-mode,
      html.bs-dark-mode body {
        background-color: ${c.background} !important;
        color: #e8e8e8;
        scrollbar-color: ${c.border} ${c.background};
      }

      html.bs-dark-mode .d2l-page-main,
      html.bs-dark-mode .d2l-page-main-padding,
      html.bs-dark-mode .d2l-homepage {
        background-color: ${c.background} !important;
      }

      html.bs-dark-mode .homepage-container,
      html.bs-dark-mode .homepage-row {
        background-color: ${c.background} !important;
      }

      /* ── CSS custom properties — propagate into all shadow roots ─────────────── */
      html.bs-dark-mode {
        /* Backgrounds */
        --d2l-color-white: ${c.surface};
        --d2l-color-sylvite: ${c.background};
        --d2l-color-regolith: ${c.background};
        /* Borders */
        --d2l-color-gypsum: ${c.border};
        --d2l-color-mica: ${c.border};
        --d2l-color-corundum: ${c.border};
        /* Text (fixed — not user-customizable) */
        --d2l-color-ferrite: #e8e8e8;
        --d2l-color-galena: #b8b8b8;
        --d2l-color-tungsten: #969696;
        --d2l-color-titanium: #707070;
        /* Accent */
        --d2l-color-celestine: ${c.accent};
        --d2l-color-celestine-plus-1: ${c.accent};
        --d2l-color-celestine-minus-1: ${c.accent};
        --d2l-color-celestine-plus-2: ${c.background};
        --d2l-color-primary-accent-action: ${c.accent};
        /* Status (fixed) */
        --d2l-color-feedback-error: #ff6b6b;
        --d2l-color-feedback-warning: #ffb84d;
        --d2l-color-feedback-success: #4dcc40;
        --d2l-color-feedback-action: ${c.accent};
        --d2l-color-feedback-info: ${c.accent};
        /* Inputs */
        --d2l-input-background-color: ${c.surface};
        --d2l-input-border-color: ${c.border};
        --d2l-input-text-color: #e8e8e8;
      }

      /* ── Navigation ──────────────────────────────────────────────────────────── */
      /* Secondary nav band — UTRGV hardcodes background-color: #4C4A4F here */
      html.bs-dark-mode .d2l-branding-navigation-background-color {
        background-color: #18181c !important;
      }

      html.bs-dark-mode .d2l-navigation-s {
        border-bottom-color: ${c.border} !important;
      }

      /* Nav menu group buttons and direct links (slotted light-DOM elements) */
      html.bs-dark-mode .d2l-navigation-s-group-text,
      html.bs-dark-mode .d2l-navigation-s-link {
        color: #c8c8c8 !important;
      }

      html.bs-dark-mode .d2l-navigation-s-group-text:hover,
      html.bs-dark-mode .d2l-navigation-s-link:hover {
        color: #ffffff !important;
      }

      /* Profile/user display name in header */
      html.bs-dark-mode .d2l-navigation-s-personal-menu-text {
        color: #e8e8e8 !important;
      }

      /* Personal tools dropdown (Profile, Notifications, etc.) */
      html.bs-dark-mode .d2l-personal-tools-list {
        background-color: ${c.surface} !important;
      }

      html.bs-dark-mode .d2l-personal-tools-category-item,
      html.bs-dark-mode .d2l-personal-tools-separated-item {
        border-color: ${c.border} !important;
      }

      /* ── Course banner ───────────────────────────────────────────────────────── */
      html.bs-dark-mode .d2l-course-banner-container,
      html.bs-dark-mode .d2l-course-banner {
        background-color: ${c.surface} !important;
      }

      /* Error fallback SVG placeholder in the banner */
      html.bs-dark-mode .d2l-course-banner-error-image-container {
        background-color: ${c.surface} !important;
        opacity: 0.4;
      }

      /* ── Homepage widget tiles ───────────────────────────────────────────────── */
      html.bs-dark-mode .d2l-widget,
      html.bs-dark-mode .d2l-tile {
        background-color: ${c.surface} !important;
        border-color: ${c.border} !important;
      }

      html.bs-dark-mode .d2l-widget.d2l-tile {
        box-shadow: 0 2px 12px rgba(0, 0, 0, 0.5) !important;
      }

      html.bs-dark-mode .d2l-widget-header {
        background-color: ${c.surface} !important;
        border-bottom: 1px solid ${c.border} !important;
      }

      html.bs-dark-mode .d2l-widget-content,
      html.bs-dark-mode .d2l-widget-content-padding {
        background-color: ${c.surface} !important;
      }

      /* ── Headings & text ─────────────────────────────────────────────────────── */
      html.bs-dark-mode h1,
      html.bs-dark-mode h2,
      html.bs-dark-mode h3,
      html.bs-dark-mode h4,
      html.bs-dark-mode .d2l-heading,
      html.bs-dark-mode .vui-heading-2,
      html.bs-dark-mode .vui-heading-4 {
        color: #e8e8e8 !important;
      }

      html.bs-dark-mode p {
        color: #d0d0d0 !important;
      }

      /* ── Links ───────────────────────────────────────────────────────────────── */
      html.bs-dark-mode a,
      html.bs-dark-mode .d2l-link {
        color: ${c.accent} !important;
      }

      html.bs-dark-mode a:hover,
      html.bs-dark-mode .d2l-link:hover {
        color: #7bbfff !important;
      }

      /* ── Events/calendar list ────────────────────────────────────────────────── */
      html.bs-dark-mode ul.localist-simple-list li {
        border-top-color: ${c.border} !important;
      }

      html.bs-dark-mode ul.localist-simple-list li a {
        color: #c8c8c8 !important;
      }

      html.bs-dark-mode ul.localist-simple-list li a .description {
        color: #c8c8c8 !important;
      }

      html.bs-dark-mode ul.localist-simple-list li a:hover .description {
        color: ${c.accent} !important;
        text-decoration-color: ${c.accent} !important;
      }

      /* ── Session expiry message ──────────────────────────────────────────────── */
      html.bs-dark-mode .d2l-page-message {
        background-color: ${c.surface} !important;
        color: #e8e8e8 !important;
        border-color: ${c.border} !important;
      }
    `;
  }

  function injectDarkModeStyles(colors) {
    let style = document.getElementById('bs-dark-mode-style');
    if (!style) {
      style = document.createElement('style');
      style.id = 'bs-dark-mode-style';
      document.head.appendChild(style);
    }
    style.textContent = buildDarkModeCSS(colors);
  }

  function applyDarkMode(enabled) {
    isDarkMode = enabled;
    document.documentElement.classList.toggle('bs-dark-mode', enabled);
    const elements = findCourseElements();
    if (enabled) {
      applyCardEnhancements(elements);
    } else {
      removeCardEnhancements(elements);
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
    if (message.type === 'APPLY_THEME') {
      injectDarkModeStyles(message.colors);
      sendResponse({ ok: true });
    }
  });

  // ── Recursive MutationObserver ───────────────────────────────────────────────
  // Watches all shadow roots so we catch cards that load lazily (e.g. tab switches).
  // The equality check in applyAllNames() prevents infinite observer loops.

  function scheduleApply() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(applyAllNames, 150);
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
    const stored = await chrome.storage.local.get(['darkMode', 'themeColors']);
    injectDarkModeStyles(stored.themeColors || {});
    applyDarkMode(!!stored.darkMode);

    await loadSavedNames();
    observeRoot(document.body);
    applyAllNames();
  }

  init();
})();
