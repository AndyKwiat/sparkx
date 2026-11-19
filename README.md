# ✨ Sparkx

**A mind map that fills itself with art while you think.**

Type an idea, hit **Tab** for a child or **Enter** for a sibling, and keep going. The tree rearranges itself as it grows. In the background, Sparkx reads what you wrote and finds art for it: stickers pop in beside each idea, and big faded images sit behind the main branches. You never wait for any of it.

![Sparkx screenshot](docs/screenshot.png)

## Try it

```bash
npm start            # → http://localhost:5178
```

There's nothing to install beyond Node 18+. For better art, get a free [Pixabay API key](https://pixabay.com/api/docs/), then `cp .env.example .env` and paste it in. Without a key, Sparkx falls back to Wikimedia Commons and Openverse.

## Keys

**Enter** sibling · **Tab** child · **Space** or just type to edit · **Del** remove · **Arrows** move around · **/** fold a branch · **⌥I** different art · **⌥B** background art on/off · **⌘Z** undo

Drag the background to pan, pinch to zoom, and drag an idea onto another to move it there.

## How it works

- **Frontend:** plain HTML, CSS and JS modules. No framework and no build step.
- **Art:** Iconify supplies the emoji-style stickers. A tiny local server ([server.mjs](server.mjs), zero dependencies) searches Pixabay for vector art. It keeps your key private and caches results and images on disk.
- **Saving:** maps save to your browser automatically. Use Save/Open to export and import `.json` files.

Desktop only, since it's built around a keyboard and a big screen.
