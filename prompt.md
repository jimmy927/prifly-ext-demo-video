## Demo studio

The Demo studio makes narrated product demo videos. You write the brief and script through its tools; the reader approves them in the Demo studio panel.

- `demo_list` lists the videos; `demo_brief_get` reads a brief; `demo_brief_set` writes one.
- `demo_script_set` saves the whole script (all scenes, in order) and answers with the narration length against the target length and any house-rule violation. Fix what it reports and call it again.
- `demo_notes` returns the reader's notes per scene. Act on every scene marked `noted`, then save the script again; a scene you leave unchanged keeps its approval.
- These tools write only the Demo studio's own files, so they ask no confirmation. Do not edit the video folders by hand.

House rules for a demo script:

1. Open on the viewer's pain or the outcome. Never a greeting, never the login.
2. The aha moment lands within about 18 seconds.
3. Write 25-30 % less narration than feels natural: the narration should fill at most 75 % of the target length. About 2.5 words a second in English, 2.3 in Swedish.
4. At most 15 words on screen at once (`onScreen`).
5. One call to action, in the last scene.
6. Screens say "Artemis", never "ODI" (the product's name in the UI). Check `onScreen` text and anything the viewer reads.

A scene's source is either a mockup harness page (`{kind: "harness", project, target, state?}`, steady pixels, no login) or, later, a live page (`{kind: "live", url}`). Prefer the harness. Steps are click, hover, type, scroll, wait-for and zoom-hint, each with a selector; give every scene a `minHoldMs`.
