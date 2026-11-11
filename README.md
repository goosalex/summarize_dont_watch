# Summarize, Don't Watch

A Chrome extension that shows a summary of a YouTube video before you open it.

The summaries come from YouTube's own **Ask** feature (Gemini), so there is no API key and no cost. The extension opens each requested video in a background tab, clicks Ask → "Summarise the video", reads the answer, caches it and closes the tab.

## What it does

- Puts a round **?** button on every video thumbnail.
- Clicking **?** requests the summary. The button spins while a background tab works on it.
- When done, the button turns into a blue **!**. Hover the video, or click **!** to pin the summary open.
- Several requests run in parallel (3 background tabs by default, 1–6 in Options).
- Long summaries scroll inside the popup; the wheel or trackpad scrolls the summary, not the page.
- On the subscriptions page, a "Summarize all loaded" button queues every loaded video.
- Summaries are cached locally by video ID. Failed videos show a red button; click it to retry.
- Shorts, live streams and premieres are skipped.

## Requirements

- Chrome 111 or newer.
- Signed in to YouTube in the same Chrome profile.
- YouTube's Ask button must be available for your account and the video. Videos without it get no summary.

## Install

1. Clone or download this repository.
2. Open `chrome://extensions` and enable Developer mode.
3. Click "Load unpacked" and select the repository folder.
4. Reload any open YouTube tabs.

After updating the files, click the reload arrow on the extension and reload your YouTube tabs.

## How it works

| File | Role |
| --- | --- |
| `background.js` | Service worker. Job pool that opens one background tab per video, drives the Ask panel in short injected steps, caches the result and closes the tab. |
| `worker-page.js` | Runs only in those background tabs (marked with `#ytsum`). Makes the page render while hidden, since Chrome pauses animation frames in background tabs. |
| `content.js` / `content.css` | The buttons, the summary popup and the bulk button on normal YouTube pages. |
| `options.html` / `options.js` | Number of parallel tabs, and clearing the cache. |

## Limits

- There is no official API for this. The extension depends on YouTube's current page structure (the Ask button, the `PAyouchat` panel, the suggestion chips) and will break when YouTube changes it.
- Each summary costs a full page load plus the Gemini answer, roughly 10–20 seconds.
- Asking for many summaries at once may get throttled by YouTube. Lower the number of parallel tabs if requests start failing.
- Summaries are in your YouTube interface language.
- Background tabs appear briefly in the tab strip while they work.
- For personal use. Automating YouTube's interface may not be in line with its terms of service.
