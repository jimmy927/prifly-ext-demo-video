# Demo studio

A prifly extension that turns a brief into a script and a storyboard for a narrated product demo video. Claude writes the script through the `demo_*` tools; the reader edits, annotates and approves it in the Demo studio panel.

Phase 1 covers the brief, script and storyboard tabs. Recording, voice and rendering (the Video tab's Dry run, Render and Export) come in a later version and answer "not available yet".

## Layout

- `prifly-extension.json`: manifest (panel, launcher, settings).
- `index.ts`: `activate`, `panel`, `choices`, `launch`, `launched`.
- `prompt.md`: house rules added to Claude's system prompt.
- `src/`: store, scene schema, timing and house rules, tools, panel API, launch prompts.
- `panel/`: the panel page (plain ES modules, no build).
- `test/`: `bun test`, over a fake prifly api.

## Develop

    bun install --frozen-lockfile
    bun test
    bun node_modules/typescript/bin/tsc --noEmit   # or: bun run typecheck where node is recent
    bun node_modules/@biomejs/biome/bin/biome check .

Videos live in the extension's data folder, one folder per video (`brief.json`, `scenes.json`, `stills/`, `audio/`, `takes/`, `out/`).
