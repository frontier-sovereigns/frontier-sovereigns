# Asset licensing

Frontier Sovereigns' original generated game assets are licensed under the **Creative Commons Attribution 4.0 International license (CC BY 4.0)** by Jim Liu. See the [license summary](https://creativecommons.org/licenses/by/4.0/) and [full legal terms](https://creativecommons.org/licenses/by/4.0/legalcode.en).

This grant covers the original generated 3D models, animation and material data, SVG icons, synthesized sound effects, and music listed below. The TypeScript generators and other source code remain under the repository's [Apache-2.0 source-code license](../LICENSE).

| Licensed asset output | Generator source |
| --- | --- |
| `apps/client/public/art/frontier-assets.json` | Geometry, building, environment, unit and animation generators in `packages/assets/src/` |
| `apps/client/public/art/icons/*.svg` | `packages/assets/src/ui.ts` |
| `apps/client/public/art/audio/*.wav` | `packages/assets/src/audio.ts` |

The game builds these assets locally with `pnpm assets:build`, using the included generators and catalog in `data/asset-requirements.json`. Generated outputs are excluded from version control. `apps/client/public/asset-manifest.json` records their inventory and integrity hashes.

## Attribution

Include the following credit with redistributed assets, alongside a link to this license and the source project:

```text
Frontier Sovereigns — Copyright 2026 Jim Liu
Source: https://github.com/frontier-sovereigns/frontier-sovereigns
License: Creative Commons Attribution 4.0 International (CC BY 4.0)
https://creativecommons.org/licenses/by/4.0/
Changes: None (original project assets).
```

If you modify the assets, update the changes statement to describe your modifications and retain any earlier modification notices. Provide attribution in a reasonable manner without suggesting endorsement. These requirements are governed by the [CC BY 4.0 legal terms](https://creativecommons.org/licenses/by/4.0/legalcode.en).

Include this file with packaged game distributions and asset exports. Third-party software keeps its own licenses and notices in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md). No third-party media or font files are intentionally bundled in the source tree; CSS system-font names select fonts available on the user's device. This asset copyright license does not establish trademark or logo clearance.
