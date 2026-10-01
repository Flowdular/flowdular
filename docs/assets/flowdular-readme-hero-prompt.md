# README hero artwork

Updated on 2026-10-01 with the built-in imagegen tool, using the previous README
banner as the brand reference. This is product artwork, not a platform screenshot.
The current identity is three right-aligned rounded bars: two ivory, one copper.

Final asset: `docs/assets/flowdular-readme-hero.webp`, 2000 × 672 pixels,
109,024 bytes. The generated PNG was resized with Lanczos and encoded as WebP
with Pillow, quality 90, method 6. Visually checked the compressed file for text,
brand shape, margins, and illustration detail.

The original generated PNG remains in the imagegen output directory. The WebP
is the checked-in source for this README illustration. Earlier woven-hash prompts
are obsolete and must not be used for the current identity.

## Generation prompt

```text
Use case: ads-marketing
Asset type: an extraordinary but restrained product hero banner for a public GitHub README, wide landscape 3:1 aspect ratio.
Input image 1 is the current banner, an edit target and brand reference. Replace its composition completely with a polished editorial artwork, preserve brand identity EXACTLY: the Flowdular brand is three separate horizontal pill bars with right edges aligned; top ivory bar width 20 units, middle ivory bar width 14 units, bottom copper bar width 8 units; every bar height 5 units; two units vertical gaps. It is not a letter F or a woven hash. Do NOT invent another logo. No other branding.

Primary request: Make Flowdular feel like the elegant foundation on which a business assembles its own software, working agents, and reusable workflows. A rich architectural miniature made of modular software blocks, connected around the exact three-bar symbol.

Scene/backdrop: Deep ink navy #111827 full bleed matte background, subtle precision grid and barely visible material grain. No gradients that become purple.
Subject: Right half contains an exquisitely art-directed 3D assemblage of 6-8 square dark navy module tiles with bevelled ceramic/metal edges arranged on offset raised terraces, warm copper #E08A45 routes recessed into the ground plane connecting them into a branching workflow. Each tile contains one crisp meaningful relief, e.g. stacked rows for business records, a short checklist for tasks, a 3-node directed branch for workflow, tiny orderly code brackets for extensibility, a four-square matrix for modules, and a concentric three-part orbit for agents. Center of this system contains the exact three right-aligned pill-bar brand symbol as sculptural ivory / ivory / copper horizontal slabs, standing slightly above the landscape, seen sufficiently front-on to preserve its instantly recognizable geometry. Tiles sit in clear purposeful positions, not randomized. Restrained copper joins show data and actions flowing between tiles. Every object has precise edges, nice relief detail and soft cast shadows. Enough depth to feel tactile and distinctive, never an overloaded futuristic circuit board.
Style/medium: Premium editorial 3D illustration with meticulous studio lighting, architectural model photography sensibility, clean practical brand design, quiet confidence.
Composition/framing: wide 3:1 panorama. LEFT 47% is mostly uninterrupted navy negative space for prominent lettering. RIGHT 53% contains the miniature assembly entirely within frame. Keep generous 6% safe margins. No perspective scene intrudes behind the words. Typography hierarchy easy to read at 830px wide; the word Flowdular large at about one third of overall height. The two-line headline below it smaller but strong, with ample line spacing. One tiny website address bottom left. The illustration includes no small text labels.

Text (verbatim), ONLY these words:
"Flowdular"
"Build the software"
"your business runs on."
"flowdular.com"

Typography: large beautiful ivory IBM Plex Sans / clean humanist sans wordmark, medium-weight headline, natural kerning. Wordmark aligned left. Headline uses the two lines exactly as shown. No uppercase microcopy, no badges, no extra text, no watermark.
Lighting/mood: Warm upper-left key light with gentle copper reflections, dimensional ivory bars and dark navy blocks, calm shadows with good separation. Background remains dark, image readable in dark and light GitHub themes.
Constraints: Exact brand geometry. Text accurate and spelled exactly F-l-o-w-d-u-l-a-r. No stock robot icon, no robot face, no glowing circuit board, no random cables, no people, no fake dashboard screenshot, no decorative neon, no purple, no woven hash, no watermarks. Rich sculptural detail, coherent visual metaphor, sparse but not empty. Do not copy the old flat icon diagram. Create a complete finished hero with text and illustration.
```
