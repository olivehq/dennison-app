# Design mockups

Ten design directions for the admin schedule workspace, built on October 4, 2026 from the real 2025 schedule (504 appointments, 65 buyers, 56 suppliers). Each is a single HTML file styled the way shadcn/ui themes are, so it maps directly onto the React components in `src/`.

The app follows **03 Resource timeline**. D&A's other favourites were 01 Floor plan and 04 Command workspace; `docs/PROJECT_SCOPE.md` section 4 describes how the three were meant to combine.

## View them

The pages load `shared/aw-data.js` with a script tag, so they need to be served over HTTP, not opened as files:

```bash
cd docs/designs
python3 -m http.server 4517
```

Then open http://localhost:4517/ for the gallery, or any numbered folder directly.

## Files

- `index.html`: gallery of all ten with live thumbnails.
- `shared/BRIEF.md`: the brief every design followed, including the feature list they all had to cover.
- `shared/aw-data.js`: the 2025 results in the shape the app's schedule view uses.
- `NN-name/index.html`: one design each. The comment at the top of each file states its concept, palette, type, layout, and the shadcn components it uses.
