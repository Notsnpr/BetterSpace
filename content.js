(function () {
  'use strict';

  const isFrame = window !== window.top;

  let savedNames = {};
  let debounceTimer = null;
  let isDarkMode = false;
  const observedRoots = new WeakSet();
  const originalHeaderLogoSrc = new WeakMap();

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

    if (isDarkMode) {
      applyCardEnhancements(elements);
      applyAllCardDarkMode();
      applyPopoverDarkMode();
    }
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
        background: var(--bs-surface-2, #1e1e1e) !important;
        color: #e8e8e8 !important;
        border-radius: 14px !important;
        overflow: hidden !important;
        box-shadow: 0 2px 14px rgba(0, 0, 0, 0.55) !important;
        transition: transform 0.2s ease, box-shadow 0.2s ease !important;
        display: block !important;
      }

      :host([selected]),
      :host(:focus-within) {
        outline: none !important;
        box-shadow:
          0 2px 14px rgba(0, 0, 0, 0.55),
          0 0 0 3px color-mix(in srgb, var(--bs-accent-hover, #4d9de0) 35%, transparent) !important;
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

      /* Common internal containers */
      *,
      ::slotted(*) {
        color: inherit;
      }

      a {
        color: var(--d2l-link-color, var(--bs-accent-hover, #4d9de0)) !important;
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

  // Generic dark bg override for ALL d2l-card elements (not just enrollment cards).
  // d2l-card's own adoptedStyleSheet hardcodes background-color: rgb(255,255,255),
  // so CSS variable overrides on :root don't reach it — we must inject our own sheet.
  let bsGenericCardSheet = null;
  function getBsGenericCardSheet() {
    if (bsGenericCardSheet) return bsGenericCardSheet;
    bsGenericCardSheet = new CSSStyleSheet();
    bsGenericCardSheet.replaceSync(`
      :host {
        background-color: var(--d2l-color-white, #1e1e1e) !important;
        border-color: var(--d2l-color-gypsum, #2d2d2d) !important;
        color: #e8e8e8 !important;
      }
      *,
      ::slotted(*) {
        color: inherit !important;
      }
    `);
    return bsGenericCardSheet;
  }

  function applyAllCardDarkMode(retryCount = 0) {
    const sheet = getBsGenericCardSheet();
    let hasPending = false;
    queryShadowAll('d2l-card', document.body).forEach((card) => {
      if (card.shadowRoot) {
        if (!card.shadowRoot.adoptedStyleSheets.includes(sheet)) {
          card.shadowRoot.adoptedStyleSheets = [...card.shadowRoot.adoptedStyleSheets, sheet];
        }
      } else {
        // d2l-card is in the DOM but Lit hasn't rendered its shadow yet
        hasPending = true;
      }
    });
    // Keep retrying until all found cards have rendered their shadows
    if (hasPending && retryCount < 8) {
      setTimeout(() => applyAllCardDarkMode(retryCount + 1), 250);
    }
  }

  function removeAllCardDarkMode() {
    if (!bsGenericCardSheet) return;
    queryShadowAll('d2l-card', document.body).forEach((card) => {
      if (card.shadowRoot) {
        card.shadowRoot.adoptedStyleSheets =
          card.shadowRoot.adoptedStyleSheets.filter((s) => s !== bsGenericCardSheet);
      }
    });
  }

  // Popover/dropdown dark mode — d2l-dropdown-content, d2l-dropdown-menu, d2l-dialog
  // all define --d2l-popover-default-background-color: #ffffff inside their shadow :host,
  // which shadows our :root overrides. Inject our own sheet to fix it.
  let bsPopoverSheet = null;
  function getBsPopoverSheet() {
    if (bsPopoverSheet) return bsPopoverSheet;
    bsPopoverSheet = new CSSStyleSheet();
    bsPopoverSheet.replaceSync(`
      :host {
        --d2l-popover-default-background-color: var(--d2l-color-white, #1e1e1e);
        --d2l-popover-default-border-color: var(--d2l-color-gypsum, #2d2d2d);
      }
    `);
    return bsPopoverSheet;
  }

  const POPOVER_TAGS = 'd2l-dropdown-content, d2l-dropdown-menu, d2l-dialog, d2l-tooltip';

  function applyPopoverDarkMode() {
    const sheet = getBsPopoverSheet();
    queryShadowAll(POPOVER_TAGS, document.body).forEach((el) => {
      if (el.shadowRoot && !el.shadowRoot.adoptedStyleSheets.includes(sheet)) {
        el.shadowRoot.adoptedStyleSheets = [...el.shadowRoot.adoptedStyleSheets, sheet];
      }
    });
  }

  function removePopoverDarkMode() {
    if (!bsPopoverSheet) return;
    queryShadowAll(POPOVER_TAGS, document.body).forEach((el) => {
      if (el.shadowRoot) {
        el.shadowRoot.adoptedStyleSheets =
          el.shadowRoot.adoptedStyleSheets.filter((s) => s !== bsPopoverSheet);
      }
    });
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
      :root {
        --bs-accent-hover: color-mix(in srgb, ${c.accent} 70%, #ffffff);
        --bs-muted-text: color-mix(in srgb, #ffffff 72%, ${c.background});
        --bs-muted-text-2: color-mix(in srgb, #ffffff 55%, ${c.background});
        --bs-surface-2: color-mix(in srgb, ${c.surface} 78%, ${c.background});
        --bs-surface-3: color-mix(in srgb, ${c.surface} 62%, ${c.background});
      }

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
        --d2l-color-onyx: ${c.surface};
        /* Borders */
        --d2l-color-gypsum: ${c.border};
        --d2l-color-mica: ${c.border};
        --d2l-color-corundum: ${c.border};
        --d2l-color-chromite: color-mix(in srgb, ${c.border} 70%, #000000);
        /* Text (fixed — not user-customizable) */
        --d2l-color-ferrite: #e8e8e8;
        --d2l-color-galena: var(--bs-muted-text);
        --d2l-color-tungsten: var(--bs-muted-text-2);
        --d2l-color-titanium: color-mix(in srgb, #ffffff 40%, ${c.background});
        --d2l-color-black: ${c.background};
        /* Accent */
        --d2l-color-celestine: ${c.accent};
        --d2l-color-celestine-plus-1: var(--bs-accent-hover);
        --d2l-color-celestine-minus-1: ${c.accent};
        --d2l-color-celestine-plus-2: ${c.background};
        --d2l-color-primary-accent-action: ${c.accent};
        --d2l-color-primary-accent-indicator: ${c.accent};
        --d2l-link-color: ${c.accent};
        --d2l-link-color-hover: var(--bs-accent-hover);
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
        --d2l-input-placeholder-color: var(--bs-muted-text-2);
        /* Focus rings */
        --d2l-focus-color: ${c.accent};
        --d2l-focus-box-shadow: 0 0 0 3px color-mix(in srgb, ${c.accent} 35%, transparent);
        /* Overlays */
        --d2l-color-overlay: rgba(0, 0, 0, 0.65);
      }

      /* ── Navigation ──────────────────────────────────────────────────────────── */
      /* Secondary nav band — UTRGV hardcodes background-color: #4C4A4F here */
      html.bs-dark-mode .d2l-branding-navigation-background-color {
        background-color: var(--bs-surface-2) !important;
      }

      html.bs-dark-mode .d2l-navigation-s {
        background-color: ${c.surface} !important;
        border-bottom-color: ${c.border} !important;
      }

      html.bs-dark-mode .d2l-navigation-s-main-wrapper,
      html.bs-dark-mode .d2l-navigation-s-linkarea-has-color {
        background-color: ${c.surface} !important;
      }

      html.bs-dark-mode .d2l-navigation-s-header,
      html.bs-dark-mode .d2l-navigation-s-header-content,
      html.bs-dark-mode .d2l-navigation-s-header-logo-area {
        background-color: ${c.surface} !important;
      }

      html.bs-dark-mode .d2l-navigation-s-group,
      html.bs-dark-mode .d2l-navigation-s-link {
        background-color: transparent !important;
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

      html.bs-dark-mode .d2l-navigation-s-home-icon,
      html.bs-dark-mode .d2l-navigation-s-notification,
      html.bs-dark-mode .d2l-navigation-s-admin-menu {
        color: #e8e8e8 !important;
      }

      html.bs-dark-mode .d2l-navigation-s-course-menu-divider,
      html.bs-dark-mode .d2l-navigation-s-notifications-divider {
        background-color: ${c.border} !important;
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

      html.bs-dark-mode .d2l-course-banner-container {
        position: relative !important;
      }

      html.bs-dark-mode .d2l-course-banner-image {
        filter: brightness(0.7) saturate(0.85) !important;
      }

      html.bs-dark-mode .d2l-course-banner-container::after {
        content: '';
        position: absolute;
        inset: 0;
        background: linear-gradient(
          to bottom,
          rgba(0, 0, 0, 0.55) 0%,
          rgba(0, 0, 0, 0.25) 55%,
          rgba(0, 0, 0, 0.65) 100%
        );
        pointer-events: none;
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

      html.bs-dark-mode .d2l-widget-header,
      html.bs-dark-mode .d2l-homepage-header-wrapper,
      html.bs-dark-mode .d2l-homepage-header-menu-wrapper {
        background-color: ${c.surface} !important;
        border-bottom-color: ${c.border} !important;
      }

      html.bs-dark-mode .d2l-widget-content,
      html.bs-dark-mode .d2l-widget-content-padding {
        background-color: ${c.surface} !important;
      }

      html.bs-dark-mode .d2l-homepage-header-wrapper .d2l-heading {
        color: #e8e8e8 !important;
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

      html.bs-dark-mode .d2l-body,
      html.bs-dark-mode .d2l-typography,
      html.bs-dark-mode .vui-typography {
        color: #e8e8e8 !important;
      }

      /* ── Links ───────────────────────────────────────────────────────────────── */
      html.bs-dark-mode a,
      html.bs-dark-mode .d2l-link {
        color: ${c.accent} !important;
      }

      html.bs-dark-mode a:hover,
      html.bs-dark-mode .d2l-link:hover {
        color: var(--bs-accent-hover) !important;
      }

      /* ── Menus, dropdowns, dialogs (light DOM shells) ───────────────────────── */
      html.bs-dark-mode [role="dialog"],
      html.bs-dark-mode .d2l-dialog,
      html.bs-dark-mode .d2l-modal,
      html.bs-dark-mode .d2l-popup,
      html.bs-dark-mode .d2l-dropdown-content,
      html.bs-dark-mode .d2l-overlay {
        background-color: ${c.surface} !important;
        color: #e8e8e8 !important;
        border-color: ${c.border} !important;
      }

      html.bs-dark-mode [role="dialog"] a,
      html.bs-dark-mode .d2l-dialog a,
      html.bs-dark-mode .d2l-popup a {
        color: ${c.accent} !important;
      }

      html.bs-dark-mode [role="menu"],
      html.bs-dark-mode [role="listbox"],
      html.bs-dark-mode .d2l-menu,
      html.bs-dark-mode .vui-list {
        background-color: ${c.surface} !important;
        border-color: ${c.border} !important;
      }

      html.bs-dark-mode [role="menuitem"],
      html.bs-dark-mode [role="option"],
      html.bs-dark-mode .d2l-menu-item {
        color: #e8e8e8 !important;
      }

      html.bs-dark-mode [role="menuitem"]:hover,
      html.bs-dark-mode [role="option"]:hover,
      html.bs-dark-mode .d2l-menu-item:hover {
        background-color: var(--bs-surface-2) !important;
      }

      /* ── Tables/lists ───────────────────────────────────────────────────────── */
      html.bs-dark-mode table,
      html.bs-dark-mode .d2l-table {
        background-color: ${c.surface} !important;
        color: #e8e8e8 !important;
      }

      html.bs-dark-mode th,
      html.bs-dark-mode td,
      html.bs-dark-mode .d2l-table-row,
      html.bs-dark-mode .d2l-table-cell {
        border-color: ${c.border} !important;
      }

      html.bs-dark-mode tr:hover,
      html.bs-dark-mode .d2l-table-row:hover {
        background-color: var(--bs-surface-2) !important;
      }

      /* ── Inputs in light DOM contexts ───────────────────────────────────────── */
      html.bs-dark-mode input[type="text"],
      html.bs-dark-mode input[type="search"],
      html.bs-dark-mode input[type="email"],
      html.bs-dark-mode input[type="password"],
      html.bs-dark-mode textarea,
      html.bs-dark-mode select {
        background-color: ${c.surface} !important;
        color: #e8e8e8 !important;
        border-color: ${c.border} !important;
      }

      html.bs-dark-mode input::placeholder,
      html.bs-dark-mode textarea::placeholder {
        color: var(--bs-muted-text-2) !important;
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

      /* ── Smart-curriculum content viewer (iframe: /d2l/le/lessons/) ─────────── */
      /* This iframe has its own DOM with no shadow roots; target its classes directly */
      html.bs-dark-mode body,
      html.bs-dark-mode .navigation-panel,
      html.bs-dark-mode .navigation-search,
      html.bs-dark-mode .panel-overlay,
      html.bs-dark-mode .new-content-alert,
      html.bs-dark-mode .module-overview {
        background-color: ${c.surface} !important;
        color: #e8e8e8 !important;
      }

      html.bs-dark-mode .unit-box {
        background-color: ${c.surface} !important;
        color: #e8e8e8 !important;
        border-color: ${c.border} !important;
      }

      html.bs-dark-mode .unit-box.selected {
        background-color: var(--bs-surface-2, ${c.surface}) !important;
        border-left-color: ${c.accent} !important;
      }

      html.bs-dark-mode .unit-box:hover {
        background-color: var(--bs-surface-2, ${c.surface}) !important;
      }

      html.bs-dark-mode .unit-box *,
      html.bs-dark-mode .unit-box a {
        color: #e8e8e8 !important;
      }

      html.bs-dark-mode h1,
      html.bs-dark-mode h2,
      html.bs-dark-mode h3,
      html.bs-dark-mode h4 {
        color: #e8e8e8 !important;
      }

      html.bs-dark-mode .navigation-search input {
        color: #e8e8e8 !important;
      }

      html.bs-dark-mode .navigation-search input {
        background-color: ${c.background} !important;
        border-color: ${c.border} !important;
      }

      html.bs-dark-mode .module-description,
      html.bs-dark-mode .content-container,
      html.bs-dark-mode .d2l-collapsible-panel {
        background-color: ${c.background} !important;
        color: #e8e8e8 !important;
      }

      html.bs-dark-mode .accent.theme-background {
        filter: brightness(0.7) !important;
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
    if (!isFrame) applyHeaderLogoSwap(enabled);
    const elements = isFrame ? [] : findCourseElements();
    if (enabled) {
      applyCardEnhancements(elements);
      applyAllCardDarkMode();
      applyPopoverDarkMode();
    } else {
      removeCardEnhancements(elements);
      removeAllCardDarkMode();
      removePopoverDarkMode();
    }
  }

  function applyHeaderLogoSwap(enabled) {
    const logoEls = document.querySelectorAll('d2l-labs-navigation-link-image.d2l-navigation-s-logo');
    for (const el of logoEls) {
      if (!originalHeaderLogoSrc.has(el)) {
        originalHeaderLogoSrc.set(el, el.getAttribute('src'));
      }

      if (enabled) {
        el.setAttribute('src', chrome.runtime.getURL('icons/BetterSpaceLetterLogo.png'));
      } else {
        const original = originalHeaderLogoSrc.get(el);
        if (original) el.setAttribute('src', original);
      }
    }
  }

  // ── Messages ─────────────────────────────────────────────────────────────────

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!isFrame) {
      if (message.type === 'GET_COURSES') {
        sendResponse({ courses: buildCourseList() });
      }
      if (message.type === 'APPLY_NAMES') {
        savedNames = message.names;
        applyAllNames();
        sendResponse({ ok: true });
      }
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
          if (node.nodeType !== Node.ELEMENT_NODE) continue;
          if (node.shadowRoot) {
            observeRoot(node.shadowRoot);
          }
          // Lit components attach their shadowRoot asynchronously after being
          // added to the DOM. Retry a short time later so we don't miss them.
          if (node.tagName && node.tagName.includes('-')) {
            setTimeout(() => {
              if (node.shadowRoot) {
                observeRoot(node.shadowRoot);
                if (isDarkMode) {
                  applyAllCardDarkMode();
                  applyPopoverDarkMode();
                }
              }
            }, 300);
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

    if (!isFrame) {
      await loadSavedNames();
      observeRoot(document.body);
      applyAllNames();
    }

    // Extra passes to catch Lit components that render their shadow roots
    // asynchronously after the initial run.
    if (stored.darkMode) {
      setTimeout(() => { applyAllCardDarkMode(); applyPopoverDarkMode(); }, 600);
      setTimeout(() => { applyAllCardDarkMode(); applyPopoverDarkMode(); }, 2000);
    }
  }

  init();
})();
