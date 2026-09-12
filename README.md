# 📷 DecoHexa

A fast, no-fuss barcode and QR scanner that runs right in your browser.

## Overview

DecoHexa lets you scan barcodes, QR codes, and Aztec codes straight from your camera, or just drop in an image if you'd rather not point your camera at anything. No app store, no install required, it's a Progressive Web App, so you can add it to your home screen and use it like a native app, even offline.

I built this to be quick and practical: point, scan, get your result. No clutter, no unnecessary steps.

🔗 Live demo: [decohexa.vercel.app](https://decohexa.vercel.app)

## Features

- **Live camera scanning** — point your camera at any code and get an instant read
- **Image drop/upload** — no camera? Drop in an image instead
- **Batch mode** — automatically logs every new unique code as you scan, handy for scanning several items in a row
- **History** — keeps a log of everything you've scanned, with configurable retention (keep everything, last 500, last 30 days, etc.)
- **Export options** — export your raw scan data as `.txt` or `.json`
- **Custom label rules** — set up your own rules to auto-label recognized codes
- **Dark theme** — because scanning at night shouldn't hurt your eyes
- **Sound and vibration feedback** — know instantly when a scan lands
- **Keyboard shortcuts** — space to toggle scanning, C to copy, E to export

## How It Works

1. Open the app and grant camera access (or drop in an image if you'd rather not)
2. Point at a barcode, QR code, or Aztec code
3. DecoHexa reads it instantly and shows you the raw text
4. Copy the result, export it, or let it save automatically to your history
5. Adjust settings (theme, sound, batch mode, retention) to fit how you use it

## Tech Stack

Built as a lightweight Progressive Web App using vanilla HTML, CSS, and JavaScript, no heavy frameworks, just fast, direct code. Deployed on Vercel, with a service worker for offline support.

## Why I Built It

Most barcode scanner apps come bundled with permissions I don't need, ads, or unnecessary sign-ups just to scan a code. DecoHexa strips that away: open the page, scan, done.

---

Built by KencHub
