# Third-party notices

Frontier Sovereigns uses third-party software under the licenses below. These components remain under their own licenses; the project Apache-2.0 license does not relicense them. Versions are pinned by `pnpm-lock.yaml`.

## Direct dependencies

| Package | Version | Declared license | Use |
| --- | --- | --- | --- |
| `@babylonjs/core` | 9.27.1 | Apache-2.0 | Browser runtime |
| `@fastify/cookie` | 11.1.2 | MIT | Server runtime |
| `@fastify/static` | 10.1.2 | MIT | Server runtime |
| `@playwright/test` | 1.63.0 | Apache-2.0 | Development / build / tests |
| `@types/node` | 22.19.15 | MIT | Development / build / tests |
| `@types/react` | 19.3.0 | MIT | Development / build / tests |
| `@types/react-dom` | 19.3.0 | MIT | Development / build / tests |
| `@types/ws` | 8.18.1 | MIT | Development / build / tests |
| `@vitejs/plugin-react` | 6.1.1 | MIT | Development / build / tests |
| `ajv` | 8.20.0 | MIT | Schema compiler and bundled validation helpers |
| `esbuild` | 0.28.2 | MIT | Development / build / tests |
| `fastify` | 5.12.5 | MIT | Server runtime |
| `react` | 19.3.0 | MIT | Browser runtime |
| `react-dom` | 19.3.0 | MIT | Browser runtime |
| `tsx` | 4.23.13 | MIT | Development / build / tests |
| `typescript` | 5.9.3 | Apache-2.0 | Development / build / tests |
| `vite` | 8.3.0 | MIT | Development / build / tests |
| `vitest` | 5.0.1 | MIT | Development / build / tests |
| `ws` | 8.21.3 | MIT | Server runtime |

Workspace packages are project source and are omitted from this third-party table.

## Transitive dependencies and build tools

The 178 package/version entries in the lockfile were checked against 128 installed package manifests and exact-version npm registry metadata for 50 other-platform optional native packages. The declared license counts are MIT (142), Apache-2.0 (7), ISC (7), BSD-3-Clause (5), BlueOak-1.0.0 (5), and MPL-2.0 (12). This inventory covers metadata, not an exhaustive audit of embedded native code or every future distribution artifact.

- React's `scheduler` 0.28.0 is MIT-licensed and included in the shared React notice below.
- AJV 8.20.0 and `fast-deep-equal` 3.1.3 provide code embedded in generated protocol validators. Their notices below apply to those generated files and resulting browser/server bundles. Regenerating a file does not remove its third-party attribution.
- `lightningcss` 1.33.0 and its native packages use MPL-2.0. They are build tools. Their upstream source is [parcel-bundler/lightningcss](https://github.com/parcel-bundler/lightningcss). Consult the package license and [Mozilla's MPL guidance](https://www.mozilla.org/en-US/MPL/2.0/FAQ/) when redistributing those packages or changes to them.
- `rolldown` 1.2.9 uses MIT and identifies additional components in its [upstream third-party license inventory](https://github.com/rolldown/rolldown/blob/main/THIRD-PARTY-LICENSE). Native toolchain distributions need their applicable upstream notices.

The source repository does not vendor `node_modules`, browser binaries, or compiled bundles. Package installations normally carry upstream license files. Some installed native packages, `abstract-logging` 2.0.1, and `stackback` 0.0.2 declare MIT without a top-level license file; check their upstream notices before repackaging those dependencies. Other-platform native tarball contents were not inspected.

When distributing a compiled client, include this file and the root `LICENSE` with the distribution. When packaging server dependencies, development tools, containers, or browser binaries, retain their own license and notice files and review the actual included components. Browser downloads used by Playwright are separate distributions. Original generated game art and audio are licensed under CC BY 4.0; include the attribution and license notice in [assets/LICENSE.md](assets/LICENSE.md) with asset distributions. Their source-code generators remain Apache-2.0.

## Babylon.js

`@babylonjs/core` 9.27.1 uses Apache-2.0; its license terms are reproduced in the root [LICENSE](LICENSE). The following is the package's upstream NOTICE, preserved as supplied. It describes the package inventory and does not assert that every listed optional decoder is used by this game.

```text
Babylon.js
Copyright 2023 The Babylon.js team

The following components are included in this package:

Draco Compression [v1.5.6](https://github.com/google/draco/tree/1.5.6)
https://github.com/google/draco
Licensed under the Apache 2.0 License

Basis transcoder
Copyright 2024 The Khronos Group (https://www.khronos.org/),
Licensed under the Apache 2.0 license.

GLSLang [v11.8.0](https://github.com/KhronosGroup/glslang/releases/tag/11.8.0)
Copyright 2024 The Khronos Group (https://www.khronos.org/),
Licensed under the Apache 2.0 license.

TWGSL (https://github.com/BabylonJS/twgsl)
Copyright 20221-2024 The Babylon.js team
Licensed under the Apache 2.0 License

meshoptimizer (https://github.com/zeux/meshoptimizer)
Copyright (c) 2016-2026 Arseny Kapoulkine
Licensed under the MIT License
```

## React, React DOM and Scheduler

Applies to `react` 19.3.0, `react-dom` 19.3.0, and `scheduler` 0.28.0. These packages carry the same license text.

```text
MIT License

Copyright (c) Meta Platforms, Inc. and affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## AJV

Applies to AJV 8.20.0, including its helpers embedded by `packages/shared/generate-validators.ts`.

```text
The MIT License (MIT)

Copyright (c) 2015-2021 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## fast-deep-equal

Applies to `fast-deep-equal` 3.1.3, including its equality helper embedded in generated validators.

```text
MIT License

Copyright (c) 2017 Evgeny Poberezkin

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Vite runtime helpers

Applies to Vite 8.3.0 runtime helpers that the client build may inject, including module preloading. The complete Vite package has additional bundled-component notices in its own `LICENSE.md`; retain that file when distributing Vite itself.

```text
MIT License

Copyright (c) 2019-present, VoidZero Inc. and Vite contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
