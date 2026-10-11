# PWC Web Control

`pwc-web-control` is the first-party Playwright/Chromium implementation of the deterministic Web observation/control runtime for the `m` layer. The canonical architectural contract is maintained in `rumiai-dev/specifications/rumiai-os/WEB-CONTROL.md`; this repository contains the independently versioned implementation.

The first provider uses Node.js, Playwright and a Chromium-class browser. Playwright/CDP/Chromium are implementation details and are not the provider-independent `web-control` contract.

## Runtime shape

Two package commands are produced:

```text
web-control
    deterministic client command

web-control-service
    foreground controller used by the web-control service facility
```

The normal installed lifecycle is:

```text
srv start web-control
web-control status
...
srv stop web-control
```

The package launcher supplies an isolated package HOME. `web-control-service` stores its default persistent browser profile below that HOME. The local Unix-domain control socket uses a short `/tmp` pathname derived from the effective user and package HOME so it remains below macOS/Linux Unix-socket pathname limits while still separating package/state instances. An explicit `WEB_CONTROL_SOCKET` can override that pathname. The socket is mode `0600`, stale sockets owned by another user are never removed, and raw browser debugger ports are not published. Because `srv start` guarantees process survival rather than application-specific readiness, the client retries a missing/refused local socket for up to 15 seconds by default; `WEB_CONTROL_CONNECT_TIMEOUT_MS` can override that bounded startup wait.

The ordinary browser mode is visible (`headless=false`). `WEB_CONTROL_HEADLESS=1` exists for automated validation and non-graphical environments. Chromium sandboxing is explicitly enabled by default; provider-specific custom browser arguments remain an explicit escape hatch and are not the normal package mode.

`web-control-service` is the long-running controller lifecycle; Chromium is a subordinate managed runtime. If the browser application is closed manually or exits unexpectedly, the service remains active and `web-control status` reports `browserRunning: false`. The browser is recreated on demand by the next `web-control page new`, using the same persistent profile; prior live page identities are not preserved. Closing an individual page through `web-control page close` closes only that page.

The released package depends on provider-independent runtime facilities:

```text
nodejs =26
chromium =1
```

The `chromium` facility supplies the browser executable. The release artifact contains the pinned Playwright JavaScript runtime but does not embed or download a browser.

## Public command baseline

```text
web-control status
web-control page list
web-control page new
web-control page close <page>
web-control page navigate <page> <url>
web-control page inspect <page> <summary|html|text|storage>
web-control page capture <page> <output-dir> [html|text|screenshot|mhtml]...
web-control page click <page> <target>
web-control page fill <page> <target> <value>
web-control page press <page> <target> <key>
web-control page scroll <page> <delta-y>
web-control debug cdp <page> <method> [params-json]
```

Page identifiers are opaque runtime identities. The current `target` representation is a Playwright locator/CSS-compatible selector used by this first provider; it is not promoted as the provider-independent selector contract.

`mhtml` and `debug cdp` are provider-specific extensions. The portable capture baseline remains rendered HTML, readable text and screenshot.

## Development lifecycle

The project is managed by `mk`. The current `mk` runtime itself requires the managed Node.js package default and executes the project lifecycle with that Node.js environment.

After JavaScript dependencies are present and a Chromium executable is available through `PATH` or `WEB_CONTROL_BROWSER_EXECUTABLE`:

```text
mk check
mk test
mk build
```

For direct non-`m` development:

```text
npm install
WEB_CONTROL_BROWSER_EXECUTABLE=/path/to/chromium npm test
npm run build
```

`mk build` emits the platform-independent artifact `dist/pwc-web-control-v<version>-all.tar.gz` (starting at v0.1.4). The artifact contains `node_modules` and therefore performs no `npm install` at runtime. Browser acquisition remains owned by the `chromium` package/facility.

## Renamed provider and existing state

The GitHub project and installable package are named `pwc-web-control`. The portable facility/command/service remain `web-control`. Releases v0.1.0 through v0.1.3 retain their original `rumiai-web-control-v<version>-all.tar.gz` asset names and payload layouts; they are not rebuilt or relabeled. The new archive naming begins at v0.1.4.

Installed `rumiai-web-control` and `pwc-web-control` are separate package identities with separate managed HOME/profile state. Installing the new provider does not automatically move cookies or authenticated sessions from the previous package. When running directly without `WEB_CONTROL_HOME`, the legacy standalone `~/.rumiai-web-control` profile fallback and derived socket prefix are intentionally retained so a source update does not discard or hide an existing user profile. Normal `m` package launch always provides its own managed HOME.

## Portable document scrolling

`web-control page scroll <page> <delta-y>` moves by a signed vertical CSS-pixel amount; zero observes without moving. It returns `page`, `scrollY`, `documentHeight`, `viewportHeight`, and `atBottom`. These are instantaneous document metrics, not a completeness guarantee for lazy-loaded sites. It is the same provider-independent operation implemented by Electron; no caller-facing CDP protocol or JavaScript-evaluation method is involved. `debug cdp` remains an optional provider-specific debugging extension, not an application dependency.
