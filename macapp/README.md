# Kong AI Switch — Mac menu bar app

A native SwiftUI menu bar app for switching Claude Code between Kong AI Gateway models. It drives the `kong-ai-switch` CLI rather than reimplementing the Kong logic, so there is one tested implementation of anything that talks to Konnect or writes your settings file.

## Build and run

```bash
./build-app.sh
open build/KongAISwitch.app
```

The app appears in the menu bar as a branch icon. It has no Dock icon, which is what `LSUIElement` in the bundle's Info.plist declares.

To quit, use Quit in the panel, or:

```bash
pkill -f KongAISwitch.app
```

## Testing on this machine

**`swift test` does not work here, and cannot be made to.** Both XCTest and swift-testing ship inside Xcode.app. This machine has the Command Line Tools only, so the test frameworks are unavailable:

```
error: unable to resolve module dependency: 'XCTest'
error: plugin for module 'TestingMacros' not found
```

Installing Xcode (~10GB) would fix it. Short of that, the checks live in a plain executable instead, which needs no Xcode and fails with a nonzero exit like any test runner:

```bash
swift run KongAISwitchChecks
```

That covers CLI discovery, decoding of every command's JSON, and error handling, using a stubbed command runner. 24 checks.

To exercise the real bridge — actual process launch, actual CLI, actual JSON — point it at your CLI checkout:

```bash
swift run KongAISwitchChecks --live /path/to/kong-ai-switch/src/cli/index.js
```

This is the check worth running after changing anything in `CLIClient.swift`, because it is the part that breaks in a shipped app.

## What is not covered automatically

SwiftUI rendering. XCUITest also lives in Xcode, so there is no way to drive the menu bar panel from a script here. The layer beneath it is covered, which means a rendering bug shows up as a visibly wrong panel rather than as wrong data.

To check the UI, open the app and confirm: the panel lists your environments with the active one marked, lists models for that environment, and that choosing one updates the header. `swift run KongAISwitchChecks --live ...` first will tell you whether the data underneath is sound, which separates a UI problem from a data problem.

## macOS folder protection

The app drives the `kong-ai-switch` CLI, and macOS will not let an unsigned app read `~/Documents`, `~/Desktop` or `~/Downloads`. A checkout in any of those works from your terminal but fails from the `.app` with `EPERM`.

`build-app.sh` bundles the CLI into `KongAISwitch.app/Contents/Resources/cli` (so zip downloads work without a manual install) and also mirrors it to `~/Library/Application Support/KongAISwitch/cli`. Re-run it after changing the CLI so both copies stay current.

To see which copy the app would use:

```bash
swift run KongAISwitchChecks --which
```

It exits nonzero and says so when the path is one macOS protects.

## How it finds the CLI

An app launched from Finder does not inherit your shell's PATH, so `node` is looked for explicitly in both Homebrew prefixes, `/usr/bin`, and the common version managers (nvm, Volta, asdf). The CLI script is looked for in Application Support, your workspace checkout, and the global npm roots.

If either is missing the app says so in the panel instead of failing silently. `CLIDiscovery.locate` takes injectable filesystem probes, which is how the discovery checks run without touching the real disk.

## Layout

| Path | What it is |
| --- | --- |
| `Sources/KongAISwitchCore/` | Models and the CLI bridge. No SwiftUI, so it stays testable. |
| `Sources/KongAISwitch/` | The menu bar app: `AppState` and `MenuView`. |
| `Sources/KongAISwitchChecks/` | The check runner that stands in for `swift test`. |
| `build-app.sh` | Assembles the `.app` bundle and ad-hoc signs it. |

## Requirements

- macOS 13 or newer
- Swift 5.9 or newer (Command Line Tools are enough)
- Node.js 20+ and the `kong-ai-switch` CLI
