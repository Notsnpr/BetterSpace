# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

BetterSpace is a Manifest V3 Chrome extension for Brightspace (D2L LMS). It lets users rename course cards with friendly titles and applies a custom dark mode theme.

There is no build system, no bundler, and no package manager. All files are plain HTML/CSS/JS loaded directly by Chrome.

## Loading the Extension for Development

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select this directory

After editing any JS or CSS file, click the reload button on the extensions page. For `content.js` changes, also reload the Brightspace tab.

## Architecture

### Files

| File | Role |
|------|------|
| `content.js` | Content script injected into every Brightspace page |
| `popup.html/js/css` | Extension popup (360px wide, opens on toolbar click) |
| `options.html/js/css` | Full settings page for dark-mode theme colors |
| `manifest.json` | Permissions, host patterns, content script registration |

### Data Flow

The popup communicates with the content script via `chrome.tabs.sendMessage`. Message types:

- `GET_COURSES` → content script returns `{ courses: [{id, originalName, savedName}] }`
- `APPLY_NAMES` → content script updates visible course names immediately
- `SET_DARK_MODE` → content script toggles dark mode on/off
- `APPLY_THEME` → content script re-injects dark mode CSS with new colors

`chrome.storage.local` schema:
- Numeric string keys (course IDs): custom name strings
- `darkMode`: boolean
- `themeColors`: `{ background, surface, border, accent }` hex strings

### Brightspace Shadow DOM

Brightspace nests Web Components ~5 shadow roots deep. `content.js` uses `queryShadowAll()` to recurse through all shadow roots to find course elements. The DOM structure targeted:

```
d2l-enrollment-card
  shadowRoot
    d2l-card [href="/d2l/home/{courseId}"]   ← course ID
    d2l-organization-name
      shadowRoot → text node                  ← visible name
```

Course names are overwritten directly in the shadow root's `textContent`. The original name is stamped once on `enrollCard.dataset.bsOriginal` to survive re-renders.

### Dark Mode Strategy

Dark mode injects a `<style id="bs-dark-mode-style">` on `:root` that overrides Brightspace's own D2L design tokens (e.g. `--d2l-color-white`, `--d2l-color-celestine`). Because CSS custom properties inherit across shadow DOM boundaries, this propagates into all `d2l-*` web components without needing per-shadow-root injection.

The `bs-dark-mode` class on `<html>` gates all dark mode rules.

Card gradient accents use `adoptedStyleSheets` on each `d2l-card` shadow root — this avoids observer loops caused by Lit re-rendering the component.

### MutationObserver

`content.js` sets up recursive `MutationObserver` instances on every shadow root it finds. When new shadow roots are added (lazy-loaded cards, tab switches), they are observed automatically. All mutations debounce 150ms before calling `applyAllNames()`.
