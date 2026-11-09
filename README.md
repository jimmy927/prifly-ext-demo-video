# Demo studio

A prifly extension that turns a brief into a script and a storyboard for a narrated product demo video. Claude writes the script through the `demo_*` tools; the reader edits, annotates and approves it in the Demo studio panel.

Phases 1 and 2 cover the brief, script and storyboard tabs and the dry run. The dry run (Storyboard's "Dry run", or the `demo_dry_run` tool) builds one page from the product's own mockup harness at its checkout's HEAD commit, in a throwaway `git worktree` under the video's `build/` folder with the checkout's node_modules linked in. The page is cached in `_harness-cache/`. The dry run then performs every scene's steps in its own chrome-headless-shell (1920×1080, one at a time) and saves one still per scene in `stills/`. On a Windows host the git and build commands run inside WSL through `wsl.exe` (settings: ODI checkout, prifly checkout, WSL distribution). There the worktree sits on WSL's own disk, `~/.cache/prifly-demo-video/build/`, and only the composed page comes back to the host's `_harness-cache/`. The browser is the Windows build of chrome-headless-shell. Voice and rendering (Render, Export) come in a later version and answer "not available yet".

## Layout

- `prifly-extension.json`: manifest (panel, launcher, settings).
- `index.ts`: `activate`, `panel`, `choices`, `launch`, `launched`.
- `prompt.md`: house rules added to Claude's system prompt.
- `src/`: store, scene schema, timing and house rules, tools, panel API, launch prompts; `browser.ts`, `exec.ts`, `dry-run.ts`, `dry-run-service.ts` and `sources/` (harness build) for the dry run.
- `panel/`: the panel page (plain ES modules, no build).
- `test/`: `bun test`, over a fake prifly api.

## Develop

    bun install --frozen-lockfile
    bun test
    bun node_modules/typescript/bin/tsc --noEmit   # or: bun run typecheck where node is recent
    bun node_modules/@biomejs/biome/bin/biome check .

Videos live in the extension's data folder, one folder per video (`brief.json`, `scenes.json`, `stills/`, `audio/`, `takes/`, `out/`).
