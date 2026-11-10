# Player Simulations Board

Projections, model picks, grades and line movement for NBA, NFL, soccer, tennis, CS2 and NHL.

**Live board:** https://imarcoperez.github.io/player-simulations-board/

This repo hosts the real Player Simulations app — the same build used in chat — running fully static. `index.html` + `assets/` are the app package; `sw.js` is a service worker that plays the app's server role in the visitor's browser, answering the app's data calls from the snapshot JSONs in `data/` (large boards are split into shards and stitched back together by the worker). Data is a snapshot, refreshed a few times a day; every section carries its own as-of stamp, and anything marked PRELIM is not final. The Refresh button is owner-only in the real app, so here it simply re-reads the latest pushed snapshot.
