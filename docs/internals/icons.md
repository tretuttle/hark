# Icons

The SVG files are in `apps/extension/src/icons`. `scripts/toolbar-icon.ts` writes both of them. The master geometry is written down once, in `src/ui/mark-shape.ts`: the generator reads it for both files, and the popup and page headers draw it inline through `src/ui/mark.tsx`. `scripts/toolbar-icon.test.ts` fails when a file on disk differs from what the generator writes.

## The mark

`icon.svg` is the master drawing on the 64-unit grid. It has two drawing elements and nothing else: no background, no group, no style, no stroke.

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="Hark"><path class="mark" d="M12 8 H16 Q20 8 20 12 V24 H52 Q56 24 56 28 V52 Q56 56 52 56 H48 Q44 56 44 52 V36 H20 V52 Q20 56 16 56 H12 Q8 56 8 52 V12 Q8 8 12 8 Z" fill="#1D5AD9"/><circle class="dot" cx="50" cy="14" r="6" fill="#E11D48"/></svg>
```

- `path.mark` is one closed outline: an H whose right stem starts at the crossbar. Stems are 12 wide, the crossbar runs from y 24 to 36, and the outer corners have radius 4. No part of it overlaps another.
- `circle.dot` is the capture dot, centre (50, 14), radius 6. It is as wide as the right stem and sits over it, 4 units above the crossbar.

Every straight edge is on the 4-unit grid. The manifest sizes 16, 32, 48, 96 and 128 scale the grid by 0.25, 0.5, 0.75, 1.5 and 2, so each of those edges lands on a whole pixel. A crossbar on y 26 to 38 lands on half pixels at 16 and 48: on white, that render has 10 colours at 16 px and 20 at 48 px, against 6 and 15 for the crossbar on y 24 to 36. `scripts/write-icons.test.ts` checks that at every manifest size the rows above and below the crossbar are clear and its first and last rows are solid. Only the radius-4 corners and the dot's rim fall between pixels.

`scripts/write-icons.ts` renders the manifest PNGs from `icon.svg` with resvg at build time, into a generated folder that git ignores.

## Recoloring

The mark has two fills and each element carries a class, so recolouring touches two values:

- In `icon.svg`, change the two `fill` hex values. For `toolbar.svg`, change `TOKENS` in `toolbar-icon.ts` and run it again.
- When the SVG is inline in a page, set the fills from CSS: `.mark { fill: ... }` and `.dot { fill: ... }`. A `fill` set by a CSS rule wins over the `fill` attribute. The page headers do this with `--mark` and `--dot` from `src/styles.css`.
- For a single colour, set `fill: currentColor` on both classes. The mark and the dot never touch, so the H and the dot stay apart in one colour.

## toolbar.svg

`toolbar.svg` is the only toolbar file. Both `theme_icons` slots and `default_icon` point at it, and the packed XPI carries it at `icons/toolbar.svg` and at `action/icons/toolbar.svg`, where the build writes the `theme_icons` paths. The file is one line. It holds a `<style>`, the master geometry in the light toolbar fills inside `<g class="m">`, and one nested `svg` per measured grid with `preserveAspectRatio` set to `none`. A width query hides the master and shows one grid drawing. Every drawing is one `path.mark` and one `path.dot` or `circle.dot`, so the two rules `.mark{fill:...}` and `.dot{fill:...}` colour all of them. A `prefers-color-scheme: dark` rule swaps in the dark fills.

## Which drawing a width gets

Gecko applies the SVG media queries to the toolbar image, and the `width` query sees device pixels: each grid drawing below appeared in the photographs at the scale its band predicts.

Integer multiples share a drawing. 16 has `g16`, because the master's 3-pixel dot paints blended there. Larger multiples of 16 use the master. Multiples of 14 that are not multiples of 16 use `g14`. Any other measured width has its own grid, because 14 and 16 share no divisor with it. 40 is twice 20 and still has its own grid. 28 is `g14` at two device pixels per unit.

One `@media` rule shows one drawing. Bands are the measured query width plus or minus 0.35 px, merged when they share a drawing.

| Drawing | Query bands, px                                                |
| ------- | -------------------------------------------------------------- |
| g14     | 13.65 to 14.35, 27.65 to 28.55, 41.65 to 42.35, 56.05 to 56.75 |
| g16     | 15.65 to 16.35                                                 |
| g17     | 17.15 to 17.85                                                 |
| g20     | 19.65 to 20.35                                                 |
| g21     | 20.65 to 21.35                                                 |
| g24     | 23.65 to 25.05                                                 |
| g35     | 34.65 to 35.35                                                 |
| g40     | 39.65 to 40.35                                                 |

Anything outside those bands is the master. 32, 48, 64, 80, and 96 are the master.

## The grid drawings

Each grid drawing is drawn on whole device pixels with square corners. Stems and crossbar have one weight, the crossbar sits a little above the middle, the right stem starts at the crossbar, and the dot is as wide as the right stem, sits over it, and leaves at least one clear row above the crossbar. Coordinates are device pixels of that bitmap. Rows and boxes are start inclusive, end exclusive.

| Grid | viewBox  | H box, x and y | Stem | Crossbar rows | Dot box, x and y | Dot     | Clear rows |
| ---- | -------- | -------------- | ---- | ------------- | ---------------- | ------- | ---------- |
| g14  | 14 by 14 | 1-13, 1-13     | 3    | 5-8           | 10-13, 1-4       | octagon | 1          |
| g16  | 16 by 16 | 2-14, 2-14     | 3    | 6-9           | 11-14, 2-5       | octagon | 1          |
| g17  | 17 by 18 | 1-16, 1-17     | 4    | 6-10          | 12-16, 1-5       | octagon | 1          |
| g20  | 20 by 20 | 2-18, 2-18     | 4    | 7-11          | 14-18, 2-6       | octagon | 1          |
| g21  | 21 by 21 | 2-19, 2-19     | 4    | 8-12          | 15-19, 2-6       | octagon | 2          |
| g24  | 24 by 24 | 2-22, 2-22     | 5    | 9-14          | 17-22, 2-7       | steps   | 2          |
| g35  | 35 by 35 | 3-32, 3-32     | 7    | 13-20         | 25-32, 3-10      | steps   | 3          |
| g40  | 40 by 40 | 4-36, 4-36     | 8    | 15-23         | 28-36, 4-12      | steps   | 3          |

The dot is the shape that photographed sharpest on that grid. In Zen stable, a circle on a whole-pixel box painted the 3-pixel dot's four edge pixels as a blend of red and the pill, so its typical pixel had contrast 2.50 on `#D9D9DA` instead of the fill's 4.67, and it painted 4 solid pixels of the 4-pixel dot on `g21`. A stepped outline at those sizes reads as a plus sign. So `g14`, `g16`, `g17`, `g20` and `g21` use an octagon, a square with a one-pixel diagonal cut at each corner: 5 and 12 solid pixels in the fill, and four half-covered corners. From 5 pixels up the dot is pixel rows, 3-5-5-5-3, 3-5-7-7-7-5-3 and 4-6-8-8-8-8-6-4, which reads as round and leaves no partial pixel.

`toolbar-icon.test.ts` renders every drawing with resvg and checks that it has exactly two 4-connected shapes, that the same drawing with the dot moved onto the crossbar has one, that no pixel of a grid mark is partly covered, and that only the four cut corners of an octagon dot are.

## Colours

The icon knows the colour scheme and not the toolbar colour. Each scheme has one fill for the mark and one for the dot, chosen against the worst surface of that scheme in `SURFACES`. Contrast is WCAG contrast from `contrast` in `toolbar-icon.ts`.

| Slot       | Fill      | Worst surface           | Contrast | Surfaces under 3 |
| ---------- | --------- | ----------------------- | -------- | ---------------- |
| Light mark | `#004ECB` | zen preset 18 `#B6AEBA` | 3.304    | none             |
| Light dot  | `#BB0438` | zen preset 18 `#B6AEBA` | 3.060    | none             |
| Dark mark  | `#B5D8FF` | zen preset 27 `#777777` | 3.035    | none             |
| Dark dot   | `#FF7488` | zen preset 27 `#777777` | 1.728    | 20               |

Why each one:

- **Light mark `#004ECB`** clears every light surface, the darkest being preset 18 at 3.304.
- **Light dot `#BB0438`** is `#D11A43` made darker on the same hue (OKLCH hue 17, lightness 0.554 to 0.504) until it clears every light surface. `#D11A43` is 2.475 on preset 18 and under 3 on six presets: 18, 19, 26, 25, 20 and 8.
- **Dark mark `#B5D8FF`** is on the hue of `#93C5FD` (OKLCH hue 252) at lightness 0.870, the first 0.01 lightness step above `#93C5FD`'s 0.809 that clears every dark surface. Its chroma is 0.066 against 0.096, because sRGB holds no more blue at that lightness. `#93C5FD` is 2.483 on preset 27 and under 3 on eleven dark surfaces; `#ADCBFF`, a lighter blue, is 2.722 there and under 3 on seven. `#B5D8FF` leaves none.
- **Dark dot `#FF7488`** is `#FB7185` made lighter on the same hue (OKLCH hue 13.4) up to the lightest colour sRGB holds at its chroma, 0.169. `#FB7185` is 1.664 on preset 27 and under 3 on 21 dark surfaces; `#FF7488` clears preset 2 mauve and is under 3 on 20. Clearing the mid-grey presets would take a pale pink, not a red.

The dark dot shortfalls, pinned in `SHORTFALLS` to three decimals and checked to two:

| Surface             | Background | Dot contrast | Short of 3 |
| ------------------- | ---------- | ------------ | ---------- |
| zen preset 27       | `#777777`  | 1.728        | 1.272      |
| zen preset 9        | `#777676`  | 1.748        | 1.252      |
| zen preset 14       | `#777670`  | 1.758        | 1.242      |
| zen preset 15       | `#6D7772`  | 1.789        | 1.211      |
| zen preset 10       | `#777174`  | 1.843        | 1.157      |
| zen preset 16       | `#6C7476`  | 1.843        | 1.157      |
| zen preset 0 beige  | `#747170`  | 1.868        | 1.132      |
| zen preset 13       | `#776E69`  | 1.921        | 1.079      |
| zen preset 11       | `#746972`  | 2.023        | 0.977      |
| zen preset 12       | `#776869`  | 2.043        | 0.957      |
| zen preset 5 yellow | `#766A43`  | 2.071        | 0.929      |
| zen preset 23       | `#68685B`  | 2.179        | 0.821      |
| zen preset 17       | `#666670`  | 2.191        | 0.809      |
| zen preset 6 mint   | `#397156`  | 2.208        | 0.792      |
| zen preset 22       | `#6B6045`  | 2.395        | 0.605      |
| zen preset 1 pink   | `#745862`  | 2.445        | 0.555      |
| zen preset 7 sky    | `#4A626B`  | 2.494        | 0.506      |
| zen preset 4 orange | `#775243`  | 2.638        | 0.362      |
| zen preset 24       | `#4E5D51`  | 2.694        | 0.306      |
| zen preset 3 coral  | `#74464A`  | 2.983        | 0.017      |

Every other surface clears 3 to 1 for its scheme's two fills. `scripts/toolbar-icon.test.ts` recomputes all of them: a fill that drops a clearing surface under 3, or a pinned surface that starts clearing, fails it. On the default pills the dot is 4.67 on light `#D9D9DA` and 5.24 on dark `#2E2E2F`.

The popup and page headers use `--mark` and `--dot` from `src/styles.css`: the master fills `#1D5AD9` and `#E11D48` on the light page, 5.97 and 4.70 on `#FFFFFF`, and the dark toolbar fills `#B5D8FF` and `#FF7488` on the dark page, 12.03 and 6.85 on `#16181D`. The test checks those four values against the master and the dark tokens. The headers draw the mark at 24 CSS px with `viewBox="8 8 48 48"`, the H's own box, so the ink is 24 CSS px tall and a 4-unit step is 2 device px at 1x and 4 at 2x: every straight edge is on a whole device pixel. `src/ui/mark.test.tsx` fails when the component's shapes differ from `icon.svg` or its size and viewBox put a 4-unit step between pixels at 1x or 2x. Photographed in Zen stable at 2x, the mark is 48 by 48 device px in all three headers, its vertical centre is within half a device pixel of the centre of the title's first capital, and the ink gap to that capital is 9 CSS px in the popup and 10 on the history and settings pages.

## Where a fresh install puts the button

`action.default_area` is `navbar`. In every photographed run, in Zen 1.24.2b, Zen Twilight 1.25t and Firefox Developer Edition 161, the button was in `nav-bar` before `screenshot:toolbar` placed it anywhere.

The image's CSS size on each toolbar:

| Browser                      | Window, CSS px | Image, CSS px |
| ---------------------------- | -------------- | ------------- |
| Zen single toolbar, the pill | 1366           | 14            |
| Zen dual toolbar             | 1400           | 16            |
| Firefox Developer Edition    | 1366           | 16            |

Zen's dual toolbar with the sidebar collapsed also drew a 16 CSS px image at a 1400 CSS px window. No photographed toolbar drew 32 CSS px, so the 32 CSS px rows of `CELLS` keep their query widths and drawings but were not photographed here.

## What the photographs measured

`pnpm --filter @hark/extension run screenshot:toolbar -- --out <folder> --binary <path> --scale <ratio>` installs the packed XPI in a fresh profile, writes `--scale` to `layout.css.devPixelsPerPx`, and saves the window and the toolbar in the light and the dark appearance. `--pref name=value` sets other prefs, such as `zen.view.use-single-toolbar=false`, and `--window 1400x900` resizes the window. It logs the icon's box in CSS px and in device px. An element screenshot of a box that does not start on a device pixel is resampled, so the icon is read from the window screenshot at that device box.

The string `1.75` gives a `devicePixelRatio` of 1.7647, which is 30/17.

Zen stable and Zen Twilight measured the same in every cell. Columns: the device width of the image box, the drawing the query band selects, the bounding box of the painted pixels, the colours in the image box including the toolbar, and the 4-connected shapes of non-toolbar pixels. On the light pill `#D9D9DA` the typical mark pixel is `#004ECB` at 5.04 and the typical dot pixel `#BB0438` at 4.67; on the dark pill `#2E2E2F` they are `#B5D8FF` at 9.19 and `#FF7488` at 5.24, in every cell. The light and dark photographs gave the same boxes, colour counts and shape counts.

| Image, CSS px | Scale | Device width | Drawing | Painted box | Colours | Shapes |
| ------------- | ----- | ------------ | ------- | ----------- | ------- | ------ |
| 14            | 1     | 14           | g14     | 12 by 12    | 4       | 2      |
| 14            | 1.25  | 17.5         | g17     | 15 by 16    | 4       | 2      |
| 14            | 1.5   | 21           | g21     | 17 by 17    | 4       | 2      |
| 14            | 1.75  | 24.71        | g24     | 20 by 21    | 13      | 2      |
| 14            | 2     | 28           | g14     | 24 by 24    | 4       | 2      |
| 14            | 2.5   | 35           | g35     | 29 by 29    | 3       | 2      |
| 14            | 3     | 42           | g14     | 36 by 36    | 4       | 2      |

Four colours are the toolbar, the mark, the dot and the dot's half-covered corners. At 1.25 the box starts at device x 107.5, and the drawing still lands on whole pixels: the 17 by 18 `g17` grid paints from device row 115, which is why its viewBox is one row taller than wide. The 14 CSS px image at scale 1.75 is 24.71 device px wide and cannot land on whole pixels; its edges are soft and its two shapes stay separate.

Zen stable dual toolbar, 16 CSS px image, `#E9E9E9` light and `#131313` dark. The typical mark pixel is 5.86 light and 12.59 dark in every cell.

| Scale | Device width | Drawing | Painted box | Colours | Shapes | Typical dot, light and dark |
| ----- | ------------ | ------- | ----------- | ------- | ------ | --------------------------- |
| 1     | 16           | g16     | 12 by 12    | 4       | 2      | 5.43, 7.17                  |
| 1.25  | 20           | g20     | 16 by 16    | 4       | 2      | 5.43, 7.17                  |
| 1.5   | 24           | g24     | 20 by 20    | 3       | 2      | 5.43, 7.17                  |
| 1.75  | 28.23        | g14     | 24 by 24    | 4       | 2      | 5.43, 7.17                  |
| 2     | 32           | master  | 24 by 24    | 21      | 2      | 5.43, 7.17                  |
| 2.5   | 40           | g40     | 32 by 32    | 3       | 2      | 5.43, 7.17                  |
| 3     | 48           | master  | 36 by 36    | 22      | 2      | 5.43, 7.17                  |

The master's extra colours are its radius-4 corners and the dot's rim. At 16 device px the master's dot is 3 px across: drawn by the master, the circle painted as a plus whose four edge pixels blend with the toolbar, so the typical dot pixel was `#D1728D` at 2.66 on light and `#8D454F` at 2.74 on dark, with 8 colours and 71 mark pixels in the fill. That is why 16 has `g16`: the same cell now paints 78 mark pixels and 5 dot pixels in the exact fills, 4 colours in all.

Firefox Developer Edition draws its own dark theme in both appearances, so every Firefox photograph shows the dark fills, on a navbar between `#381D1E` and `#361E21` whose pixels vary by up to 3 levels per channel. At scales 1, 1.25, 1.5, 1.75, 2, 2.5 and 3 it painted 2 shapes, boxes of 12, 16, 20, 24, 24, 32 and 36 px, and a typical mark pixel `#B5D8FF` at 10.44. The typical dot pixel was `#FF7488` at 5.94 to 5.95 in every cell. At scale 1, before `g16`, the master's 3 px dot gave `#9F4A54` at 2.63.

`prefers-color-scheme` inside the toolbar image followed the browser's appearance in both Zen builds: the light appearance painted the light fills and the dark appearance the dark fills.
